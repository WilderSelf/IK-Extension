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

  it("leaves a zero-length chain (all-zero rest) untouched", () => {
    const coincident = [
      { x: 5, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 5 },
    ];
    const out = solveChain(coincident, [0, 0], { x: 100, y: 100 });
    expect(out).toEqual(coincident); // no collapse-to-root / NaN
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

  it("handles large chains without O(n^2) blow-up or stack overflow", () => {
    // A 2000-node linear chain: the old recursive/childrenOf-per-node code would
    // both blow the stack and take quadratic time. This must stay fast and flat.
    const n = 2000;
    const nodes: Chain["nodes"] = { root: { parentId: null, restLength: 0 } };
    let prev = "root";
    for (let i = 1; i < n; i++) {
      nodes[`n${i}`] = { parentId: prev, restLength: 10 };
      prev = `n${i}`;
    }
    const deep: Chain = { id: "deep", rootId: "root", nodes, settings: defaultSettings() };
    expect(orderedNodes(deep)).toHaveLength(n);
    expect(subtree(deep, "root")).toHaveLength(n - 1);
    expect(orderedNodes(deep)[n - 1]).toEqual({ id: `n${n - 1}`, depth: n - 1 });
  });

  it("does not loop forever on cyclic (corrupted) metadata", () => {
    // parentId chain a -> c -> b -> a is a cycle. Both traversals must terminate.
    const cyclic: Chain = {
      id: "x",
      rootId: "a",
      nodes: {
        a: { parentId: "c", restLength: 1 },
        b: { parentId: "a", restLength: 1 },
        c: { parentId: "b", restLength: 1 },
      },
      settings: defaultSettings(),
    };
    expect(subtree(cyclic, "a").length).toBeLessThanOrEqual(3);
    expect(orderedNodes(cyclic).length).toBeLessThanOrEqual(3);
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

  it("carries a sibling branch hanging off an intermediate joint", () => {
    // body -> mid -> tip (grabbed), with `spur` also a child of mid (off-path).
    // Posing tip moves mid; spur must ride along rigidly, not detach.
    const branched: Chain = {
      id: "c2",
      rootId: "body",
      nodes: {
        body: { parentId: null, restLength: 0 },
        mid: { parentId: "body", restLength: 10 },
        tip: { parentId: "mid", restLength: 10 },
        spur: { parentId: "mid", restLength: 8 },
      },
      settings: defaultSettings(),
    };
    const pos = {
      body: { x: 0, y: 0 },
      mid: { x: 10, y: 0 },
      tip: { x: 20, y: 0 },
      spur: { x: 10, y: 8 },
    };
    const { positions: p } = solvePose(branched, pos, { tip: { x: 4, y: 12 } });
    // mid actually moved (the branch flexed)...
    expect(dist(p.mid, pos.mid)).toBeGreaterThan(1);
    // ...and spur rode along, keeping its bone to mid instead of stretching.
    expect(dist(p.mid, p.spur)).toBeCloseTo(8, 5);
    expect(dist(p.spur, pos.spur)).toBeGreaterThan(0.5);
  });

  it("pins the solve at a locked joint (sub-base), leaving everything above it fixed", () => {
    // body -> A -> B(locked) -> C. Grabbing C must anchor at B: body/A/B stay
    // put and only the B->C segment flexes. Without pinning, FABRIK from the
    // root would drag A and B along too.
    const chain: Chain = {
      id: "c3",
      rootId: "body",
      nodes: {
        body: { parentId: null, restLength: 0 },
        A: { parentId: "body", restLength: 10 },
        B: { parentId: "A", restLength: 10 },
        C: { parentId: "B", restLength: 10 },
      },
      settings: { ...defaultSettings(), nodeOverrides: { B: { locked: true } } },
    };
    const pos = {
      body: { x: 0, y: 0 },
      A: { x: 10, y: 0 },
      B: { x: 20, y: 0 },
      C: { x: 30, y: 0 },
    };
    const { positions: p } = solvePose(chain, pos, { C: { x: 20, y: 12 } });
    // Above the pin: untouched.
    expect(p.body).toEqual(pos.body);
    expect(p.A).toEqual(pos.A);
    expect(p.B).toEqual(pos.B);
    // Below the pin: C moved and its bone length to the pin is preserved.
    expect(dist(p.B, p.C)).toBeCloseTo(10, 5);
    expect(dist(p.C, pos.C)).toBeGreaterThan(1);
  });

  it("uses the DEEPEST locked joint as the pin when several are locked", () => {
    const chain: Chain = {
      id: "c4",
      rootId: "n0",
      nodes: {
        n0: { parentId: null, restLength: 0 },
        n1: { parentId: "n0", restLength: 10 },
        n2: { parentId: "n1", restLength: 10 },
        n3: { parentId: "n2", restLength: 10 },
      },
      settings: {
        ...defaultSettings(),
        nodeOverrides: { n1: { locked: true }, n2: { locked: true } },
      },
    };
    const pos = {
      n0: { x: 0, y: 0 },
      n1: { x: 10, y: 0 },
      n2: { x: 20, y: 0 },
      n3: { x: 30, y: 0 },
    };
    const { positions: p } = solvePose(chain, pos, { n3: { x: 20, y: 15 } });
    // n2 is the deepest lock, so n0/n1/n2 all hold; only n3 moves.
    expect(p.n1).toEqual(pos.n1);
    expect(p.n2).toEqual(pos.n2);
    expect(dist(p.n3, pos.n3)).toBeGreaterThan(1);
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
