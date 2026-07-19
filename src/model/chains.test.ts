import { describe, it, expect } from "vitest";
import type { ChainMap, Vec2 } from "../types";
import {
  buildChain,
  createChain,
  deleteChain,
  descendantChainIds,
  findChainForToken,
  effectiveStiffness,
  orderedNodes,
  pruneMissing,
  removeToken,
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
  });

  it("rejects fewer than two tokens or duplicate ids", () => {
    expect(buildChain({}, ["R"], POS, ROT)).toBeNull();
    expect(buildChain({}, ["R", "R"], POS, ROT)).toBeNull();
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
