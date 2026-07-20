/**
 * MALFORMED / WRONG-PIECES stress: corrupt topology, holes, orphans, cycles,
 * missing positions. Nothing here should THROW or hang; with finite inputs the
 * output must stay finite. (NaN/Infinity inputs are handled separately — the pure
 * solver may propagate them; applyPose/radToObrDeg are the OBR-boundary guard.)
 */
import { describe, it, expect } from "vitest";
import type { Chain, ChainMap, ChainNode } from "../types";
import { defaultSettings } from "../types";
import {
  buildChain,
  chainCanLimit,
  descendantChainIds,
  effectiveStiffness,
  findChainForToken,
  isSegmentRig,
  limitableTokens,
  orderedNodes,
  removeToken,
  setParentNode,
} from "../model/chains";
import { anchorBend, boneAngles, chainBends, poseRig, relativeBends, solvePose } from "../ik/pose";
import { allFinite, finitePt, idOf, pos, rng, rot0 } from "./helpers";

const chainOf = (rootId: string, nodes: Record<string, ChainNode>): Chain =>
  ({ id: "c", rootId, nodes, settings: { ...defaultSettings() } });

describe("corrupt topology never hangs or throws", () => {
  it("rootId not present in nodes → empty order, inert pose", () => {
    const chain = chainOf("MISSING", { A: { parentId: null, restLength: 0 }, B: { parentId: "A", restLength: 10 } });
    expect(orderedNodes(chain)).toEqual([]);
    const p = pos({ A: [0, 0], B: [10, 0] });
    expect(() => solvePose(chain, p, "B", { x: 1, y: 1 })).not.toThrow();
    expect(boneAngles(chain, p)).toEqual({});
  });

  it("empty nodes with a rootId → no crash", () => {
    const chain = chainOf("R", {});
    expect(orderedNodes(chain)).toEqual([]);
    expect(() => poseRig({ c: chain }, "c", pos({ R: [0, 0] }), { mode: "translate", delta: { x: 1, y: 1 } })).not.toThrow();
  });

  it("2-cycle and 3-cycle parentIds terminate with no repeats", () => {
    const two = chainOf("R", { R: { parentId: "A", restLength: 10 }, A: { parentId: "R", restLength: 10 } });
    const three = chainOf("R", {
      R: { parentId: "C", restLength: 1 }, A: { parentId: "R", restLength: 1 },
      B: { parentId: "A", restLength: 1 }, C: { parentId: "B", restLength: 1 },
    });
    for (const c of [two, three]) {
      const order = orderedNodes(c);
      expect(order[0]).toBe("R");
      expect(new Set(order).size).toBe(order.length);
    }
  });

  it("root carrying a non-null parentId is still walked from the root", () => {
    const chain = chainOf("R", {
      R: { parentId: "ZZZ", restLength: 5 }, // bogus parent on the root
      A: { parentId: "R", restLength: 10 },
    });
    expect(orderedNodes(chain)).toEqual(["R", "A"]);
  });

  it("branching (two children share a parent) follows exactly one strand", () => {
    const chain = chainOf("R", {
      R: { parentId: null, restLength: 0 },
      A: { parentId: "R", restLength: 10 },
      B: { parentId: "R", restLength: 10 }, // second child of R
    });
    const order = orderedNodes(chain);
    expect(order[0]).toBe("R");
    expect(order.length).toBe(2); // linear: only one of A/B is reached
    expect(new Set(order).size).toBe(order.length);
  });

  it("random corrupt topologies never hang orderedNodes (fuzz)", () => {
    const r = rng(0xBADF00D);
    for (let t = 0; t < 500; t++) {
      const n = 1 + Math.floor(r() * 12);
      const ids = Array.from({ length: n }, (_, i) => `k${i}`);
      const nodes: Record<string, ChainNode> = {};
      for (const id of ids) {
        // parent is a random id, sometimes itself, sometimes a ghost, sometimes null
        const roll = r();
        const parentId = roll < 0.15 ? null : roll < 0.25 ? id : roll < 0.35 ? "ghost" : ids[Math.floor(r() * n)];
        nodes[id] = { parentId, restLength: r() * 20 };
      }
      const chain = chainOf(ids[Math.floor(r() * n)], nodes);
      const order = orderedNodes(chain);
      expect(new Set(order).size).toBe(order.length); // never revisits (no infinite loop)
      // Downstream must not throw on this garbage.
      const p = pos(Object.fromEntries(ids.map((id, i) => [id, [i * 3, i]])));
      expect(() => solvePose(chain, p, ids[Math.floor(r() * n)], { x: 5, y: 5 })).not.toThrow();
      expect(() => boneAngles(chain, p)).not.toThrow();
      expect(() => relativeBends(chain, p)).not.toThrow();
    }
  });
});

describe("holes in the position map", () => {
  function arm(): Chain {
    return chainOf("R", {
      R: { parentId: null, restLength: 0 },
      A: { parentId: "R", restLength: 10 },
      B: { parentId: "A", restLength: 10 },
      C: { parentId: "B", restLength: 10 },
    });
  }

  it("a mid hole makes solvePose a safe no-op (no NaN injected)", () => {
    const chain = arm();
    const holed = pos({ R: [0, 0], B: [20, 0], C: [30, 0] }); // A missing
    const { positions } = solvePose(chain, holed, "C", { x: 5, y: 5 });
    for (const id of Object.keys(positions)) if (positions[id]) expect(finitePt(positions[id])).toBe(true);
  });

  it("chainBends / relativeBends skip joints with missing neighbours", () => {
    const chain = arm();
    const holed = pos({ R: [0, 0], A: [10, 0], C: [30, 0] }); // B missing
    expect(() => relativeBends(chain, holed)).not.toThrow();
    expect(() => chainBends(chain, holed, {})).not.toThrow();
  });

  it("anchorBend returns null when the root/child geometry is missing", () => {
    const chain = arm();
    expect(anchorBend(chain, pos({ R: [0, 0] }), {}, 0)).toBeNull(); // child A missing
  });

  it("poseRig tolerates descendants whose parent has no position", () => {
    let map: ChainMap = buildChain({}, ["A0", "A1"], pos({ A0: [0, 0], A1: [10, 0] }), rot0(["A0", "A1"]))![0];
    map = buildChain(map, ["B0", "B1"], pos({ B0: [10, 5], B1: [20, 5] }), rot0(["B0", "B1"]))![0];
    map = setParentNode(map, idOf(map, "B0"), "A1");
    // base LACKS A1 (the parent node B follows) -> B just isn't carried.
    const base = pos({ A0: [0, 0], B0: [10, 5], B1: [20, 5] });
    expect(() => poseRig(map, idOf(map, "A0"), base, { mode: "translate", delta: { x: 1, y: 1 } })).not.toThrow();
  });
});

describe("wrong pieces — duplicates & bad ids", () => {
  it("buildChain rejects duplicate ids (any position)", () => {
    expect(buildChain({}, ["X", "Y", "X"], pos({ X: [0, 0], Y: [10, 0] }), rot0(["X", "Y"]))).toBeNull();
    expect(buildChain({}, ["X", "X"], pos({ X: [0, 0] }), rot0(["X"]))).toBeNull();
  });

  it("operations on ids absent from the map are identity no-ops", () => {
    const map = buildChain({}, ["A", "B"], pos({ A: [0, 0], B: [10, 0] }), rot0(["A", "B"]))![0];
    expect(removeToken(map, "ghost")).toBe(map);
    expect(findChainForToken(map, "ghost")).toBeUndefined();
    expect(setParentNode(map, "ghost-chain", "A")).toBe(map);
  });
});

describe("corrupt segment-rig data", () => {
  it("segmentRig flag on but seg missing → treated as centre rig, no crash", () => {
    const chain = chainOf("R", {
      R: { parentId: null, restLength: 0 },
      A: { parentId: "R", restLength: 10 },
      B: { parentId: "A", restLength: 10 },
    });
    chain.settings.segmentRig = true; // flag set, but no seg captured
    expect(isSegmentRig(chain)).toBe(false);
    expect(chainCanLimit(chain)).toBe(true);
    expect(limitableTokens(chain)).toEqual(["B"]); // centre-rig rule
    const p = pos({ R: [0, 0], A: [10, 0], B: [20, 0] });
    expect(() => poseRig({ c: chain }, "c", p, { mode: "solve", grabbedId: "B", target: { x: 5, y: 9 } }, undefined, rot0(["R", "A", "B"]))).not.toThrow();
  });

  it("zero-length seg data reconstructs finitely (coincident capture)", () => {
    const chain = chainOf("R", {
      R: { parentId: null, restLength: 0, seg: { len: 0, seatAlong: 0.5, seatPerp: 0, offsetDeg: 0 } },
      A: { parentId: "R", restLength: 0, seg: { len: 0, seatAlong: 0.5, seatPerp: 0, offsetDeg: 0 } },
    });
    chain.settings.segmentRig = true;
    expect(isSegmentRig(chain)).toBe(true);
    const p = pos({ R: [0, 0], A: [0, 0] });
    const out = poseRig({ c: chain }, "c", p, { mode: "solve", grabbedId: "A", target: { x: 3, y: 4 } }, undefined, { R: 0, A: 0 });
    expect(allFinite(out.positions)).toBe(true);
  });
});

describe("stiffness / effective resolution on corrupt chains", () => {
  it("effectiveStiffness on a ghost node falls back to normal", () => {
    const chain = chainOf("R", { R: { parentId: null, restLength: 0 }, A: { parentId: "R", restLength: 10 } });
    expect(effectiveStiffness(chain, "ghost")).toBe("normal");
  });

  it("descendantChainIds terminates on a forced cyclic attachment graph", () => {
    let map: ChainMap = buildChain({}, ["A0", "A1"], pos({ A0: [0, 0], A1: [10, 0] }), rot0(["A0", "A1"]))![0];
    map = buildChain(map, ["B0", "B1"], pos({ B0: [0, 5], B1: [10, 5] }), rot0(["B0", "B1"]))![0];
    // Hand-force a cycle setParentNode would reject.
    map[idOf(map, "A0")].parentNodeId = "B1";
    map[idOf(map, "B0")].parentNodeId = "A1";
    expect(() => descendantChainIds(map, idOf(map, "A0"))).not.toThrow();
    expect(descendantChainIds(map, idOf(map, "A0")).length).toBeLessThanOrEqual(2);
  });
});
