/**
 * NUMERIC stress: the core safety property is that FINITE inputs must NEVER
 * produce NaN/Infinity (that would be silently persisted to scene metadata).
 * NaN/Infinity INPUTS must at least not throw (applyPose/radToObrDeg guard the
 * OBR boundary). Also: extreme spans, tiny geometry, wildly unequal segments,
 * extreme stiffness/limit/anchor values, and huge rotations.
 */
import { describe, it, expect } from "vitest";
import type { Vec2 } from "../types";
import { solveChain, type SolveOptions } from "../ik/fabrik";
import {
  captureSegData,
  deriveMidpointJoints,
  reconstructJoints,
  seatTokens,
  solveSegmentJoints,
} from "../ik/segment";
import { dist } from "../ik/vec";
import { allFinite, boneLengths, finitePt, makeLine, rng } from "./helpers";
import { solvePose } from "../ik/pose";

// Mirror of obr/scene.ts radToObrDeg (SDK-free) so its guard is exercised here.
const radToObrDeg = (rad: number, offsetDeg = 90): number => {
  const safeRad = Number.isFinite(rad) ? rad : 0;
  const deg = (safeRad * 180) / Math.PI + offsetDeg;
  return ((deg % 360) + 360) % 360;
};

const finiteArr = (ps: Vec2[]) => ps.every(finitePt);

describe("FINITE inputs must never yield NaN/Infinity (randomised, extreme spans)", () => {
  const r = rng(0xF10A7E);
  it("solveChain over huge/tiny/mixed scales stays finite & length-true", () => {
    for (let c = 0; c < 800; c++) {
      const n = 2 + Math.floor(r() * 6);
      const scale = [1e-6, 1e-3, 1, 1e3, 1e6, 1e9][Math.floor(r() * 6)];
      const points: Vec2[] = [{ x: (r() - 0.5) * scale, y: (r() - 0.5) * scale }];
      const rest: number[] = [];
      let ang = r() * 6.283;
      for (let i = 1; i < n; i++) {
        const l = (0.001 + r()) * scale;
        ang += (r() - 0.5) * 2;
        points.push({ x: points[i - 1].x + Math.cos(ang) * l, y: points[i - 1].y + Math.sin(ang) * l });
        rest.push(l);
      }
      const target = { x: (r() - 0.5) * scale * 3, y: (r() - 0.5) * scale * 3 };
      const out = solveChain(points, rest, target);
      expect(finiteArr(out)).toBe(true);
      out.length > 1 && boneLengths(points.map((_, i) => String(i)), Object.fromEntries(out.map((p, i) => [String(i), p])))
        .forEach((l, i) => expect(l).toBeCloseTo(rest[i], Math.max(0, 6 - Math.round(Math.log10(scale)))));
    }
  });

  it("wildly unequal segment lengths in one chain stay finite & length-true", () => {
    const points: Vec2[] = [{ x: 0, y: 0 }];
    const rest = [1, 1e6, 0.01, 5e5, 2];
    let x = 0;
    for (const l of rest) { x += l; points.push({ x, y: 0 }); }
    const out = solveChain(points, rest, { x: 1e5, y: 3e5 });
    expect(finiteArr(out)).toBe(true);
    for (let i = 1; i < out.length; i++) expect(dist(out[i - 1], out[i])).toBeCloseTo(rest[i - 1], -2);
  });

  it("extreme (out-of-spec) stiffness values stay finite & length-true", () => {
    const { chain, positions } = makeLine(6, 10);
    const order = Object.keys(positions);
    for (const s of [50, -50, 1e3, -1e3, 2, -2]) {
      const out = solveChain(order.map((id) => positions[id]), [10, 10, 10, 10, 10], { x: 12, y: 20 }, {
        stiffness: [s, s, s, s, s],
      });
      expect(finiteArr(out)).toBe(true);
      for (let i = 1; i < out.length; i++) expect(dist(out[i - 1], out[i])).toBeCloseTo(10, 3);
    }
    void chain;
  });

  it("extreme bend & anchor limits stay finite", () => {
    const pts: Vec2[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }];
    const rest = [10, 10, 10];
    const cases: SolveOptions[] = [
      { limits: [null, null, { min: -1e15, max: 1e15 }, { min: -1e15, max: 1e15 }] }, // effectively free
      { limits: [null, null, { min: 0, max: 0 }, { min: 0, max: 0 }] },               // frozen straight
      { limits: [null, null, { min: 0.9, max: -0.9 }, { min: 0.5, max: -0.5 }] },     // inverted
      { anchorRef: 1e7, anchorLimit: { min: -0.2, max: 0.2 } },                        // huge ref angle
      { anchorRef: 0, anchorLimit: { min: -1e12, max: 1e12 } },                        // huge cone
    ];
    for (const opts of cases) {
      const out = solveChain(pts, rest, { x: -5, y: 25 }, opts);
      expect(finiteArr(out)).toBe(true);
      for (let i = 1; i < out.length; i++) expect(dist(out[i - 1], out[i])).toBeCloseTo(10, 3);
    }
  });

  it("sub-epsilon geometry (near-coincident) falls back without NaN", () => {
    const pts: Vec2[] = [{ x: 0, y: 0 }, { x: 1e-12, y: 0 }, { x: 2e-12, y: 0 }];
    const out = solveChain(pts, [1e-12, 1e-12], { x: 1e-11, y: 1e-11 });
    expect(finiteArr(out)).toBe(true);
  });

  it("segment reconstruction with extreme off-axis seat & huge rotations stays finite", () => {
    const centres: Vec2[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }];
    const joints = deriveMidpointJoints(centres);
    joints[1] = { x: 5, y: 1e6 }; // absurd off-axis pivot
    const seg = captureSegData(centres, [1e7, -1e7, 3e6], joints);
    const back = reconstructJoints(centres, [1e7, -1e7, 3e6], seg);
    expect(finiteArr(back)).toBe(true);
    expect(finiteArr(seatTokens(back, seg))).toBe(true);
    const solved = solveSegmentJoints(centres, [1e7, -1e7, 3e6], seg, 2, { x: 1e5, y: -1e5 });
    expect(finiteArr(solved)).toBe(true);
  });

  it("combined extreme solvePose (huge coords + tight limits) is finite & pinned", () => {
    const { chain, positions } = makeLine(5, 1e5);
    for (const id of Object.keys(positions)) { positions[id].x += 1e8; }
    chain.nodes["n2"].limit = { min: -0.01, max: 0.01 };
    chain.settings.defaultStiffness = "stiff";
    const order = Object.keys(positions);
    const { positions: out } = solvePose(chain, positions, "n4", { x: 1e8, y: 5e4 });
    expect(allFinite(out)).toBe(true);
    expect(out[order[0]]).toEqual(positions[order[0]]);
  });
});

describe("NaN / Infinity INPUTS do not throw (boundary guard is downstream)", () => {
  const base: Vec2[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }];
  it("NaN target", () => {
    expect(() => solveChain(base, [10, 10], { x: NaN, y: 0 })).not.toThrow();
  });
  it("Infinity target", () => {
    expect(() => solveChain(base, [10, 10], { x: Infinity, y: -Infinity })).not.toThrow();
  });
  it("NaN in a point", () => {
    expect(() => solveChain([{ x: NaN, y: 0 }, { x: 10, y: 0 }], [10], { x: 5, y: 5 })).not.toThrow();
  });
  it("NaN rest length", () => {
    expect(() => solveChain(base, [NaN, 10], { x: 5, y: 5 })).not.toThrow();
  });
  it("NaN stiffness / limit values don't throw", () => {
    expect(() => solveChain(base, [10, 10], { x: 5, y: 5 }, { stiffness: [NaN, NaN] })).not.toThrow();
    expect(() => solveChain(base, [10, 10], { x: 5, y: 5 }, { limits: [null, null, { min: NaN, max: NaN }] })).not.toThrow();
  });
});

describe("radToObrDeg guard normalises everything into [0,360)", () => {
  it("negative, >360, and non-finite all land in range", () => {
    const r = rng(9);
    for (let i = 0; i < 2000; i++) {
      const a = (r() - 0.5) * 100;
      const off = (r() - 0.5) * 720;
      const d = radToObrDeg(a, off);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(360);
    }
    expect(radToObrDeg(NaN, 30)).toBe(30);        // NaN rad -> treated as 0
    expect(radToObrDeg(Infinity, 0)).toBe(0);     // non-finite -> 0
    expect(radToObrDeg(0, -450)).toBeGreaterThanOrEqual(0);
  });
});
