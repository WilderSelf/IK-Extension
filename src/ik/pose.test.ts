import { describe, it, expect } from "vitest";
import type { Chain, Vec2 } from "../types";
import { defaultSettings } from "../types";
import { orderedNodes } from "../model/chains";
import { boneAngles, rigidTranslate, solvePose } from "./pose";
import { dist } from "./vec";

function straightChain(): { chain: Chain; positions: Record<string, Vec2> } {
  const chain: Chain = {
    id: "c1",
    rootId: "R",
    nodes: {
      R: { parentId: null, restLength: 0 },
      A: { parentId: "R", restLength: 10 },
      B: { parentId: "A", restLength: 10 },
      C: { parentId: "B", restLength: 10 },
    },
    settings: defaultSettings(),
  };
  const positions: Record<string, Vec2> = {
    R: { x: 0, y: 0 },
    A: { x: 10, y: 0 },
    B: { x: 20, y: 0 },
    C: { x: 30, y: 0 },
  };
  return { chain, positions };
}

describe("orderedNodes", () => {
  it("walks the strand root-first", () => {
    expect(orderedNodes(straightChain().chain)).toEqual(["R", "A", "B", "C"]);
  });
});

describe("rigidTranslate", () => {
  it("moves every node by the delta", () => {
    const { chain, positions } = straightChain();
    const { positions: out } = rigidTranslate(chain, positions, { x: 5, y: -3 });
    expect(out.R).toEqual({ x: 5, y: -3 });
    expect(out.C).toEqual({ x: 35, y: -3 });
  });
});

describe("solvePose", () => {
  it("keeps the root pinned and preserves rest lengths when a tip is grabbed", () => {
    const { chain, positions } = straightChain();
    const { positions: out } = solvePose(chain, positions, "C", { x: 12, y: 16 });
    expect(out.R).toEqual({ x: 0, y: 0 });
    expect(dist(out.R, out.A)).toBeCloseTo(10, 1);
    expect(dist(out.A, out.B)).toBeCloseTo(10, 1);
    expect(dist(out.B, out.C)).toBeCloseTo(10, 1);
  });

  it("carries the tail rigidly when a mid node is grabbed", () => {
    const { chain, positions } = straightChain();
    const target = { x: 15, y: 12 };
    const { positions: out } = solvePose(chain, positions, "B", target);
    expect(dist(out.B, target)).toBeLessThan(1);
    // C rides along; the B->C bone keeps its length.
    expect(dist(out.B, out.C)).toBeCloseTo(10, 5);
  });

  it("leaves the chain unchanged when the root is grabbed", () => {
    const { chain, positions } = straightChain();
    const { positions: out } = solvePose(chain, positions, "R", { x: 99, y: 99 });
    expect(out).toEqual(positions);
  });
});

describe("boneAngles", () => {
  it("is zero along a straight +x chain", () => {
    const { chain, positions } = straightChain();
    const rot = boneAngles(chain, positions);
    for (const id of ["R", "A", "B", "C"]) expect(rot[id]).toBeCloseTo(0, 6);
  });
});
