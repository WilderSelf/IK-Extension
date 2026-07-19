import { describe, it, expect } from "vitest";
import { type ChainMap, type Vec2, CHAIN_PALETTE } from "../types";
import {
  buildChain,
  createChain,
  deleteChain,
  pickChainColor,
  setChainColor,
  descendantChainIds,
  findChainForToken,
  chainHasLimits,
  chainLimits,
  clearLimits,
  disableSegmentRig,
  effectiveStiffness,
  enableSegmentRig,
  expandLimits,
  isSegmentRig,
  orderedNodes,
  resetJointPivots,
  setJointPivot,
  pruneMissing,
  removeToken,
  renameChain,
  renameNode,
  setChainLimits,
  setNodeStiffness,
  setParentNode,
  updateSettings,
} from "./chains";

const pos = (o: Record<string, [number, number]>): Record<string, Vec2> =>
  Object.fromEntries(Object.entries(o).map(([k, [x, y]]) => [k, { x, y }]));

const POS = pos({ R: [0, 0], A: [10, 0], B: [20, 0] });
const ROT = { R: 0, A: 0, B: 0 };
const threeChain = (): ChainMap => buildChain({}, ["R", "A", "B"], POS, ROT)![0];

describe("createChain", () => {
  it("creates a lone root with default settings", () => {
    const [map, id] = createChain({}, "root");
    expect(map[id].rootId).toBe("root");
    expect(orderedNodes(map[id])).toEqual(["root"]);
    expect(map[id].settings.autoRotate).toBe(true);
  });
});

describe("buildChain", () => {
  it("builds a linear strand with captured rest lengths and bone offsets", () => {
    const built = buildChain({}, ["R", "A", "B"], POS, ROT);
    expect(built).not.toBeNull();
    const chain = Object.values(built![0])[0];
    expect(orderedNodes(chain)).toEqual(["R", "A", "B"]);
    expect(chain.nodes.A.restLength).toBeCloseTo(10, 6);
    expect(chain.nodes.B.restLength).toBeCloseTo(10, 6);
    // Horizontal bone (angle 0) with token rotation 0 → boneOffsetDeg 0.
    expect(chain.nodes.A.boneOffsetDeg).toBeCloseTo(0, 6);
    // The ROOT gets an offset too, against its outgoing bone (R->A, angle 0),
    // so a posed limb's root token rotates to a correct orientation.
    expect(chain.nodes.R.boneOffsetDeg).toBeCloseTo(0, 6);
  });

  it("captures the root offset against its outgoing bone", () => {
    // R -> A points straight down (+y). Root token authored at 90° → offset 0.
    const built = buildChain({}, ["R", "A"], pos({ R: [0, 0], A: [0, 10] }), { R: 90, A: 90 });
    const chain = Object.values(built![0])[0];
    expect(chain.nodes.R.boneOffsetDeg).toBeCloseTo(0, 6);
  });

  it("rejects fewer than two tokens or duplicate ids", () => {
    expect(buildChain({}, ["R"], POS, ROT)).toBeNull();
    expect(buildChain({}, ["R", "R"], POS, ROT)).toBeNull();
  });
});

describe("segment rig (limb mode)", () => {
  const armChain = (): [ChainMap, string] => {
    const map = buildChain({}, ["R", "A", "B"], POS, ROT)![0];
    return [map, Object.keys(map)[0]];
  };

  it("captures per-node segment data and sets the flag", () => {
    const [map, id] = armChain();
    const next = enableSegmentRig(map, id, POS, ROT);
    expect(next[id].settings.segmentRig).toBe(true);
    expect(isSegmentRig(next[id])).toBe(true);
    // joints from centres 0,10,20 → -5,5,15,25: each segment len 10, centre at 0.5.
    expect(next[id].nodes.R.seg).toEqual({ len: 10, seatAlong: 0.5, seatPerp: 0, offsetDeg: 0 });
    expect(next[id].nodes.B.seg?.len).toBeCloseTo(10, 6);
  });

  it("records the rotation offset against the SEGMENT direction", () => {
    const [map, id] = armChain();
    // Segment points +x (angle 0); a token authored at 90° → offset 90.
    const next = enableSegmentRig(map, id, POS, { R: 90, A: 90, B: 90 });
    expect(next[id].nodes.A.seg?.offsetDeg).toBeCloseTo(90, 6);
  });

  it("disable clears the flag but leaves the default rig's boneOffsetDeg intact", () => {
    const [map, id] = armChain();
    const bone = map[id].nodes.A.boneOffsetDeg;
    const off = disableSegmentRig(enableSegmentRig(map, id, POS, ROT), id);
    expect(off[id].settings.segmentRig).toBeUndefined();
    expect(isSegmentRig(off[id])).toBe(false);
    expect(off[id].nodes.A.boneOffsetDeg).toBe(bone);
  });

  it("no-ops without at least two positioned tokens", () => {
    const [map, id] = armChain();
    expect(enableSegmentRig(map, id, { R: { x: 0, y: 0 } }, ROT)).toBe(map);
  });

  it("setJointPivot moves a joint (stores pivots) and recaptures rest data", () => {
    const [map0, id] = armChain();
    const map = enableSegmentRig(map0, id, POS, ROT);
    expect(map[id].pivots).toBeUndefined(); // auto joints until adjusted
    // Drag joint 0 (shoulder) from its auto spot (-5,0) to (-8,0): the root
    // segment (joint0→joint1=5) is now longer, so R.seg.len grows.
    const next = setJointPivot(map, id, 0, { x: -8, y: 0 }, POS, ROT);
    expect(next[id].pivots).toBeDefined();
    expect(next[id].pivots!.length).toBe(4); // N+1 joints for 3 tokens
    expect(next[id].nodes.R.seg!.len).toBeCloseTo(13, 6); // -8 → 5
    // Untouched interior joint keeps the auto midpoint length.
    expect(next[id].nodes.A.seg!.len).toBeCloseTo(10, 6);
  });

  it("setJointPivot no-ops when the chain isn't a segment rig", () => {
    const [map, id] = armChain();
    expect(setJointPivot(map, id, 0, { x: 1, y: 1 }, POS, ROT)).toBe(map);
  });

  it("resetJointPivots restores the auto midpoints", () => {
    const [map0, id] = armChain();
    const map = setJointPivot(enableSegmentRig(map0, id, POS, ROT), id, 0, { x: -8, y: 0 }, POS, ROT);
    const reset = resetJointPivots(map, id, POS, ROT);
    expect(reset[id].pivots).toBeUndefined();
    expect(reset[id].nodes.R.seg!.len).toBeCloseTo(10, 6); // back to auto
  });
});

describe("removeToken", () => {
  it("truncates the strand at an interior node", () => {
    const next = removeToken(threeChain(), "A"); // drops A and B
    expect(orderedNodes(Object.values(next)[0])).toEqual(["R"]);
  });

  it("deletes the whole chain when the root is removed", () => {
    expect(removeToken(threeChain(), "R")).toEqual({});
  });

  it("does not mutate the input", () => {
    const map = threeChain();
    const snapshot = JSON.stringify(map);
    removeToken(map, "A");
    expect(JSON.stringify(map)).toEqual(snapshot);
  });
});

describe("pruneMissing", () => {
  it("drops the trailing part past a missing token", () => {
    const next = pruneMissing(threeChain(), new Set(["R", "A"])); // B gone
    expect(orderedNodes(Object.values(next)[0])).toEqual(["R", "A"]);
  });

  it("drops the whole chain when the root token is gone", () => {
    expect(pruneMissing(threeChain(), new Set(["A", "B"]))).toEqual({});
  });

  it("cuts at the first hole even if a later node survives", () => {
    const next = pruneMissing(threeChain(), new Set(["R", "B"])); // A gone
    expect(orderedNodes(Object.values(next)[0])).toEqual(["R"]);
  });
});

describe("updateSettings", () => {
  it("merges a settings patch without mutating the input", () => {
    const [map, id] = createChain({}, "root");
    const snapshot = JSON.stringify(map);
    const next = updateSettings(map, id, { autoRotate: false });
    expect(next[id].settings.autoRotate).toBe(false);
    expect(JSON.stringify(map)).toEqual(snapshot);
  });
});

describe("stiffness (setNodeStiffness / effectiveStiffness)", () => {
  // Chain R-A-B; every node starts on the chain default ("normal").
  const build = () =>
    buildChain({}, ["R", "A", "B"], pos({ R: [0, 0], A: [10, 0], B: [20, 0] }), { R: 0, A: 0, B: 0 })!;

  it("defaults every node to the chain default when unset", () => {
    const [map, id] = build();
    expect(effectiveStiffness(map[id], "A")).toBe("normal");
    expect(effectiveStiffness(map[id], "B")).toBe("normal");
  });

  it("a per-node override wins over the chain default", () => {
    const [map, id] = build();
    const next = setNodeStiffness(map, "A", "stiff");
    expect(effectiveStiffness(next[id], "A")).toBe("stiff");
    expect(effectiveStiffness(next[id], "B")).toBe("normal");
  });

  it("nodes without an override follow a changed chain default", () => {
    let [map, id] = build();
    map = setNodeStiffness(map, "A", "stiff");
    map = updateSettings(map, id, { defaultStiffness: "loose" });
    expect(effectiveStiffness(map[id], "A")).toBe("stiff"); // override held
    expect(effectiveStiffness(map[id], "B")).toBe("loose"); // inherited default
  });

  it("clearing an override falls back to the chain default", () => {
    let [map, id] = build();
    map = updateSettings(map, id, { defaultStiffness: "loose" });
    map = setNodeStiffness(map, "A", "stiff");
    map = setNodeStiffness(map, "A", null);
    expect(map[id].nodes["A"].stiffness).toBeUndefined();
    expect(effectiveStiffness(map[id], "A")).toBe("loose");
  });

  it("falls back to normal for a chain persisted without a default", () => {
    const [map, id] = build();
    delete map[id].settings.defaultStiffness; // simulate legacy metadata
    expect(effectiveStiffness(map[id], "A")).toBe("normal");
  });

  it("ignores the root and unknown tokens, leaving the map unchanged", () => {
    const [map] = build();
    expect(setNodeStiffness(map, "R", "stiff")).toBe(map);
    expect(setNodeStiffness(map, "ghost", "stiff")).toBe(map);
  });

  it("does not mutate the input map", () => {
    const [map] = build();
    const snapshot = JSON.stringify(map);
    setNodeStiffness(map, "A", "stiff");
    expect(JSON.stringify(map)).toEqual(snapshot);
  });

  it("accepts the two new mid stops (soft/firm)", () => {
    const [map, id] = build();
    expect(effectiveStiffness(setNodeStiffness(map, "A", "soft")[id], "A")).toBe("soft");
    expect(effectiveStiffness(setNodeStiffness(map, "A", "firm")[id], "A")).toBe("firm");
  });
});

describe("chain highlight colour", () => {
  const build = (map: ChainMap, ids: string[]) =>
    buildChain(map, ids, pos(Object.fromEntries(ids.map((id, i) => [id, [i * 10, 0]]))),
      Object.fromEntries(ids.map((id) => [id, 0])))!;

  it("assigns a palette colour when a chain is built", () => {
    const [map, id] = build({}, ["R", "A"]);
    expect(CHAIN_PALETTE).toContain(map[id].color);
  });

  it("gives distinct chains distinct default colours", () => {
    let [map, a] = build({}, ["R", "A"]);
    let [map2, b] = build(map, ["S", "B"]);
    expect(map2[a].color).not.toBe(map2[b].color);
  });

  it("pickChainColor returns the first unused palette entry", () => {
    const [map] = build({}, ["R", "A"]);
    const used = Object.values(map)[0].color;
    expect(pickChainColor(map)).not.toBe(used);
    expect(pickChainColor(map)).toBe(CHAIN_PALETTE.find((c) => c !== used));
  });

  it("setChainColor sets a colour, ignores unknown ids, and does not mutate", () => {
    const [map, id] = build({}, ["R", "A"]);
    expect(setChainColor(map, id, "#123456")[id].color).toBe("#123456");
    expect(setChainColor(map, "nope", "#123456")).toBe(map);
    const snapshot = JSON.stringify(map);
    setChainColor(map, id, "#abcdef");
    expect(JSON.stringify(map)).toEqual(snapshot);
  });
});

describe("stiffness ease ramp", () => {
  // R-A-B-C-D: four movable joints, so the ramp lands on distinct stops.
  const build5 = () =>
    buildChain({}, ["R", "A", "B", "C", "D"],
      pos({ R: [0, 0], A: [10, 0], B: [20, 0], C: [30, 0], D: [40, 0] }),
      { R: 0, A: 0, B: 0, C: 0, D: 0 })!;

  it("ramps stiff at the base to loose at the tip", () => {
    let [map, id] = build5();
    map = updateSettings(map, id, { ease: true });
    expect(effectiveStiffness(map[id], "A")).toBe("stiff"); // base
    expect(effectiveStiffness(map[id], "B")).toBe("firm");
    expect(effectiveStiffness(map[id], "C")).toBe("soft");
    expect(effectiveStiffness(map[id], "D")).toBe("loose"); // tip
  });

  it("lets a per-token override win over the ramp", () => {
    let [map, id] = build5();
    map = updateSettings(map, id, { ease: true });
    map = setNodeStiffness(map, "A", "loose");
    expect(effectiveStiffness(map[id], "A")).toBe("loose"); // override, not the ramp's "stiff"
    expect(effectiveStiffness(map[id], "D")).toBe("loose"); // still ramped
  });

  it("leaves a single movable joint stiff", () => {
    let [map, id] = buildChain({}, ["R", "A"], pos({ R: [0, 0], A: [10, 0] }), { R: 0, A: 0 })!;
    map = updateSettings(map, id, { ease: true });
    expect(effectiveStiffness(map[id], "A")).toBe("stiff");
  });
});

describe("bend limits (capture / clear / expand)", () => {
  const build = () =>
    buildChain({}, ["R", "A", "B", "C"],
      pos({ R: [0, 0], A: [10, 0], B: [20, 0], C: [30, 0] }), { R: 0, A: 0, B: 0, C: 0 })!;

  it("a fresh chain has no limits", () => {
    const [map, id] = build();
    expect(chainHasLimits(map[id])).toBe(false);
    expect(chainLimits(map[id])).toEqual({});
  });

  it("sets and reads per-joint limits", () => {
    const [map, id] = build();
    const next = setChainLimits(map, id, { B: { min: -0.2, max: 0.3 } });
    expect(chainHasLimits(next[id])).toBe(true);
    expect(chainLimits(next[id])).toEqual({ B: { min: -0.2, max: 0.3 } });
    expect(next[id].nodes["C"].limit).toBeUndefined();
  });

  it("replaces limits wholesale, freeing nodes not named", () => {
    let [map, id] = build();
    map = setChainLimits(map, id, { B: { min: -1, max: 1 }, C: { min: -1, max: 1 } });
    map = setChainLimits(map, id, { C: { min: 0, max: 0.5 } });
    expect(map[id].nodes["B"].limit).toBeUndefined();
    expect(chainLimits(map[id])).toEqual({ C: { min: 0, max: 0.5 } });
  });

  it("clears every limit", () => {
    let [map, id] = build();
    map = setChainLimits(map, id, { B: { min: -1, max: 1 } });
    map = clearLimits(map, id);
    expect(chainHasLimits(map[id])).toBe(false);
  });

  it("expandLimits unions pose bends into widening ranges", () => {
    const one = expandLimits({}, { B: 0.1, C: -0.2 });
    expect(one).toEqual({ B: { min: 0.1, max: 0.1 }, C: { min: -0.2, max: -0.2 } });
    const two = expandLimits(one, { B: -0.3, C: 0.4 });
    expect(two).toEqual({ B: { min: -0.3, max: 0.1 }, C: { min: -0.2, max: 0.4 } });
  });

  it("does not mutate its inputs", () => {
    const [map, id] = build();
    const snapshot = JSON.stringify(map);
    setChainLimits(map, id, { B: { min: 0, max: 1 } });
    clearLimits(map, id);
    expect(JSON.stringify(map)).toEqual(snapshot);
    const existing = { B: { min: 0, max: 1 } };
    expandLimits(existing, { B: 2 });
    expect(existing).toEqual({ B: { min: 0, max: 1 } });
  });
});

describe("display names (renameChain / renameNode)", () => {
  const build = () =>
    buildChain({}, ["R", "A", "B"], pos({ R: [0, 0], A: [10, 0], B: [20, 0] }), { R: 0, A: 0, B: 0 })!;

  it("sets and clears a chain name", () => {
    const [map, id] = build();
    const named = renameChain(map, id, "  Leg  ");
    expect(named[id].name).toBe("Leg"); // trimmed
    const cleared = renameChain(named, id, "   ");
    expect(cleared[id].name).toBeUndefined(); // whitespace clears
  });

  it("sets and clears a node name (any node incl. root)", () => {
    const [map, id] = build();
    let next = renameNode(map, "R", "Thigh");
    next = renameNode(next, "A", "Knee");
    expect(next[id].nodes["R"].name).toBe("Thigh");
    expect(next[id].nodes["A"].name).toBe("Knee");
    const cleared = renameNode(next, "A", "");
    expect(cleared[id].nodes["A"].name).toBeUndefined();
  });

  it("ignores unknown targets and does not mutate the input", () => {
    const [map, id] = build();
    expect(renameChain(map, "nope", "X")).toBe(map);
    expect(renameNode(map, "ghost", "X")).toBe(map);
    const snapshot = JSON.stringify(map);
    renameChain(map, id, "Leg");
    renameNode(map, "A", "Knee");
    expect(JSON.stringify(map)).toEqual(snapshot);
  });
});

describe("findChainForToken / deleteChain", () => {
  it("finds and deletes by id", () => {
    const [map, id] = createChain({}, "root");
    expect(findChainForToken(map, "root")?.id).toBe(id);
    expect(deleteChain(map, id)).toEqual({});
  });
});

describe("attachment (setParentNode / lifecycle)", () => {
  // Chain A: A0-A1-A2. Chain B: B0-B1 (distinct tokens).
  function twoChains(): ChainMap {
    let map = buildChain({}, ["A0", "A1", "A2"], pos({ A0: [0, 0], A1: [10, 0], A2: [20, 0] }), { A0: 0, A1: 0, A2: 0 })![0];
    map = buildChain(map, ["B0", "B1"], pos({ B0: [20, 5], B1: [30, 5] }), { B0: 0, B1: 0 })![0];
    return map;
  }
  const idOf = (m: ChainMap, root: string) => Object.values(m).find((c) => c.rootId === root)!.id;

  it("links a chain to a node of another chain", () => {
    const map = twoChains();
    const b = idOf(map, "B0");
    expect(setParentNode(map, b, "A2")[b].parentNodeId).toBe("A2");
  });

  it("rejects attaching to the same chain or a non-existent token", () => {
    const map = twoChains();
    const b = idOf(map, "B0");
    expect(setParentNode(map, b, "B1")).toBe(map); // same chain
    expect(setParentNode(map, b, "ghost")).toBe(map); // not a node anywhere
  });

  it("rejects a cycle", () => {
    let map = twoChains();
    const a = idOf(map, "A0");
    const b = idOf(map, "B0");
    map = setParentNode(map, a, "B1"); // A follows B
    expect(map[a].parentNodeId).toBe("B1");
    expect(setParentNode(map, b, "A2")).toBe(map); // B->A would cycle
  });

  it("detaches when the parent chain is deleted", () => {
    let map = twoChains();
    const a = idOf(map, "A0");
    const b = idOf(map, "B0");
    map = setParentNode(map, b, "A2");
    map = deleteChain(map, a);
    expect(map[b].parentNodeId).toBeUndefined();
  });

  it("detaches when the parent node is pruned away", () => {
    let map = twoChains();
    const b = idOf(map, "B0");
    map = setParentNode(map, b, "A2");
    map = pruneMissing(map, new Set(["A0", "A1", "B0", "B1"])); // A2 gone
    expect(map[b].parentNodeId).toBeUndefined();
  });

  it("lists descendant chains, nearest first", () => {
    let map = twoChains();
    const a = idOf(map, "A0");
    const b = idOf(map, "B0");
    map = setParentNode(map, b, "A1");
    expect(descendantChainIds(map, a)).toEqual([b]);
    expect(descendantChainIds(map, b)).toEqual([]);
  });

  it("resolves a shared anchor to the chain where it's a segment", () => {
    // A: A0-A1-A2. Sub-chain P rooted at the shared pivot A2: A2-P1.
    let map = buildChain({}, ["A0", "A1", "A2"], pos({ A0: [0, 0], A1: [10, 0], A2: [20, 0] }), { A0: 0, A1: 0, A2: 0 })![0];
    map = buildChain(map, ["A2", "P1"], pos({ A2: [20, 0], P1: [20, 10] }), { A2: 0, P1: 0 })![0];
    // A2 is a non-root segment of A and the root of P -> resolves to A.
    expect(findChainForToken(map, "A2")!.id).toBe(idOf(map, "A0"));
  });
});
