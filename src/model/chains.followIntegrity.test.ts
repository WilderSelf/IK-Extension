/**
 * Follow-link integrity through the model lifecycle.
 *
 * REGRESSION: `detachDangling` (run by removeToken / deleteChain / pruneMissing)
 * used "not a node of any chain" as its staleness test, which wrongly matched
 * every BARE parent token — so any prune / remove / delete silently severed
 * arms-attached-to-bodies (the reactive-follow feature, #34). The background
 * prune handler fires on any scene change with a missing token, so in practice
 * deleting *any* token detached every bare-attached chain.
 */
import { describe, it, expect } from "vitest";
import type { ChainMap, Vec2 } from "../types";
import {
  buildChain,
  deleteChain,
  pruneMissing,
  removeToken,
  setParentNode,
} from "./chains";

const pos = (o: Record<string, [number, number]>): Record<string, Vec2> =>
  Object.fromEntries(Object.entries(o).map(([k, [x, y]]) => [k, { x, y }]));
const rot0 = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, 0]));
const idOf = (m: ChainMap, root: string) => Object.values(m).find((c) => c.rootId === root)!.id;

// Arm chain A0-A1 following a BARE body token "BODY" (not part of any chain),
// plus an unrelated chain Z0-Z1. `all` is a realistic full scene-id set.
function scene(): { map: ChainMap; aId: string; zId: string; all: Set<string> } {
  let map = buildChain({}, ["A0", "A1"], pos({ A0: [10, 0], A1: [20, 0] }), rot0(["A0", "A1"]))![0];
  const aId = idOf(map, "A0");
  map = setParentNode(map, aId, "BODY");
  map = buildChain(map, ["Z0", "Z1"], pos({ Z0: [0, 0], Z1: [10, 0] }), rot0(["Z0", "Z1"]))![0];
  const zId = idOf(map, "Z0");
  return { map, aId, zId, all: new Set(["A0", "A1", "Z0", "Z1", "BODY"]) };
}

describe("bare-parent follow link survives lifecycle ops", () => {
  it("survives pruneMissing while the bare body still exists in the scene", () => {
    const { map, aId, all } = scene();
    const next = pruneMissing(map, all);
    expect(next[aId]?.parentNodeId).toBe("BODY");
  });

  it("survives pruneMissing that truncates an UNRELATED chain", () => {
    const { map, aId } = scene();
    // Z1 deleted from the scene (BODY still present) -> Z truncates, A untouched.
    const next = pruneMissing(map, new Set(["A0", "A1", "Z0", "BODY"]));
    expect(next[aId]?.parentNodeId).toBe("BODY");
  });

  it("survives deleting an unrelated chain", () => {
    const { map, aId, zId } = scene();
    const next = deleteChain(map, zId);
    expect(next[aId]?.parentNodeId).toBe("BODY");
  });

  it("survives removeToken on an unrelated chain", () => {
    const { map, aId } = scene();
    const next = removeToken(map, "Z1");
    expect(next[aId]?.parentNodeId).toBe("BODY");
  });

  it("survives removeToken truncating its OWN chain's tail", () => {
    // Arm A0-A1-A2 on BODY; drop the tail A2. The follow link must remain.
    let map = buildChain({}, ["A0", "A1", "A2"], pos({ A0: [0, 0], A1: [10, 0], A2: [20, 0] }), rot0(["A0", "A1", "A2"]))![0];
    const aId = idOf(map, "A0");
    map = setParentNode(map, aId, "BODY");
    const next = removeToken(map, "A2");
    expect(next[aId]?.parentNodeId).toBe("BODY");
  });
});

describe("stale follow links ARE cleaned when genuinely gone", () => {
  it("detaches a bare parent that was deleted from the scene (prune, scene-aware)", () => {
    const { map, aId } = scene();
    // BODY absent from the scene id set -> its body sprite was deleted.
    const next = pruneMissing(map, new Set(["A0", "A1", "Z0", "Z1"]));
    expect(next[aId]?.parentNodeId).toBeUndefined();
  });

  it("still detaches when the parent CHAIN NODE is deleted", () => {
    // B follows A2 (a real chain node). Deleting chain A must detach B.
    let map = buildChain({}, ["A0", "A1", "A2"], pos({ A0: [0, 0], A1: [10, 0], A2: [20, 0] }), rot0(["A0", "A1", "A2"]))![0];
    map = buildChain(map, ["B0", "B1"], pos({ B0: [20, 5], B1: [30, 5] }), rot0(["B0", "B1"]))![0];
    const aId = idOf(map, "A0");
    const bId = idOf(map, "B0");
    map = setParentNode(map, bId, "A2");
    map = deleteChain(map, aId);
    expect(map[bId]?.parentNodeId).toBeUndefined();
  });

  it("still detaches when the parent chain node is pruned away", () => {
    let map = buildChain({}, ["A0", "A1", "A2"], pos({ A0: [0, 0], A1: [10, 0], A2: [20, 0] }), rot0(["A0", "A1", "A2"]))![0];
    map = buildChain(map, ["B0", "B1"], pos({ B0: [20, 5], B1: [30, 5] }), rot0(["B0", "B1"]))![0];
    const bId = idOf(map, "B0");
    map = setParentNode(map, bId, "A2");
    // A2 gone from the scene -> A truncates to A0-A1, B's link to A2 is stale.
    map = pruneMissing(map, new Set(["A0", "A1", "B0", "B1"]));
    expect(map[bId]?.parentNodeId).toBeUndefined();
  });

  it("chain-node follow (not bare) is untouched by an unrelated prune", () => {
    // B follows A1 (a surviving node). An unrelated prune must keep the link.
    let map = buildChain({}, ["A0", "A1", "A2"], pos({ A0: [0, 0], A1: [10, 0], A2: [20, 0] }), rot0(["A0", "A1", "A2"]))![0];
    map = buildChain(map, ["B0", "B1"], pos({ B0: [10, 5], B1: [20, 5] }), rot0(["B0", "B1"]))![0];
    const bId = idOf(map, "B0");
    map = setParentNode(map, bId, "A1");
    const next = pruneMissing(map, new Set(["A0", "A1", "A2", "B0", "B1"]));
    expect(next[bId]?.parentNodeId).toBe("A1");
  });

  it("multiple bare-attached chains all survive an unrelated delete", () => {
    let map = buildChain({}, ["A0", "A1"], pos({ A0: [10, 0], A1: [20, 0] }), rot0(["A0", "A1"]))![0];
    map = buildChain(map, ["B0", "B1"], pos({ B0: [10, 10], B1: [20, 10] }), rot0(["B0", "B1"]))![0];
    map = buildChain(map, ["Z0", "Z1"], pos({ Z0: [0, 0], Z1: [5, 0] }), rot0(["Z0", "Z1"]))![0];
    const aId = idOf(map, "A0");
    const bId = idOf(map, "B0");
    const zId = idOf(map, "Z0");
    map = setParentNode(map, aId, "BODY");
    map = setParentNode(map, bId, "BODY");
    map = deleteChain(map, zId);
    expect(map[aId]?.parentNodeId).toBe("BODY");
    expect(map[bId]?.parentNodeId).toBe("BODY");
  });

  it("does not mutate its input map", () => {
    const { map } = scene();
    const snapshot = JSON.stringify(map);
    pruneMissing(map, new Set(["A0"]));
    deleteChain(map, idOf(map, "Z0"));
    removeToken(map, "A1");
    expect(JSON.stringify(map)).toBe(snapshot);
  });
});
