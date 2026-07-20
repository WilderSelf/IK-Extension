/**
 * FABRIK solver INVARIANTS — randomised property tests over the guarantees the
 * solver must uphold for every input: the root stays pinned, rest lengths are
 * preserved, outputs are finite, inputs aren't mutated, results are
 * deterministic, and every constraint (bend limit / anchor cone) is respected in
 * the returned pose. Plus targeted edge cases the fixed-example suite doesn't hit.
 */
import { describe, it, expect } from "vitest";
import type { BendLimit, Vec2 } from "../types";
import { solveChain, type SolveOptions } from "./fabrik";
import { dist } from "./vec";

// Deterministic PRNG (mulberry32) so a failure reproduces exactly.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const restOf = (p: Vec2[]) => p.slice(1).map((_, i) => dist(p[i], p[i + 1]));
const finite = (p: Vec2[]) => p.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y));
const relBendAt = (out: Vec2[], i: number) => {
  const inA = Math.atan2(out[i - 1].y - out[i - 2].y, out[i - 1].x - out[i - 2].x);
  const outA = Math.atan2(out[i].y - out[i - 1].y, out[i].x - out[i - 1].x);
  return Math.atan2(Math.sin(outA - inA), Math.cos(outA - inA));
};

// Build a random chain: n points, each bone a random length in [5,40].
function randomChain(r: () => number, n: number): { points: Vec2[]; rest: number[] } {
  const points: Vec2[] = [{ x: (r() - 0.5) * 200, y: (r() - 0.5) * 200 }];
  const rest: number[] = [];
  let ang = r() * Math.PI * 2;
  for (let i = 1; i < n; i++) {
    const l = 5 + r() * 35;
    ang += (r() - 0.5) * 2;
    points.push({ x: points[i - 1].x + Math.cos(ang) * l, y: points[i - 1].y + Math.sin(ang) * l });
    rest.push(l);
  }
  return { points, rest };
}

describe("FABRIK invariants (randomised)", () => {
  const r = rng(0xC0FFEE);
  const CASES = 400;

  it("root stays pinned, lengths preserved, finite, no mutation — plain solve", () => {
    for (let c = 0; c < CASES; c++) {
      const n = 2 + Math.floor(r() * 6); // 2..7 points
      const { points, rest } = randomChain(r, n);
      const target = { x: (r() - 0.5) * 400, y: (r() - 0.5) * 400 };
      const snap = JSON.stringify(points);
      const out = solveChain(points, rest, target);
      expect(out[0]).toEqual(points[0]); // pinned
      restOf(out).forEach((l, i) => expect(l).toBeCloseTo(rest[i], 5)); // preserved
      expect(finite(out)).toBe(true);
      expect(JSON.stringify(points)).toBe(snap); // not mutated
      expect(out.length).toBe(n);
    }
  });

  it("holds under random stiffness (incl. negative/loose)", () => {
    for (let c = 0; c < CASES; c++) {
      const n = 3 + Math.floor(r() * 5);
      const { points, rest } = randomChain(r, n);
      const stiffness = rest.map(() => (r() - 0.35) * 1.2); // ~[-0.42, 0.78]
      const target = { x: (r() - 0.5) * 500, y: (r() - 0.5) * 500 };
      const out = solveChain(points, rest, target, { stiffness });
      expect(out[0]).toEqual(points[0]);
      restOf(out).forEach((l, i) => expect(l).toBeCloseTo(rest[i], 4));
      expect(finite(out)).toBe(true);
    }
  });

  it("respects every bend limit it is given (returned pose is within the cone)", () => {
    for (let c = 0; c < CASES; c++) {
      const n = 3 + Math.floor(r() * 5);
      const { points, rest } = randomChain(r, n);
      // A symmetric cap at each limitable joint (i>=2); vary the width.
      const limits: (BendLimit | null)[] = points.map((_, i) => {
        if (i < 2) return null;
        const w = 0.05 + r() * 1.0;
        return { min: -w, max: w };
      });
      const target = { x: (r() - 0.5) * 600, y: (r() - 0.5) * 600 };
      const out = solveChain(points, rest, target, { limits });
      for (let i = 2; i < n; i++) {
        const lim = limits[i]!;
        expect(relBendAt(out, i)).toBeGreaterThanOrEqual(lim.min - 1e-6);
        expect(relBendAt(out, i)).toBeLessThanOrEqual(lim.max + 1e-6);
      }
      restOf(out).forEach((l, i) => expect(l).toBeCloseTo(rest[i], 4));
      expect(finite(out)).toBe(true);
    }
  });

  it("respects an inverted bend range (min>max) by clamping to the real interval", () => {
    for (let c = 0; c < 120; c++) {
      const n = 4;
      const { points, rest } = randomChain(r, n);
      const w = 0.1 + r() * 0.6;
      // Intentionally inverted bounds; the solver must order them.
      const limits = [null, null, { min: w, max: -w }, { min: w, max: -w }];
      const out = solveChain(points, rest, { x: (r() - 0.5) * 500, y: (r() - 0.5) * 500 }, { limits });
      for (let i = 2; i < n; i++) {
        expect(Math.abs(relBendAt(out, i))).toBeLessThanOrEqual(w + 1e-6);
      }
    }
  });

  it("respects the anchor cone about a random reference angle", () => {
    for (let c = 0; c < CASES; c++) {
      const n = 3 + Math.floor(r() * 4);
      const { points, rest } = randomChain(r, n);
      const anchorRef = (r() - 0.5) * Math.PI * 2;
      const w = 0.05 + r() * 0.8;
      const out = solveChain(points, rest, { x: (r() - 0.5) * 600, y: (r() - 0.5) * 600 }, {
        anchorRef,
        anchorLimit: { min: -w, max: w },
      });
      const rootDir = Math.atan2(out[1].y - out[0].y, out[1].x - out[0].x);
      const rel = Math.atan2(Math.sin(rootDir - anchorRef), Math.cos(rootDir - anchorRef));
      expect(Math.abs(rel)).toBeLessThanOrEqual(w + 1e-6);
      restOf(out).forEach((l, i) => expect(l).toBeCloseTo(rest[i], 4));
    }
  });

  it("stiffness + limits + anchor together: all constraints hold at once", () => {
    for (let c = 0; c < 200; c++) {
      const n = 4 + Math.floor(r() * 3);
      const { points, rest } = randomChain(r, n);
      const opts: SolveOptions = {
        stiffness: rest.map(() => (r() - 0.3) * 0.9),
        limits: points.map((_, i) => (i >= 2 ? { min: -(0.2 + r() * 0.6), max: 0.2 + r() * 0.6 } : null)),
        anchorRef: (r() - 0.5) * 6,
        anchorLimit: { min: -(0.1 + r() * 0.5), max: 0.1 + r() * 0.5 },
      };
      const out = solveChain(points, rest, { x: (r() - 0.5) * 500, y: (r() - 0.5) * 500 }, opts);
      expect(out[0]).toEqual(points[0]);
      restOf(out).forEach((l, i) => expect(l).toBeCloseTo(rest[i], 4));
      expect(finite(out)).toBe(true);
      // Anchor cone — real [min,max] interval (may be asymmetric).
      const rootDir = Math.atan2(out[1].y - out[0].y, out[1].x - out[0].x);
      const rel = Math.atan2(Math.sin(rootDir - opts.anchorRef!), Math.cos(rootDir - opts.anchorRef!));
      expect(rel).toBeGreaterThanOrEqual(opts.anchorLimit!.min - 1e-6);
      expect(rel).toBeLessThanOrEqual(opts.anchorLimit!.max + 1e-6);
      // Bend cones — check the real [min,max] interval (may be asymmetric).
      for (let i = 2; i < n; i++) {
        const b = relBendAt(out, i);
        expect(b).toBeGreaterThanOrEqual(opts.limits![i]!.min - 1e-6);
        expect(b).toBeLessThanOrEqual(opts.limits![i]!.max + 1e-6);
      }
    }
  });

  it("is deterministic — identical inputs give byte-identical output", () => {
    for (let c = 0; c < 50; c++) {
      const n = 2 + Math.floor(r() * 6);
      const { points, rest } = randomChain(r, n);
      const target = { x: (r() - 0.5) * 400, y: (r() - 0.5) * 400 };
      const opts = { stiffness: rest.map(() => (r() - 0.3) * 0.8) };
      const a = solveChain(points, rest, target, opts);
      const b = solveChain(points, rest, target, opts);
      expect(a).toEqual(b);
    }
  });
});

describe("FABRIK edge cases", () => {
  it("returns [] for an empty chain", () => {
    expect(solveChain([], [], { x: 1, y: 1 })).toEqual([]);
  });

  it("two coincident points with zero rest are left put", () => {
    expect(solveChain([{ x: 4, y: 4 }, { x: 4, y: 4 }], [0], { x: 9, y: 9 })).toEqual([
      { x: 4, y: 4 }, { x: 4, y: 4 },
    ]);
  });

  it("target exactly at reach distance straightens cleanly", () => {
    const out = solveChain([{ x: 0, y: 0 }, { x: 10, y: 0 }], [10], { x: 10, y: 0 });
    expect(out[1].x).toBeCloseTo(10, 6);
    expect(out[1].y).toBeCloseTo(0, 6);
  });

  it("a limit at index 0/1 is ignored (no reference bone) but stays finite", () => {
    const p = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }];
    const out = solveChain(p, [10, 10], { x: 5, y: 12 }, {
      limits: [{ min: -0.1, max: 0.1 }, { min: -0.1, max: 0.1 }, null],
    });
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y))).toBe(true);
  });

  it("a fully-zero-width bend limit freezes the joint straight", () => {
    const p = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }];
    const out = solveChain(p, [10, 10, 10], { x: 0, y: 25 }, { limits: [null, null, { min: 0, max: 0 }, null] });
    expect(Math.abs(relBendAt(out, 2))).toBeLessThanOrEqual(1e-6);
  });
});
