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
