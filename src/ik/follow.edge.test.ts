/**
 * Reactive-follow (ik/follow) EDGE CASES: combined translate+rotate about the
 * parent's NEW position, multiple followers, per-chain independence, threshold
 * behaviour, and rigid-shape preservation.
 */
import { describe, it, expect } from "vitest";
import type { ChainMap, Vec2 } from "../types";
import { buildChain, setParentNode } from "../model/chains";
import { followUpdates, type Transform } from "./follow";
import { dist } from "./vec";

const pos = (o: Record<string, [number, number]>): Record<string, Vec2> =>
  Object.fromEntries(Object.entries(o).map(([k, [x, y]]) => [k, { x, y }]));
const rot0 = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, 0]));
const idOf = (m: ChainMap, root: string) => Object.values(m).find((c) => c.rootId === root)!.id;
const tf = (o: Record<string, { p: [number, number]; r: number }>): Record<string, Transform> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { pos: { x: v.p[0], y: v.p[1] }, rot: v.r }]));

function armOnBody(): { chains: ChainMap; base: Record<string, Transform> } {
  let chains = buildChain({}, ["A0", "A1"], pos({ A0: [10, 0], A1: [20, 0] }), rot0(["A0", "A1"]))![0];
  const aId = idOf(chains, "A0");
  chains = setParentNode(chains, aId, "BODY");
  const base = tf({ BODY: { p: [0, 0], r: 0 }, A0: { p: [10, 0], r: 0 }, A1: { p: [20, 0], r: 0 } });
  return { chains, base };
}

describe("followUpdates — combined translate + rotate", () => {
  it("applies rotation about the parent's NEW position (translate then spin)", () => {
    const { chains, base } = armOnBody();
    // Parent moves to (5,5) AND turns +90°.
    const cur = tf({ BODY: { p: [5, 5], r: 90 }, A0: { p: [10, 0], r: 0 }, A1: { p: [20, 0], r: 0 } });
    const up = followUpdates(chains, base, cur);
    // Expected: newX = R90·(oldX − BODY_old) + BODY_new.
    // A0 (10,0)−(0,0)=(10,0) → R90 → (0,10) → +(5,5) = (5,15).
    expect(up.A0.pos.x).toBeCloseTo(5, 6);
    expect(up.A0.pos.y).toBeCloseTo(15, 6);
    // A1 (20,0) → (0,20) → (5,25).
    expect(up.A1.pos.x).toBeCloseTo(5, 6);
    expect(up.A1.pos.y).toBeCloseTo(25, 6);
    expect(up.A0.rot).toBe(90);
    expect(up.A1.rot).toBe(90);
  });

  it("preserves the rigid shape (inter-token distance + distance to parent)", () => {
    const { chains, base } = armOnBody();
    const cur = tf({ BODY: { p: [-30, 12], r: 217 }, A0: { p: [10, 0], r: 0 }, A1: { p: [20, 0], r: 0 } });
    const up = followUpdates(chains, base, cur);
    // A0–A1 distance unchanged.
    expect(dist(up.A0.pos, up.A1.pos)).toBeCloseTo(dist(base.A0.pos, base.A1.pos), 6);
    // Distance from each token to the parent's centre is preserved by a rigid move.
    expect(dist(up.A0.pos, cur.BODY.pos)).toBeCloseTo(dist(base.A0.pos, base.BODY.pos), 6);
    expect(dist(up.A1.pos, cur.BODY.pos)).toBeCloseTo(dist(base.A1.pos, base.BODY.pos), 6);
  });
});

describe("followUpdates — multiple followers & independence", () => {
  it("carries two chains attached to the same bare parent", () => {
    let chains = buildChain({}, ["A0", "A1"], pos({ A0: [10, 0], A1: [20, 0] }), rot0(["A0", "A1"]))![0];
    chains = buildChain(chains, ["B0", "B1"], pos({ B0: [10, 5], B1: [20, 5] }), rot0(["B0", "B1"]))![0];
    chains = setParentNode(chains, idOf(chains, "A0"), "BODY");
    chains = setParentNode(chains, idOf(chains, "B0"), "BODY");
    const base = tf({
      BODY: { p: [0, 0], r: 0 }, A0: { p: [10, 0], r: 0 }, A1: { p: [20, 0], r: 0 },
      B0: { p: [10, 5], r: 0 }, B1: { p: [20, 5], r: 0 },
    });
    const cur = { ...base, BODY: { pos: { x: 3, y: -4 }, rot: 0 } };
    const up = followUpdates(chains, base, cur);
    expect(up.A0.pos).toEqual({ x: 13, y: -4 });
    expect(up.B1.pos).toEqual({ x: 23, y: 1 });
    expect(Object.keys(up).sort()).toEqual(["A0", "A1", "B0", "B1"]);
  });

  it("only carries the chain whose parent actually moved", () => {
    let chains = buildChain({}, ["A0", "A1"], pos({ A0: [10, 0], A1: [20, 0] }), rot0(["A0", "A1"]))![0];
    chains = buildChain(chains, ["B0", "B1"], pos({ B0: [10, 5], B1: [20, 5] }), rot0(["B0", "B1"]))![0];
    chains = setParentNode(chains, idOf(chains, "A0"), "BODYA");
    chains = setParentNode(chains, idOf(chains, "B0"), "BODYB");
    const base = tf({
      BODYA: { p: [0, 0], r: 0 }, BODYB: { p: [0, 5], r: 0 },
      A0: { p: [10, 0], r: 0 }, A1: { p: [20, 0], r: 0 }, B0: { p: [10, 5], r: 0 }, B1: { p: [20, 5], r: 0 },
    });
    // Only BODYA moved.
    const cur = { ...base, BODYA: { pos: { x: 100, y: 0 }, rot: 0 } };
    const up = followUpdates(chains, base, cur);
    expect(Object.keys(up).sort()).toEqual(["A0", "A1"]);
  });
});

describe("followUpdates — thresholds & missing data", () => {
  it("rotation past ROT_EPS alone triggers a carry (position steady)", () => {
    const { chains, base } = armOnBody();
    const cur = tf({ BODY: { p: [0, 0], r: 0.5 }, A0: { p: [10, 0], r: 0 }, A1: { p: [20, 0], r: 0 } });
    const up = followUpdates(chains, base, cur);
    expect(Object.keys(up).sort()).toEqual(["A0", "A1"]);
  });

  it("wraps the shortest way around ±180° (359°→1° reads as a small +2° turn)", () => {
    const { chains } = armOnBody();
    const last = tf({ BODY: { p: [0, 0], r: 359 }, A0: { p: [10, 0], r: 0 }, A1: { p: [20, 0], r: 0 } });
    const cur = tf({ BODY: { p: [0, 0], r: 1 }, A0: { p: [10, 0], r: 0 }, A1: { p: [20, 0], r: 0 } });
    const up = followUpdates(chains, last, cur);
    // dRot is the raw (cur−last) = 1−359 = −358°, applied as-is to token rotation,
    // but the POSITION carry rotates by that same angle about the pivot — a −358°
    // rotation equals +2°, so A0 (10,0) lands near a +2° arc, not a −358° swing.
    const twoDeg = 2 * Math.PI / 180;
    expect(up.A0.pos.x).toBeCloseTo(10 * Math.cos(twoDeg), 3);
    expect(up.A0.pos.y).toBeCloseTo(10 * Math.sin(twoDeg), 3);
  });

  it("does nothing when the parent transform is missing from `last` (first sighting)", () => {
    const { chains, base } = armOnBody();
    const last = { ...base };
    delete (last as Record<string, unknown>).BODY;
    const cur = tf({ BODY: { p: [9, 9], r: 0 }, A0: { p: [10, 0], r: 0 }, A1: { p: [20, 0], r: 0 } });
    expect(followUpdates(chains, last, cur)).toEqual({});
  });

  it("carries the tokens it can even if one chain token has no known transform", () => {
    const { chains, base } = armOnBody();
    const last = { ...base };
    delete (last as Record<string, unknown>).A1; // A1 unknown in last…
    const cur = tf({ BODY: { p: [5, 0], r: 0 }, A0: { p: [10, 0], r: 0 } }); // …and in cur
    const up = followUpdates(chains, last, cur);
    expect(up.A0.pos).toEqual({ x: 15, y: 0 });
    expect(up.A1).toBeUndefined(); // no base for A1 -> skipped, no NaN
  });
});
