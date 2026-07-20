/**
 * Miscellaneous adversarial pushes: a reactive-FOLLOW fuzzer (rigid carry of
 * bare-attached chains under random parent moves), pose determinism, zero-delta
 * translate, and solve-grabbing-the-root.
 */
import { describe, it, expect } from "vitest";
import type { ChainMap, Vec2 } from "../types";
import { buildChain, setParentNode } from "../model/chains";
import { followUpdates, type Transform } from "../ik/follow";
import { poseRig } from "../ik/pose";
import { rng } from "./helpers";

const d = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

describe("reactive-follow fuzzer — rigid carry under random parent moves", () => {
  const r = rng(0xF0110);
  it("carried tokens preserve distance-to-parent and intra-chain shape, stay finite", () => {
    for (let t = 0; t < 300; t++) {
      // Build a few arms, each following its own bare body token.
      let map: ChainMap = {};
      const last: Record<string, Transform> = {};
      const nArms = 1 + Math.floor(r() * 4);
      const bodies: string[] = [];
      const armTokens: string[][] = [];
      let k = 0;
      for (let a = 0; a < nArms; a++) {
        const len = 2 + Math.floor(r() * 3);
        const ids = Array.from({ length: len }, () => `a${a}_${k++}`);
        const pos: Record<string, Vec2> = {};
        let x = (r() - 0.5) * 100, y = (r() - 0.5) * 100;
        for (const id of ids) { pos[id] = { x, y }; x += 8 + r() * 10; y += (r() - 0.5) * 6; }
        const built = buildChain(map, ids, pos, Object.fromEntries(ids.map((id) => [id, 0])));
        if (!built) continue;
        map = built[0];
        const body = `body${a}`;
        bodies.push(body);
        armTokens.push(ids);
        map = setParentNode(map, built[1], body);
        last[body] = { pos: { x: (r() - 0.5) * 50, y: (r() - 0.5) * 50 }, rot: (r() - 0.5) * 360 };
        for (const id of ids) last[id] = { pos: pos[id], rot: 0 };
      }
      // Move a random subset of bodies (translate + rotate).
      const cur: Record<string, Transform> = JSON.parse(JSON.stringify(last));
      for (const body of bodies) {
        if (r() < 0.5) continue;
        cur[body] = { pos: { x: (r() - 0.5) * 400, y: (r() - 0.5) * 400 }, rot: (r() - 0.5) * 720 };
      }
      const up = followUpdates(map, last, cur);
      // Never writes a parent body.
      for (const body of bodies) expect(up[body]).toBeUndefined();
      // For each moved body, its arm rigidly follows: distances preserved, finite.
      for (let a = 0; a < bodies.length; a++) {
        const body = bodies[a];
        if (d(cur[body].pos, last[body].pos) < 1e-9 && Math.abs(cur[body].rot - last[body].rot) < 1e-9) continue;
        const ids = armTokens[a];
        for (const id of ids) {
          expect(Number.isFinite(up[id]?.pos.x) && Number.isFinite(up[id]?.pos.y)).toBe(true);
          // distance to the new parent position is preserved from rest.
          expect(d(up[id].pos, cur[body].pos)).toBeCloseTo(d(last[id].pos, last[body].pos), 4);
        }
        // intra-arm shape preserved.
        for (let i = 1; i < ids.length; i++) {
          expect(d(up[ids[i - 1]].pos, up[ids[i]].pos)).toBeCloseTo(d(last[ids[i - 1]].pos, last[ids[i]].pos), 4);
        }
      }
    }
  });
});

describe("pose determinism", () => {
  const r = rng(0xDE7);
  it("poseRig is deterministic — identical inputs give identical output", () => {
    for (let t = 0; t < 50; t++) {
      const len = 3 + Math.floor(r() * 4);
      const ids = Array.from({ length: len }, (_, i) => `z${i}`);
      const base: Record<string, Vec2> = {};
      let x = 0, y = 0, ang = r();
      for (const id of ids) { base[id] = { x, y }; ang += (r() - 0.5); x += 10; y += Math.sin(ang) * 3; }
      const map = buildChain({}, ids, base, Object.fromEntries(ids.map((id) => [id, 0])))![0];
      const cid = Object.keys(map)[0];
      const grab = { mode: "solve" as const, grabbedId: ids[len - 1], target: { x: (r() - 0.5) * 100, y: (r() - 0.5) * 100 } };
      const a = poseRig(map, cid, base, grab, undefined, Object.fromEntries(ids.map((id) => [id, 0])));
      const b = poseRig(map, cid, base, grab, undefined, Object.fromEntries(ids.map((id) => [id, 0])));
      expect(a.positions).toEqual(b.positions);
      expect(a.rotations).toEqual(b.rotations);
    }
  });
});

describe("degenerate pose grabs", () => {
  function arm() {
    const ids = ["A", "B", "C"];
    const base = { A: { x: 0, y: 0 }, B: { x: 10, y: 0 }, C: { x: 20, y: 0 } };
    const map = buildChain({}, ids, base, { A: 0, B: 0, C: 0 })![0];
    return { map, cid: Object.keys(map)[0], base };
  }

  it("zero-delta translate leaves everything exactly put", () => {
    const { map, cid, base } = arm();
    const { positions } = poseRig(map, cid, base, { mode: "translate", delta: { x: 0, y: 0 } });
    expect(positions.A).toEqual({ x: 0, y: 0 });
    expect(positions.C).toEqual({ x: 20, y: 0 });
  });

  it("solve while grabbing the ROOT is a safe no-op (caller uses translate)", () => {
    const { map, cid, base } = arm();
    const { positions } = poseRig(map, cid, base, { mode: "solve", grabbedId: "A", target: { x: 99, y: 99 } });
    expect(positions.A).toEqual({ x: 0, y: 0 });
    expect(positions.B).toEqual({ x: 10, y: 0 });
    expect(positions.C).toEqual({ x: 20, y: 0 });
  });

  it("solve toward the grabbed node's own rest position barely moves it", () => {
    const { map, cid, base } = arm();
    const { positions } = poseRig(map, cid, base, { mode: "solve", grabbedId: "C", target: { x: 20, y: 0 } });
    expect(positions.A).toEqual({ x: 0, y: 0 });
    expect(d(positions.C, { x: 20, y: 0 })).toBeLessThan(0.5);
    expect(d(positions.A, positions.B)).toBeCloseTo(10, 4);
  });
});
