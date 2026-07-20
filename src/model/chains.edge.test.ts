/**
 * Chain-model EDGE CASES & interactions not covered by chains.test.ts: cycle
 * guards, id uniqueness, ease-ramp monotonicity, limitability transitions when
 * toggling limb mode, descendant diamonds, and no-op guards.
 */
import { describe, it, expect } from "vitest";
import { type ChainMap, type Vec2, STIFFNESS_ORDER } from "../types";
import {
  buildChain,
  createChain,
  deleteChain,
  descendantChainIds,
  disableSegmentRig,
  effectiveStiffness,
  enableSegmentRig,
  findChainForToken,
  isLimitable,
  isSegmentRig,
  limitableTokens,
  orderedNodes,
  parentChainId,
  removeToken,
  setNodeStiffness,
  setParentNode,
  unionRange,
  updateSettings,
} from "./chains";

const pos = (o: Record<string, [number, number]>): Record<string, Vec2> =>
  Object.fromEntries(Object.entries(o).map(([k, [x, y]]) => [k, { x, y }]));
const rot0 = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, 0]));
const idOf = (m: ChainMap, root: string) => Object.values(m).find((c) => c.rootId === root)!.id;
const chainN = (ids: string[]): ChainMap =>
  buildChain({}, ids, pos(Object.fromEntries(ids.map((id, i) => [id, [i * 10, 0]]))), rot0(ids))![0];

describe("createChain id uniqueness", () => {
  it("keeps ids unique across many builds", () => {
    let map: ChainMap = {};
    for (let i = 0; i < 30; i++) [map] = createChain(map, `tok${i}`);
    expect(new Set(Object.keys(map)).size).toBe(30);
  });

  it("keeps ids unique when tokens share a 6-char prefix", () => {
    let map: ChainMap = {};
    [map] = createChain(map, "PREFIX-aaaa");
    [map] = createChain(map, "PREFIX-bbbb");
    [map] = createChain(map, "PREFIX-cccc");
    expect(new Set(Object.keys(map)).size).toBe(3);
  });

  it("does not reuse a live chain's id after a same-prefix delete", () => {
    let map: ChainMap = {};
    [map] = createChain(map, "SAME-1");
    const [m2, id2] = createChain(map, "SAME-2");
    map = m2;
    [map] = createChain(map, "SAME-3");
    // Delete the first, then add another sharing the prefix; id2 must survive intact.
    map = deleteChain(map, idOf(map, "SAME-1"));
    const [m4] = createChain(map, "SAME-4");
    expect(m4[id2]).toBeDefined();
    expect(new Set(Object.keys(m4)).size).toBe(Object.keys(m4).length);
  });
});

describe("orderedNodes robustness", () => {
  it("terminates on a self-parent loop", () => {
    const map = chainN(["R", "A"]);
    const id = Object.keys(map)[0];
    map[id].nodes["R"].parentId = "R"; // corrupt: root parents itself
    const order = orderedNodes(map[id]);
    expect(order[0]).toBe("R");
    expect(new Set(order).size).toBe(order.length);
  });

  it("ignores a node whose parent isn't reachable from the root", () => {
    const map = chainN(["R", "A", "B"]);
    const id = Object.keys(map)[0];
    map[id].nodes["B"].parentId = "ghost"; // B detached from the strand
    expect(orderedNodes(map[id])).toEqual(["R", "A"]);
  });
});

describe("setParentNode cycle guard (multi-level)", () => {
  it("rejects a 3-chain cycle A→B→C→A", () => {
    let map = chainN(["A0", "A1"]);
    map = buildChain(map, ["B0", "B1"], pos({ B0: [0, 5], B1: [10, 5] }), rot0(["B0", "B1"]))![0];
    map = buildChain(map, ["C0", "C1"], pos({ C0: [0, 10], C1: [10, 10] }), rot0(["C0", "C1"]))![0];
    const a = idOf(map, "A0"), b = idOf(map, "B0"), c = idOf(map, "C0");
    map = setParentNode(map, a, "B1"); // A follows B
    map = setParentNode(map, b, "C1"); // B follows C
    expect(map[a].parentNodeId).toBe("B1");
    expect(map[b].parentNodeId).toBe("C1");
    // C → A would close the loop A→B→C→A: must be rejected.
    const attempt = setParentNode(map, c, "A1");
    expect(attempt).toBe(map);
    expect(map[c].parentNodeId).toBeUndefined();
  });

  it("allows re-parenting that does NOT form a cycle", () => {
    let map = chainN(["A0", "A1"]);
    map = buildChain(map, ["B0", "B1"], pos({ B0: [0, 5], B1: [10, 5] }), rot0(["B0", "B1"]))![0];
    const a = idOf(map, "A0");
    map = setParentNode(map, a, "B1"); // A→B, fine
    expect(map[a].parentNodeId).toBe("B1");
  });
});

describe("descendant diamonds / multi-follow", () => {
  it("lists two chains that both follow the same parent node", () => {
    let map = chainN(["A0", "A1", "A2"]);
    map = buildChain(map, ["B0", "B1"], pos({ B0: [0, 5], B1: [10, 5] }), rot0(["B0", "B1"]))![0];
    map = buildChain(map, ["C0", "C1"], pos({ C0: [0, 9], C1: [10, 9] }), rot0(["C0", "C1"]))![0];
    const a = idOf(map, "A0"), b = idOf(map, "B0"), c = idOf(map, "C0");
    map = setParentNode(map, b, "A1");
    map = setParentNode(map, c, "A1");
    const desc = descendantChainIds(map, a);
    expect(new Set(desc)).toEqual(new Set([b, c]));
    expect(parentChainId(map, b)).toBe(a);
    expect(parentChainId(map, c)).toBe(a);
  });
});

describe("ease-ramp monotonicity", () => {
  it("is non-increasing base→tip for chains of many lengths", () => {
    for (let n = 2; n <= 8; n++) {
      const ids = Array.from({ length: n }, (_, i) => `N${i}`);
      let map = chainN(ids);
      const id = Object.keys(map)[0];
      map = updateSettings(map, id, { ease: true });
      const order = orderedNodes(map[id]);
      let prev = STIFFNESS_ORDER.length; // higher than any index
      for (let i = 1; i < order.length; i++) {
        const level = STIFFNESS_ORDER.indexOf(effectiveStiffness(map[id], order[i]));
        expect(level).toBeLessThanOrEqual(prev); // stiffer(=higher) at base, easing down
        prev = level;
      }
    }
  });
});

describe("limitability transitions with limb mode", () => {
  it("centre rig: 3rd token onward; limb rig: every non-root; back to centre on disable", () => {
    const ids = ["R", "A", "B", "C"];
    let map = chainN(ids);
    const id = Object.keys(map)[0];
    expect(limitableTokens(map[id])).toEqual(["B", "C"]);

    map = enableSegmentRig(map, id, pos({ R: [0, 0], A: [10, 0], B: [20, 0], C: [30, 0] }), rot0(ids));
    expect(isSegmentRig(map[id])).toBe(true);
    expect(limitableTokens(map[id])).toEqual(["A", "B", "C"]);
    expect(isLimitable(map[id], "A")).toBe(true);

    map = disableSegmentRig(map, id);
    expect(limitableTokens(map[id])).toEqual(["B", "C"]); // reverts
    expect(isLimitable(map[id], "A")).toBe(false);
  });

  it("removeToken on a limb rig keeps the surviving nodes' capture intact", () => {
    const ids = ["R", "A", "B", "C"];
    let map = chainN(ids);
    const id = Object.keys(map)[0];
    map = enableSegmentRig(map, id, pos({ R: [0, 0], A: [10, 0], B: [20, 0], C: [30, 0] }), rot0(ids));
    // Drop the tail C; the remaining R-A-B must still be a valid segment rig.
    const next = removeToken(map, "C");
    const nid = Object.keys(next)[0];
    expect(orderedNodes(next[nid])).toEqual(["R", "A", "B"]);
    expect(isSegmentRig(next[nid])).toBe(true);
    for (const t of ["R", "A", "B"]) expect(next[nid].nodes[t].seg).toBeDefined();
  });

  it("a partially-captured segment rig is treated as a centre rig by isSegmentRig", () => {
    const ids = ["R", "A", "B"];
    let map = chainN(ids);
    const id = Object.keys(map)[0];
    map = enableSegmentRig(map, id, pos({ R: [0, 0], A: [10, 0], B: [20, 0] }), rot0(ids));
    delete map[id].nodes["B"].seg; // corrupt: one node lost its capture
    expect(isSegmentRig(map[id])).toBe(false);
    expect(limitableTokens(map[id])).toEqual(["B"]); // centre-rig rule (i>=2)
  });
});

describe("unionRange", () => {
  // Contract: union of WELL-ORDERED intervals (poseRange and prior unions always
  // yield min<=max), so only ordered inputs are exercised — matching real usage.
  it("widens a well-ordered interval across positive & negative extremes", () => {
    expect(unionRange({ min: -0.2, max: 0.3 }, { min: -0.5, max: 0.1 })).toEqual({ min: -0.5, max: 0.3 });
    expect(unionRange({ min: 0, max: 0 }, { min: 0.4, max: 0.4 })).toEqual({ min: 0, max: 0.4 });
    expect(unionRange({ min: 0, max: 0 }, { min: -0.4, max: -0.4 })).toEqual({ min: -0.4, max: 0 });
    expect(unionRange(null, { min: 0.1, max: 0.1 })).toEqual({ min: 0.1, max: 0.1 });
    expect(unionRange(undefined, { min: -0.2, max: 0.5 })).toEqual({ min: -0.2, max: 0.5 });
  });
});

describe("no-op guards leave the map identity unchanged", () => {
  it("setNodeStiffness on root / unknown token, removeToken unknown, setParentNode missing chain", () => {
    const map = chainN(["R", "A", "B"]);
    expect(setNodeStiffness(map, "R", "stiff")).toBe(map);
    expect(setNodeStiffness(map, "ghost", "stiff")).toBe(map);
    expect(removeToken(map, "ghost")).toBe(map);
    expect(setParentNode(map, "no-such-chain", "R")).toBe(map);
    expect(updateSettings(map, "no-such-chain", { autoRotate: false })).toBe(map);
  });

  it("findChainForToken returns undefined for a token in no chain", () => {
    expect(findChainForToken(chainN(["R", "A"]), "nope")).toBeUndefined();
  });
});
