import { describe, expect, it } from "vitest";
import type { Chain } from "../types";
import { defaultSettings } from "../types";
import { solveChain } from "./fabrik";
import { branchPath, orderedNodes, shallowestSelectedPerBranch, subtree } from "./tree";
import { rigidTranslate, solvePose } from "./pose";
import { dist } from "./vec";

const restLengthsOf = (pts: { x: number; y: number }[]) =>
  pts.slice(1).map((p, i) => dist(pts[i], p));

describe("solveChain (FABRIK)", () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
    { x: 30, y: 0 },
  ];
  const rest = restLengthsOf(pts);

  it("keeps the root pinned", () => {
    const out = solveChain(pts, rest, { x: 10, y: 20 });
    expect(out[0].x).toBeCloseTo(0, 5);
    expect(out[0].y).toBeCloseTo(0, 5);
  });

  it("preserves rest lengths within tolerance", () => {
    const out = solveChain(pts, rest, { x: 5, y: 18 });
    for (let i = 1; i < out.length; i++) {
      expect(dist(out[i - 1], out[i])).toBeCloseTo(rest[i - 1], 3);
    }
  });

  it("reaches a reachable target", () => {
    const target = { x: 10, y: 15 };
    const out = solveChain(pts, rest, target, { iterations: 30, tolerance: 0.01 });
    expect(dist(out[out.length - 1], target)).toBeLessThan(0.1);
  });

  it("points straight at an unreachable target", () => {
    const target = { x: 100, y: 0 };
    const out = solveChain(pts, rest, target);
    // Straight line along +x at cumulative rest lengths.
    expect(out[3].x).toBeCloseTo(30, 5);
    expect(out[3].y).toBeCloseTo(0, 5);
    for (let i = 1; i < out.length; i++) {
      expect(dist(out[i - 1], out[i])).toBeCloseTo(rest[i - 1], 5);
    }
  });

  it("does not mutate the input points", () => {
    const copy = pts.map((p) => ({ ...p }));
    solveChain(pts, rest, { x: 5, y: 5 });
    expect(pts).toEqual(copy);
  });
});

// body -> a1 -> a2 (branch A), body -> b1 (branch B)
function makeChain(): Chain {
  return {
    id: "c1",
    rootId: "body",
    nodes: {
      body: { parentId: null, restLength: 0 },
      a1: { parentId: "body", restLength: 10 },
      a2: { parentId: "a1", restLength: 10 },
      b1: { parentId: "body", restLength: 10 },
    },
    settings: defaultSettings(),
  };
}

describe("tree utils", () => {
  const chain = makeChain();

  it("branchPath returns root..node", () => {
    expect(branchPath(chain, "a2")).toEqual(["body", "a1", "a2"]);
    expect(branchPath(chain, "b1")).toEqual(["body", "b1"]);
  });

  it("subtree returns descendants only", () => {
    expect(subtree(chain, "a1").sort()).toEqual(["a2"]);
    expect(subtree(chain, "body").sort()).toEqual(["a1", "a2", "b1"]);
  });

  it("shallowestSelectedPerBranch drops deeper selected nodes and the root", () => {
    expect(shallowestSelectedPerBranch(chain, ["a1", "a2"]).sort()).toEqual(["a1"]);
    expect(shallowestSelectedPerBranch(chain, ["a2", "b1"]).sort()).toEqual(["a2", "b1"]);
    expect(shallowestSelectedPerBranch(chain, ["body", "a2"])).toEqual(["a2"]);
  });

  it("orderedNodes lists the tree depth-first with depths", () => {
    const ordered = orderedNodes(chain);
    expect(ordered[0]).toEqual({ id: "body", depth: 0 });
    const depthById = Object.fromEntries(ordered.map((n) => [n.id, n.depth]));
    expect(depthById).toEqual({ body: 0, a1: 1, a2: 2, b1: 1 });
  });
});

describe("pose", () => {
  const chain = makeChain();
  const positions = {
    body: { x: 0, y: 0 },
    a1: { x: 10, y: 0 },
    a2: { x: 20, y: 0 },
    b1: { x: 0, y: 10 },
  };

  it("rigidTranslate moves every node by the same delta", () => {
    const { positions: p } = rigidTranslate(chain, positions, { x: 5, y: -3 });
    expect(p.body).toEqual({ x: 5, y: -3 });
    expect(p.a2).toEqual({ x: 25, y: -3 });
    expect(p.b1).toEqual({ x: 5, y: 7 });
  });

  it("solvePose keeps the root pinned and moves the grabbed branch", () => {
    const { positions: p } = solvePose(chain, positions, { a2: { x: 10, y: 15 } });
    expect(p.body.x).toBeCloseTo(0, 5);
    expect(p.body.y).toBeCloseTo(0, 5);
    // rest lengths on branch A preserved
    expect(dist(p.body, p.a1)).toBeCloseTo(10, 2);
    expect(dist(p.a1, p.a2)).toBeCloseTo(10, 2);
  });

  it("solvePose leaves sibling branches untouched", () => {
    const { positions: p } = solvePose(chain, positions, { a2: { x: 5, y: 12 } });
    expect(p.b1).toEqual(positions.b1);
  });

  it("group carry preserves the grabbed node's sub-tree offsets rigidly", () => {
    // Grab a1; a2 (its child) must ride along, keeping |a1-a2| == 10.
    const { positions: p } = solvePose(chain, positions, { a1: { x: 0, y: 10 } });
    expect(dist(p.a1, p.a2)).toBeCloseTo(10, 5);
  });

  it("solves two independent branches simultaneously (multi-target group move)", () => {
    const { positions: p } = solvePose(chain, positions, {
      a2: { x: 8, y: 14 },
      b1: { x: -6, y: 6 },
    });
    // Root pinned, both branches keep their rest lengths.
    expect(p.body.x).toBeCloseTo(0, 5);
    expect(p.body.y).toBeCloseTo(0, 5);
    expect(dist(p.body, p.a1)).toBeCloseTo(10, 2);
    expect(dist(p.a1, p.a2)).toBeCloseTo(10, 2);
    expect(dist(p.body, p.b1)).toBeCloseTo(10, 2);
  });
});
