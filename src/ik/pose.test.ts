import { describe, it, expect } from "vitest";
import type { Chain, ChainMap, Vec2 } from "../types";
import { defaultSettings } from "../types";
import { buildChain, enableSegmentRig, orderedNodes, setDefaultLimit, setParentNode } from "../model/chains";
import { boneAngles, chainBends, poseRig, relativeBends, rigidTranslate, solvePose } from "./pose";
import { dist, wrapAngle } from "./vec";

// Signed bend at the joint x-y-z: angle(y→z) minus angle(x→y), wrapped.
const relBend = (p: Record<string, Vec2>, x: string, y: string, z: string) => {
  const inA = Math.atan2(p[y].y - p[x].y, p[y].x - p[x].x);
  const outA = Math.atan2(p[z].y - p[y].y, p[z].x - p[y].x);
  return Math.atan2(Math.sin(outA - inA), Math.cos(outA - inA));
};

const pos = (o: Record<string, [number, number]>): Record<string, Vec2> =>
  Object.fromEntries(Object.entries(o).map(([k, [x, y]]) => [k, { x, y }]));

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

  it("a stiff first bone bends less than a loose one when a tip is posed", () => {
    const target = { x: 10, y: 20 };
    const stiff = straightChain();
    stiff.chain.nodes["A"].stiffness = "stiff";
    const loose = straightChain();
    loose.chain.nodes["A"].stiffness = "loose";
    const outStiff = solvePose(stiff.chain, stiff.positions, "C", target).positions;
    const outLoose = solvePose(loose.chain, loose.positions, "C", target).positions;
    // A resists moving off its rest position more when stiff.
    expect(dist(outStiff.A, { x: 10, y: 0 })).toBeLessThan(dist(outLoose.A, { x: 10, y: 0 }));
  });

  it("respects a joint's captured bend limit while posing", () => {
    const { chain, positions } = straightChain();
    chain.nodes["B"].limit = { min: -0.15, max: 0.15 };
    const out = solvePose(chain, positions, "C", { x: 0, y: 25 }).positions;
    expect(Math.abs(relBend(out, "R", "A", "B"))).toBeLessThanOrEqual(0.15 + 1e-3);
  });
});

describe("relativeBends", () => {
  it("covers interior joints only and reads ~0 on a straight chain", () => {
    const { chain, positions } = straightChain();
    const bends = relativeBends(chain, positions);
    // A (the first movable node) has no reference bone above it, so it's excluded.
    expect(Object.keys(bends).sort()).toEqual(["B", "C"]);
    expect(bends["B"]).toBeCloseTo(0, 6);
    expect(bends["C"]).toBeCloseTo(0, 6);
  });

  it("measures a real bend when the chain is posed into an L", () => {
    const { chain } = straightChain();
    // Bend 90° at B: R-A along +x, then A-B-C turning up.
    const posed = { R: { x: 0, y: 0 }, A: { x: 10, y: 0 }, B: { x: 20, y: 0 }, C: { x: 20, y: 10 } };
    expect(relativeBends(chain, posed)["C"]).toBeCloseTo(Math.PI / 2, 5);
  });
});

describe("chainBends (segment rig)", () => {
  it("covers every non-root segment and reads ~0 at rest", () => {
    let chains = buildChain({}, ["S0", "S1", "S2"],
      pos({ S0: [0, 0], S1: [10, 0], S2: [20, 0] }), { S0: 0, S1: 0, S2: 0 })![0];
    const sId = Object.values(chains).find((c) => c.rootId === "S0")!.id;
    chains = enableSegmentRig(chains, sId, pos({ S0: [0, 0], S1: [10, 0], S2: [20, 0] }), { S0: 0, S1: 0, S2: 0 });
    // The FIRST movable segment (S1) is included here — the centre rig can't
    // measure it, so a limb rig gains that joint (the elbow).
    const bends = chainBends(chains[sId], pos({ S0: [0, 0], S1: [10, 0], S2: [20, 0] }), { S0: 0, S1: 0, S2: 0 });
    expect(Object.keys(bends).sort()).toEqual(["S1", "S2"]);
    expect(bends["S1"]).toBeCloseTo(0, 6);
    expect(bends["S2"]).toBeCloseTo(0, 6);
  });
});

describe("poseRig bend limits", () => {
  // Straight 3-segment limb rig; degree-space token rotations (all 0 at rest).
  function limbRig(withLimit: boolean) {
    let chains = buildChain({}, ["S0", "S1", "S2"],
      pos({ S0: [0, 0], S1: [10, 0], S2: [20, 0] }), { S0: 0, S1: 0, S2: 0 })![0];
    const sId = Object.values(chains).find((c) => c.rootId === "S0")!.id;
    chains = enableSegmentRig(chains, sId, pos({ S0: [0, 0], S1: [10, 0], S2: [20, 0] }), { S0: 0, S1: 0, S2: 0 });
    if (withLimit) chains = setDefaultLimit(chains, sId, { min: -0.2, max: 0.2 });
    const base = pos({ S0: [0, 0], S1: [10, 0], S2: [20, 0] });
    return { chains, sId, base, baseRot: { S0: 0, S1: 0, S2: 0 } };
  }
  // Inter-segment articulation at joint k = the turn from segment k-1 to segment k.
  // poseRig stores each token's SEGMENT direction (radians) as its rotation, so the
  // articulation is just the difference of adjacent tokens' output rotations.
  const artic = (rot: Record<string, number>, order: string[], k: number) =>
    Math.abs(wrapAngle(rot[order[k]] - rot[order[k - 1]]));

  it("clamps every inter-segment bend to the chain limit in LIMB mode (the fix)", () => {
    const { chains, sId, base, baseRot } = limbRig(true);
    const order = orderedNodes(chains[sId]);
    const target = { x: 0, y: 20 }; // reach up-and-back: forces the arm to fold
    const { rotations } = poseRig(chains, sId, base, { mode: "solve", grabbedId: "S2", target }, undefined, baseRot);
    expect(artic(rotations, order, 1)).toBeLessThanOrEqual(0.2 + 1e-3); // elbow (S0→S1)
    expect(artic(rotations, order, 2)).toBeLessThanOrEqual(0.2 + 1e-3); // wrist (S1→S2)
  });

  it("without a limit the same pose bends well past that cap (limit is doing the work)", () => {
    const { chains, sId, base, baseRot } = limbRig(false);
    const order = orderedNodes(chains[sId]);
    const target = { x: 0, y: 20 };
    const { rotations } = poseRig(chains, sId, base, { mode: "solve", grabbedId: "S2", target }, undefined, baseRot);
    const worst = Math.max(artic(rotations, order, 1), artic(rotations, order, 2));
    expect(worst).toBeGreaterThan(0.2);
  });
});

describe("boneAngles", () => {
  it("is zero along a straight +x chain", () => {
    const { chain, positions } = straightChain();
    const rot = boneAngles(chain, positions);
    for (const id of ["R", "A", "B", "C"]) expect(rot[id]).toBeCloseTo(0, 6);
  });
});

describe("poseRig (linked chains)", () => {
  // Main A: A0-A1-A2. Child B: B0-B1, attached to A2. Base positions for all.
  function rig() {
    let chains: ChainMap = buildChain({}, ["A0", "A1", "A2"],
      pos({ A0: [0, 0], A1: [10, 0], A2: [20, 0] }), { A0: 0, A1: 0, A2: 0 })![0];
    chains = buildChain(chains, ["B0", "B1"],
      pos({ B0: [20, 10], B1: [30, 10] }), { B0: 0, B1: 0 })![0];
    const aId = Object.values(chains).find((c) => c.rootId === "A0")!.id;
    const bId = Object.values(chains).find((c) => c.rootId === "B0")!.id;
    chains = setParentNode(chains, bId, "A2");
    const base = pos({ A0: [0, 0], A1: [10, 0], A2: [20, 0], B0: [20, 10], B1: [30, 10] });
    return { chains, aId, bId, base };
  }

  it("shifts the child by the same delta when the parent root is translated", () => {
    const { chains, aId, base } = rig();
    const { positions: out } = poseRig(chains, aId, base, { mode: "translate", delta: { x: 5, y: 7 } });
    expect(out.A0).toEqual({ x: 5, y: 7 });
    expect(out.B0).toEqual({ x: 25, y: 17 });
    expect(out.B1).toEqual({ x: 35, y: 17 });
  });

  it("carries the child rigidly when the parent is posed (root pinned, child rigid)", () => {
    const { chains, aId, base } = rig();
    const { positions: out } = poseRig(chains, aId, base, { mode: "solve", grabbedId: "A2", target: { x: 10, y: 15 } });
    expect(out.A0).toEqual({ x: 0, y: 0 }); // parent root pinned
    // Child moved and stayed rigid (its own bone length preserved).
    expect(dist(out.B0, base.B0)).toBeGreaterThan(1);
    expect(dist(out.B0, out.B1)).toBeCloseTo(10, 5);
  });

  it("does not move the parent when the child is posed alone", () => {
    const { chains, bId, base } = rig();
    const { positions: out } = poseRig(chains, bId, base, { mode: "solve", grabbedId: "B1", target: { x: 35, y: 25 } });
    expect(out.A0).toEqual({ x: 0, y: 0 });
    expect(out.A2).toEqual({ x: 20, y: 0 });
  });

  it("rotates a standalone chain's own root to face its child when posed", () => {
    // A standalone chain (no shared pivot): the root token is a real segment
    // (e.g. an upper arm) and must swing about its pinned joint as the tip moves.
    const chains = buildChain({}, ["S0", "S1", "S2"],
      pos({ S0: [0, 0], S1: [10, 0], S2: [20, 0] }), { S0: 0, S1: 0, S2: 0 })![0];
    const sId = Object.values(chains).find((c) => c.rootId === "S0")!.id;
    const base = pos({ S0: [0, 0], S1: [10, 0], S2: [20, 0] });
    const { positions: out, rotations } = poseRig(chains, sId, base, { mode: "solve", grabbedId: "S2", target: { x: 0, y: 20 } });
    expect(out.S0).toEqual({ x: 0, y: 0 }); // root still pinned in place
    // The root now carries a rotation, matching the new S0->S1 bone direction.
    expect(rotations.S0).not.toBeUndefined();
    expect(rotations.S0).toBeCloseTo(boneAngles(chains[sId], out).S0, 6);
  });

  it("articulates a sub-chain rooted at a shared anchor, parent left put", () => {
    // A: A0-A1-A2. Sub-chain P rooted at the shared pivot A2: A2-P1.
    let chains: ChainMap = buildChain({}, ["A0", "A1", "A2"],
      pos({ A0: [0, 0], A1: [10, 0], A2: [20, 0] }), { A0: 0, A1: 0, A2: 0 })![0];
    chains = buildChain(chains, ["A2", "P1"], pos({ A2: [20, 0], P1: [20, 10] }), { A2: 0, P1: 0 })![0];
    const aId = Object.values(chains).find((c) => c.rootId === "A0")!.id;
    const pId = Object.values(chains).find((c) => c.rootId === "A2")!.id;
    chains = setParentNode(chains, pId, "A2");
    const base = pos({ A0: [0, 0], A1: [10, 0], A2: [20, 0], P1: [20, 10] });

    // Pose the sub-chain (grab P1): pivot A2 pinned, P1 swings, arm untouched,
    // and P1 (a non-root segment now) gets a rotation.
    const p = poseRig(chains, pId, base, { mode: "solve", grabbedId: "P1", target: { x: 28, y: 6 } });
    expect(p.positions.A0).toEqual({ x: 0, y: 0 });
    expect(p.positions.A1).toEqual({ x: 10, y: 0 });
    expect(p.positions.A2).toEqual({ x: 20, y: 0 }); // shared pivot pinned
    expect(dist(p.positions.A2, p.positions.P1)).toBeCloseTo(10, 5);
    expect(p.positions.P1).not.toEqual(base.P1);
    expect(p.rotations.P1).not.toBeUndefined();
    // A2 is a SHARED PIVOT (a segment of arm A + root of sub-chain P): posing the
    // sub-chain must NOT re-rotate it — arm A owns its orientation.
    expect(p.rotations.A2).toBeUndefined();

    // Pose the arm: the sub-chain (pivot + P1) rides along.
    const q = poseRig(chains, aId, base, { mode: "translate", delta: { x: 3, y: 4 } });
    expect(q.positions.A2).toEqual({ x: 23, y: 4 });
    expect(q.positions.P1).toEqual({ x: 23, y: 14 });
  });

  it("segment rig: posing the tip rotates the root token about the shoulder", () => {
    let chains: ChainMap = buildChain({}, ["S0", "S1", "S2"],
      pos({ S0: [0, 0], S1: [10, 0], S2: [20, 0] }), { S0: 0, S1: 0, S2: 0 })![0];
    const sId = Object.values(chains).find((c) => c.rootId === "S0")!.id;
    chains = enableSegmentRig(chains, sId, pos({ S0: [0, 0], S1: [10, 0], S2: [20, 0] }), { S0: 0, S1: 0, S2: 0 });
    const base = pos({ S0: [0, 0], S1: [10, 0], S2: [20, 0] });
    // Reach the tip up and over; the whole arm should swing up at the shoulder.
    const p = poseRig(chains, sId, base, { mode: "solve", grabbedId: "S2", target: { x: 0, y: 20 } });
    // The ROOT token now carries a rotation (in the default rig it wouldn't) and
    // has actually turned off the straight-arm 0 toward the raised pose.
    expect(p.rotations.S0).not.toBeUndefined();
    expect(Math.abs(p.rotations.S0)).toBeGreaterThan(0.05);
    // Its centre moved as the upper segment pivoted about the (fixed) shoulder.
    expect(dist(p.positions.S0, base.S0)).toBeGreaterThan(0.5);
  });

  it("carries a grandchild two levels down", () => {
    let { chains, aId, base } = rig();
    chains = buildChain(chains, ["C0", "C1"], pos({ C0: [30, 20], C1: [40, 20] }), { C0: 0, C1: 0 })![0];
    const cId = Object.values(chains).find((c) => c.rootId === "C0")!.id;
    chains = setParentNode(chains, cId, "B1"); // C follows B, B follows A
    base = pos({ A0: [0, 0], A1: [10, 0], A2: [20, 0], B0: [20, 10], B1: [30, 10], C0: [30, 20], C1: [40, 20] });
    const { positions: out } = poseRig(chains, aId, base, { mode: "translate", delta: { x: 3, y: -2 } });
    expect(out.C0).toEqual({ x: 33, y: 18 });
    expect(out.C1).toEqual({ x: 43, y: 18 });
  });
});
