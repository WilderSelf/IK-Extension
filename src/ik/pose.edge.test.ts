/**
 * poseRig / solvePose EDGE CASES & multi-chain interactions: solving at every
 * grabbed index, tail-carry integrity, descendant carry (chains + limb sub-rigs),
 * cycle-guarded data, and combined anchor+limit posing.
 */
import { describe, it, expect } from "vitest";
import type { Chain, ChainMap, Vec2 } from "../types";
import { defaultSettings } from "../types";
import {
  buildChain,
  enableSegmentRig,
  orderedNodes,
  setAnchorLimit,
  setDefaultLimit,
  setParentNode,
} from "../model/chains";
import { boneAngles, poseRig, solvePose } from "./pose";
import { jointAngles, reconstructJoints } from "./segment";
import { dist, wrapAngle } from "./vec";

const pos = (o: Record<string, [number, number]>): Record<string, Vec2> =>
  Object.fromEntries(Object.entries(o).map(([k, [x, y]]) => [k, { x, y }]));
const rot0 = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, 0]));
const idOf = (m: ChainMap, root: string) => Object.values(m).find((c) => c.rootId === root)!.id;

function line(n: number): { chain: Chain; positions: Record<string, Vec2> } {
  const ids = Array.from({ length: n }, (_, i) => `N${i}`);
  const positions = pos(Object.fromEntries(ids.map((id, i) => [id, [i * 10, 0]])));
  const map = buildChain({}, ids, positions, rot0(ids))!;
  return { chain: map[0][map[1]], positions };
}

describe("solvePose at every grabbed index", () => {
  it("root pinned + path lengths preserved + tail rigid, for each non-root grab", () => {
    const { chain, positions } = line(6);
    const order = orderedNodes(chain);
    for (let gi = 1; gi < order.length; gi++) {
      const grabbed = order[gi];
      // Keep the target within the path's reach (path length from root = gi*10),
      // else the chain straightens and the tip legitimately can't touch it.
      const target = { x: gi * 10 - 2, y: 4 };
      const { positions: out } = solvePose(chain, positions, grabbed, target);
      // Root pinned.
      expect(out[order[0]]).toEqual(positions[order[0]]);
      // Every bone length preserved (path + tail).
      for (let i = 1; i < order.length; i++) {
        expect(dist(out[order[i - 1]], out[order[i]])).toBeCloseTo(10, 4);
      }
      // Grabbed node reached its target. A single-bone path (gi===1) is a rigid
      // length-10 spoke whose tip is always 10 from the root, so it can only point
      // at an interior target, not touch it — reachability applies from 2 bones up.
      if (gi >= 2) expect(dist(out[grabbed], target)).toBeLessThan(1);
      // Finite everywhere.
      for (const id of order) expect(Number.isFinite(out[id].x) && Number.isFinite(out[id].y)).toBe(true);
    }
  });

  it("grabbing the root returns the chain unchanged", () => {
    const { chain, positions } = line(4);
    const { positions: out } = solvePose(chain, positions, orderedNodes(chain)[0], { x: 99, y: 99 });
    expect(out).toEqual(positions);
  });

  it("solving with a gap in the path (missing mid position) is a graceful no-op", () => {
    const { chain, positions } = line(4);
    const order = orderedNodes(chain);
    const holed = { ...positions };
    delete holed[order[1]]; // knock a hole in the path to the grabbed tip
    const { positions: out } = solvePose(chain, holed, order[3], { x: 5, y: 5 });
    // No NaN injected; the untouched nodes keep their positions.
    for (const id of Object.keys(out)) {
      if (out[id]) expect(Number.isFinite(out[id].x) && Number.isFinite(out[id].y)).toBe(true);
    }
    expect(out[order[0]]).toEqual(positions[order[0]]);
  });
});

describe("poseRig descendant carry", () => {
  function rig(): { chains: ChainMap; aId: string; bId: string; base: Record<string, Vec2> } {
    let chains = buildChain({}, ["A0", "A1", "A2"], pos({ A0: [0, 0], A1: [10, 0], A2: [20, 0] }), rot0(["A0", "A1", "A2"]))![0];
    chains = buildChain(chains, ["B0", "B1"], pos({ B0: [20, 10], B1: [30, 10] }), rot0(["B0", "B1"]))![0];
    const aId = idOf(chains, "A0"), bId = idOf(chains, "B0");
    chains = setParentNode(chains, bId, "A2");
    const base = pos({ A0: [0, 0], A1: [10, 0], A2: [20, 0], B0: [20, 10], B1: [30, 10] });
    return { chains, aId, bId, base };
  }

  it("child rides rigidly (shape preserved) when the parent is solved", () => {
    const { chains, aId, base } = rig();
    const { positions: out } = poseRig(chains, aId, base, { mode: "solve", grabbedId: "A2", target: { x: 8, y: 14 } });
    expect(out.A0).toEqual({ x: 0, y: 0 });
    // B's own bone length preserved & B0 sits exactly on A2 offset it was captured at.
    expect(dist(out.B0, out.B1)).toBeCloseTo(10, 5);
    expect(dist(out.B0, out.A2)).toBeCloseTo(dist(base.B0, base.A2), 5);
  });

  it("a grandchild two levels down tracks a translate exactly", () => {
    let { chains, aId, base } = rig();
    chains = buildChain(chains, ["C0", "C1"], pos({ C0: [30, 20], C1: [40, 20] }), rot0(["C0", "C1"]))![0];
    chains = setParentNode(chains, idOf(chains, "C0"), "B1");
    base = { ...base, C0: { x: 30, y: 20 }, C1: { x: 40, y: 20 } };
    const { positions: out } = poseRig(chains, aId, base, { mode: "translate", delta: { x: 3, y: -2 } });
    expect(out.C0).toEqual({ x: 33, y: 18 });
    expect(out.C1).toEqual({ x: 43, y: 18 });
  });

  it("posing a child never moves its ancestor", () => {
    const { chains, bId, base } = rig();
    const { positions: out } = poseRig(chains, bId, base, { mode: "solve", grabbedId: "B1", target: { x: 35, y: 25 } });
    expect(out.A0).toEqual({ x: 0, y: 0 });
    expect(out.A2).toEqual({ x: 20, y: 0 });
  });

  it("a data cycle in the attachment forest does not hang (cycle-guarded)", () => {
    // Force a 2-cycle in metadata that setParentNode would normally reject.
    let chains = buildChain({}, ["A0", "A1"], pos({ A0: [0, 0], A1: [10, 0] }), rot0(["A0", "A1"]))![0];
    chains = buildChain(chains, ["B0", "B1"], pos({ B0: [10, 5], B1: [20, 5] }), rot0(["B0", "B1"]))![0];
    const aId = idOf(chains, "A0"), bId = idOf(chains, "B0");
    chains[aId].parentNodeId = "B1"; // A follows B
    chains[bId].parentNodeId = "A1"; // B follows A  (cycle)
    const base = pos({ A0: [0, 0], A1: [10, 0], B0: [10, 5], B1: [20, 5] });
    // Should terminate and stay finite rather than loop forever.
    const { positions: out } = poseRig(chains, aId, base, { mode: "translate", delta: { x: 1, y: 1 } });
    for (const id of Object.keys(out)) expect(Number.isFinite(out[id].x)).toBe(true);
  });
});

describe("limb-mode sub-chain carried by a segment-rig parent", () => {
  // Arm S0-S1-S2 in LIMB mode; sub-chain P0-P1 attached to the MIDDLE segment S1.
  // Posing the arm should carry the sub-chain rigidly with S1's SEGMENT motion, so
  // the sub-chain's orientation relative to the S1 segment is preserved.
  function armWithSub() {
    let chains = buildChain({}, ["S0", "S1", "S2"], pos({ S0: [0, 0], S1: [10, 0], S2: [20, 0] }), rot0(["S0", "S1", "S2"]))![0];
    const sId = idOf(chains, "S0");
    chains = enableSegmentRig(chains, sId, pos({ S0: [0, 0], S1: [10, 0], S2: [20, 0] }), rot0(["S0", "S1", "S2"]));
    chains = buildChain(chains, ["P0", "P1"], pos({ P0: [10, 6], P1: [14, 6] }), rot0(["P0", "P1"]))![0];
    const pId = idOf(chains, "P0");
    chains = setParentNode(chains, pId, "S1");
    const base = pos({ S0: [0, 0], S1: [10, 0], S2: [20, 0], P0: [10, 6], P1: [14, 6] });
    const baseRot: Record<string, number> = { S0: 0, S1: 0, S2: 0, P0: 0, P1: 0 };
    return { chains, sId, base, baseRot };
  }

  it("preserves the sub-chain's shape and its angle relative to the parent segment", () => {
    const { chains, sId, base, baseRot } = armWithSub();
    const order = orderedNodes(chains[sId]); // S0,S1,S2

    // Base segment angle of S1 (index 1 among the reconstructed joints).
    const baseSeg = jointAngles(reconstructJoints(
      order.map((id) => base[id]), order.map((id) => baseRot[id]), order.map((id) => chains[sId].nodes[id].seg!),
    ));
    const relBase = wrapAngle(Math.atan2(base.P1.y - base.P0.y, base.P1.x - base.P0.x) - baseSeg[1]);

    const { positions: out, rotations } = poseRig(
      chains, sId, base, { mode: "solve", grabbedId: "S2", target: { x: 4, y: 16 } }, undefined, baseRot,
    );

    // Sub-chain shape preserved.
    expect(dist(out.P0, out.P1)).toBeCloseTo(dist(base.P0, base.P1), 4);
    // The S1 segment's posed direction is what poseRig emitted as rotations.S1.
    const postSeg = rotations.S1;
    const relPost = wrapAngle(Math.atan2(out.P1.y - out.P0.y, out.P1.x - out.P0.x) - postSeg);
    // The sub-chain must keep its orientation relative to the segment it rides.
    expect(wrapAngle(relPost - relBase)).toBeCloseTo(0, 3);
  });
});

describe("combined anchor + bend limit while posing", () => {
  it("both the root-swing cone and the per-joint bends are respected together", () => {
    let chains = buildChain({}, ["S0", "S1", "S2", "S3"],
      pos({ S0: [0, 0], S1: [10, 0], S2: [20, 0], S3: [30, 0] }), rot0(["S0", "S1", "S2", "S3"]))![0];
    const sId = idOf(chains, "S0");
    chains = setParentNode(chains, sId, "BODY");
    chains = setAnchorLimit(chains, sId, { min: -0.25, max: 0.25 });
    chains = setDefaultLimit(chains, sId, { min: -0.3, max: 0.3 });
    const base = pos({ S0: [0, 0], S1: [10, 0], S2: [20, 0], S3: [30, 0] });
    const { positions: out } = poseRig(chains, sId, base,
      { mode: "solve", grabbedId: "S3", target: { x: -5, y: 22 } }, undefined, { S0: 0, S1: 0, S2: 0, S3: 0, BODY: 0 });
    // Root swing within the anchor cone about BODY's rotation (0).
    const rootDir = Math.atan2(out.S1.y - out.S0.y, out.S1.x - out.S0.x);
    expect(Math.abs(rootDir)).toBeLessThanOrEqual(0.25 + 1e-3);
    // Interior bend at S2 within the default limit.
    const inA = Math.atan2(out.S1.y - out.S0.y, out.S1.x - out.S0.x);
    const outA = Math.atan2(out.S2.y - out.S1.y, out.S2.x - out.S1.x);
    expect(Math.abs(wrapAngle(outA - inA))).toBeLessThanOrEqual(0.3 + 1e-3);
    // Lengths intact.
    for (const [a, b] of [["S0", "S1"], ["S1", "S2"], ["S2", "S3"]] as const) {
      expect(dist(out[a], out[b])).toBeCloseTo(10, 4);
    }
  });
});

describe("boneAngles", () => {
  it("root faces its child along +x", () => {
    const { chain, positions } = line(3);
    const order = orderedNodes(chain);
    const rot = boneAngles(chain, positions);
    expect(rot[order[0]]).toBeCloseTo(0, 9); // +x line
  });

  it("root faces a child that is straight down (+y ⇒ +π/2)", () => {
    const [map, id] = buildChain({}, ["X", "Y"], pos({ X: [0, 0], Y: [0, 10] }), { X: 0, Y: 0 })!;
    expect(boneAngles(map[id], pos({ X: [0, 0], Y: [0, 10] }))["X"]).toBeCloseTo(Math.PI / 2, 9);
  });

  it("a lone-root chain reads 0 (no child to face)", () => {
    const chain: Chain = { id: "c", rootId: "R", nodes: { R: { parentId: null, restLength: 0 } }, settings: defaultSettings() };
    expect(boneAngles(chain, pos({ R: [4, 4] }))["R"]).toBe(0);
  });
});
