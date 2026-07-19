import { describe, it, expect } from "vitest";
import type { Vec2 } from "../types";
import { solveChain } from "./fabrik";
import { dist } from "./vec";

const pts = (...xy: [number, number][]): Vec2[] => xy.map(([x, y]) => ({ x, y }));

function restOf(points: Vec2[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < points.length; i++) r.push(dist(points[i - 1], points[i]));
  return r;
}

describe("solveChain (FABRIK)", () => {
  it("returns the root unchanged for a single point", () => {
    expect(solveChain(pts([5, 7]), [], { x: 100, y: 100 })).toEqual([{ x: 5, y: 7 }]);
  });

  it("keeps the root pinned", () => {
    const points = pts([0, 0], [10, 0], [20, 0], [30, 0]);
    const out = solveChain(points, [10, 10, 10], { x: 15, y: 15 });
    expect(out[0]).toEqual({ x: 0, y: 0 });
  });

  it("preserves rest lengths for a reachable target", () => {
    const points = pts([0, 0], [10, 0], [20, 0], [30, 0]);
    const rest = [10, 10, 10];
    const out = solveChain(points, rest, { x: 12, y: 14 });
    restOf(out).forEach((l, i) => expect(l).toBeCloseTo(rest[i], 1));
  });

  it("reaches a reachable target within tolerance", () => {
    const points = pts([0, 0], [10, 0], [20, 0], [30, 0]);
    const target = { x: 12, y: 14 };
    const out = solveChain(points, [10, 10, 10], target);
    expect(dist(out[out.length - 1], target)).toBeLessThan(1);
  });

  it("straightens toward an unreachable target, preserving rest lengths", () => {
    const points = pts([0, 0], [10, 0], [20, 0], [30, 0]);
    const rest = [10, 10, 10];
    const out = solveChain(points, rest, { x: 300, y: 0 });
    expect(out[3].x).toBeCloseTo(30, 5);
    expect(out[3].y).toBeCloseTo(0, 5);
    restOf(out).forEach((l, i) => expect(l).toBeCloseTo(rest[i], 5));
  });

  it("leaves a zero-length chain unchanged (coincident tokens)", () => {
    const points = pts([5, 5], [5, 5], [5, 5]);
    const out = solveChain(points, [0, 0], { x: 100, y: 100 });
    expect(out).toEqual(points);
  });

  it("does not mutate its inputs", () => {
    const points = pts([0, 0], [10, 0], [20, 0]);
    const snapshot = JSON.stringify(points);
    solveChain(points, [10, 10], { x: 5, y: 9 });
    expect(JSON.stringify(points)).toEqual(snapshot);
  });
});

describe("solveChain — stiffness", () => {
  const line = () => pts([0, 0], [10, 0], [20, 0], [30, 0]);
  const rest = [10, 10, 10];

  it("all-zero stiffness is identical to the unweighted solve", () => {
    const target = { x: 10, y: 20 };
    const plain = solveChain(line(), rest, target);
    const weighted = solveChain(line(), rest, target, { stiffness: [0, 0, 0] });
    expect(weighted).toEqual(plain);
  });

  it("a stiff first bone keeps its node nearer its start than a loose one", () => {
    const target = { x: 10, y: 20 };
    const stiff = solveChain(line(), rest, target, { stiffness: [0.7, 0, 0] });
    const loose = solveChain(line(), rest, target, { stiffness: [-0.4, 0, 0] });
    const start = { x: 10, y: 0 };
    expect(dist(stiff[1], start)).toBeLessThan(dist(loose[1], start));
  });

  it("preserves rest lengths under stiffness", () => {
    const out = solveChain(line(), rest, { x: 8, y: 16 }, { stiffness: [0.7, -0.4, 0.7] });
    restOf(out).forEach((l, i) => expect(l).toBeCloseTo(rest[i], 4));
  });

  it("keeps the root pinned and stays finite under stiffness", () => {
    const out = solveChain(line(), rest, { x: 5, y: 12 }, { stiffness: [0.7, 0.7, 0.7] });
    expect(out[0]).toEqual({ x: 0, y: 0 });
    out.forEach((pt) => {
      expect(Number.isFinite(pt.x)).toBe(true);
      expect(Number.isFinite(pt.y)).toBe(true);
    });
  });

  it("still respects stiffness when the target is out of reach", () => {
    // Far target would normally straighten in one shot; with stiffness the
    // iterative path runs instead, so lengths must still hold.
    const out = solveChain(line(), rest, { x: 500, y: 0 }, { stiffness: [0.7, 0, 0] });
    restOf(out).forEach((l, i) => expect(l).toBeCloseTo(rest[i], 4));
  });
});

describe("solveChain — bend limits", () => {
  const line = () => pts([0, 0], [10, 0], [20, 0], [30, 0]);
  const rest = [10, 10, 10];
  // Signed bend at point i: angle(bone i-1→i) minus angle(bone i-2→i-1).
  const relBendAt = (out: Vec2[], i: number) => {
    const inA = Math.atan2(out[i - 1].y - out[i - 2].y, out[i - 1].x - out[i - 2].x);
    const outA = Math.atan2(out[i].y - out[i - 1].y, out[i].x - out[i - 1].x);
    return Math.atan2(Math.sin(outA - inA), Math.cos(outA - inA));
  };

  it("all-null limits is identical to the unweighted solve", () => {
    const target = { x: 5, y: 18 };
    const plain = solveChain(line(), rest, target);
    const limited = solveChain(line(), rest, target, { limits: [null, null, null, null] });
    expect(limited).toEqual(plain);
  });

  it("clamps a joint's bend to its captured range", () => {
    // Target off to the side would bend point 2 well past 0.2 rad if left free.
    const out = solveChain(line(), rest, { x: 0, y: 20 }, {
      limits: [null, null, { min: -0.2, max: 0.2 }, null],
    });
    expect(Math.abs(relBendAt(out, 2))).toBeLessThanOrEqual(0.2 + 1e-3);
  });

  it("preserves rest lengths under limits", () => {
    const out = solveChain(line(), rest, { x: 6, y: 15 }, {
      limits: [null, null, { min: -0.3, max: 0.3 }, { min: -0.3, max: 0.3 }],
    });
    restOf(out).forEach((l, i) => expect(l).toBeCloseTo(rest[i], 4));
  });

  it("composes with stiffness — both applied, lengths hold", () => {
    const out = solveChain(line(), rest, { x: 4, y: 16 }, {
      stiffness: [0.5, 0.5, 0.5],
      limits: [null, null, { min: -0.25, max: 0.25 }, null],
    });
    restOf(out).forEach((l, i) => expect(l).toBeCloseTo(rest[i], 4));
    expect(Math.abs(relBendAt(out, 2))).toBeLessThanOrEqual(0.25 + 1e-3);
  });
});

describe("solveChain — anchor limit (root vs external reference)", () => {
  const line = () => pts([0, 0], [10, 0], [20, 0], [30, 0]);
  const rest = [10, 10, 10];
  // The root's own bone direction (bone 0→1), signed.
  const rootDir = (out: Vec2[]) => Math.atan2(out[1].y - out[0].y, out[1].x - out[0].x);

  it("clamps the ROOT's swing relative to anchorRef", () => {
    // Reaching straight up would swing the root ~90° off +x; a ±0.2 rad anchor
    // cone about anchorRef=0 must hold it near +x instead.
    const out = solveChain(line(), rest, { x: 0, y: 20 }, {
      anchorRef: 0,
      anchorLimit: { min: -0.2, max: 0.2 },
    });
    expect(Math.abs(rootDir(out))).toBeLessThanOrEqual(0.2 + 1e-3);
  });

  it("tracks the reference angle — the cone rotates with the parent", () => {
    // Same target, but the parent is turned to π/2: the allowed cone rotates with
    // it, so the root now sits near π/2 rather than near 0.
    const out = solveChain(line(), rest, { x: 0, y: 20 }, {
      anchorRef: Math.PI / 2,
      anchorLimit: { min: -0.2, max: 0.2 },
    });
    const rel = Math.atan2(Math.sin(rootDir(out) - Math.PI / 2), Math.cos(rootDir(out) - Math.PI / 2));
    expect(Math.abs(rel)).toBeLessThanOrEqual(0.2 + 1e-3);
  });

  it("no-ops without a reference (limit alone does nothing at the root)", () => {
    const plain = solveChain(line(), rest, { x: 0, y: 20 });
    const out = solveChain(line(), rest, { x: 0, y: 20 }, { anchorLimit: { min: -0.2, max: 0.2 } });
    expect(out).toEqual(plain); // anchorRef undefined ⇒ untouched fast path
  });

  it("preserves rest lengths under an anchor clamp", () => {
    const out = solveChain(line(), rest, { x: 3, y: 18 }, { anchorRef: 0, anchorLimit: { min: -0.3, max: 0.3 } });
    restOf(out).forEach((l, i) => expect(l).toBeCloseTo(rest[i], 4));
  });
});
