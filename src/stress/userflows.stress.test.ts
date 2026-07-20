/**
 * USER-FLOW stress: the exact sequences a user drives from the popover, run
 * through the REAL model functions in the same composition SidebarApp uses —
 * adversarial selections (mixed chained/unchained/anchor), double-root anchoring,
 * rebuild-to-recapture, and limb-mode ↔ bend-limit interactions. The goal is to
 * surface anything a user could do that leaves the map incoherent or crashes.
 */
import { describe, it, expect } from "vitest";
import type { ChainMap } from "../types";
import {
  buildChain,
  clearLimits,
  deleteChain,
  descendantChainIds,
  disableSegmentRig,
  enableSegmentRig,
  findChainForToken,
  isLimitable,
  isSegmentRig,
  orderedNodes,
  setDefaultLimit,
  setNodeLimit,
  setParentNode,
} from "../model/chains";
import { pos, rot0 } from "./helpers";

// Faithful mirror of SidebarApp.onNewChain's planning (positions/rotations elided
// to a fixed grid). Returns the resulting map + what it decided, or an error tag.
const GRID = pos(Object.fromEntries("ABCDEFGHIJ".split("").map((c, i) => [c, [i * 10, (i % 2) * 5]])));
const GROT = rot0("ABCDEFGHIJ".split(""));
function onNewChain(chains: ChainMap, selected: string[]):
  | { error: string }
  | { map: ChainMap; buildIds: string[]; anchor: string | null } {
  const ids = selected;
  if (ids.length < 2) return { error: "need-2-selected" };
  const anchor = findChainForToken(chains, ids[0]) ? ids[0] : null;
  const rest = (anchor ? ids.slice(1) : ids).filter((id) => !findChainForToken(chains, id));
  const buildIds = anchor ? [anchor, ...rest] : rest;
  if (buildIds.length < 2) return { error: "need-2-buildable" };
  const built = buildChain(chains, buildIds, GRID, GROT);
  if (!built) return { error: "build-failed" };
  const next = anchor ? setParentNode(built[0], built[1], anchor) : built[0];
  return { map: next, buildIds, anchor };
}

function coherent(map: ChainMap): void {
  for (const [cid, c] of Object.entries(map)) {
    expect(c.id).toBe(cid);
    expect(c.rootId in c.nodes).toBe(true);
    const order = orderedNodes(c);
    expect(order[0]).toBe(c.rootId);
    expect(new Set(order).size).toBe(order.length);
    expect(descendantChainIds(map, cid).includes(cid)).toBe(false);
  }
}

describe("selection → build: adversarial selections", () => {
  const armAB = (): ChainMap => buildChain({}, ["A", "B", "C"], GRID, GROT)![0];

  it("two unchained tokens → a plain 2..3 chain", () => {
    const res = onNewChain({}, ["D", "E"]);
    expect("map" in res && res.anchor).toBe(null);
    if ("map" in res) { coherent(res.map); expect(res.buildIds).toEqual(["D", "E"]); }
  });

  it("only one selected token → rejected", () => {
    expect(onNewChain({}, ["D"])).toEqual({ error: "need-2-selected" });
  });

  it("anchor (a chain SEGMENT) + one new → sub-chain attached to the anchor", () => {
    const map = armAB();
    const res = onNewChain(map, ["B", "D"]); // B is a mid-segment of the arm
    expect("map" in res).toBe(true);
    if ("map" in res) {
      coherent(res.map);
      expect(res.anchor).toBe("B");
      const sub = findChainForToken(res.map, "D")!;
      expect(sub.parentNodeId).toBe("B");
    }
  });

  it("two ALREADY-chained tokens → nothing buildable, rejected", () => {
    const map = armAB();
    expect(onNewChain(map, ["A", "B"])).toEqual({ error: "need-2-buildable" });
    expect(onNewChain(map, ["B", "C"])).toEqual({ error: "need-2-buildable" });
  });

  it("unchained-first with a chained token mixed in → chained one is silently skipped", () => {
    const map = armAB();
    // First token D is unchained → no anchor; the chained B is filtered from rest.
    const res = onNewChain(map, ["D", "B", "E"]);
    expect("map" in res).toBe(true);
    if ("map" in res) {
      expect(res.anchor).toBe(null);
      expect(res.buildIds).toEqual(["D", "E"]); // B dropped, no crash
      coherent(res.map);
    }
  });

  it("anchor + all-others-already-chained → rejected (no lone-anchor chain)", () => {
    let map = buildChain({}, ["A", "B", "C"], GRID, GROT)![0]; // A,B,C chained
    map = buildChain(map, ["D", "E"], GRID, GROT)![0];         // D,E chained
    // Select B (anchor) then D (chained) → rest filters D out → buildIds=[B] len1.
    expect(onNewChain(map, ["B", "D"])).toEqual({ error: "need-2-buildable" });
  });

  it("anchoring on another chain's ROOT creates a coherent (if unusual) double-root", () => {
    const map = armAB(); // root = A
    const res = onNewChain(map, ["A", "D"]); // A is chain1's ROOT, used as anchor
    expect("map" in res).toBe(true);
    if ("map" in res) {
      coherent(res.map); // MUST stay coherent even though A now roots two chains
      // A is now the root of the original arm AND the new sub-chain.
      const rooted = Object.values(res.map).filter((c) => c.rootId === "A");
      expect(rooted.length).toBe(2);
      // The sub-chain follows A (resolving to the original arm), so it's a descendant.
      const arm = Object.values(res.map).find((c) => orderedNodes(c).length === 3)!;
      expect(descendantChainIds(res.map, arm.id).length).toBe(1);
    }
  });
});

describe("rebuild-to-recapture flow (the 'delete + New chain' guidance)", () => {
  it("delete then rebuild the same tokens yields a fresh, coherent chain", () => {
    let map = buildChain({}, ["A", "B", "C"], GRID, GROT)![0];
    const id1 = Object.keys(map)[0];
    map = deleteChain(map, id1);
    expect(map).toEqual({});
    const res = onNewChain(map, ["A", "B", "C"]);
    expect("map" in res).toBe(true);
    if ("map" in res) {
      coherent(res.map);
      const c = Object.values(res.map)[0];
      // The root captured its own boneOffsetDeg on rebuild (the #26 fix).
      expect(c.nodes["A"].boneOffsetDeg).not.toBeUndefined();
    }
  });
});

describe("limb-mode ↔ bend-limit interaction a user would hit", () => {
  it("capture a limb-elbow limit, then disable limb mode: the joint set narrows, no crash", () => {
    const ids = ["A", "B", "C", "D"];
    let map = buildChain({}, ids, GRID, GROT)![0];
    const id = Object.keys(map)[0];
    map = enableSegmentRig(map, id, GRID, GROT);
    // In limb mode the FIRST movable segment (B) is limitable — set a limit there.
    expect(isLimitable(map[id], "B")).toBe(true);
    map = setNodeLimit(map, id, "B", { min: -0.3, max: 0.3 });
    expect(map[id].nodes["B"].limit).toEqual({ min: -0.3, max: 0.3 });
    // Now leave limb mode: B is no longer limitable (centre rig needs i>=2), but the
    // stored limit is harmless (never consulted for a non-limitable joint).
    map = disableSegmentRig(map, id);
    expect(isSegmentRig(map[id])).toBe(false);
    expect(isLimitable(map[id], "B")).toBe(false);
    expect(map[id].nodes["B"].limit).toEqual({ min: -0.3, max: 0.3 }); // stays put, inert
    // Clear-all still wipes it cleanly.
    map = clearLimits(map, id);
    expect(map[id].nodes["B"].limit).toBeUndefined();
  });

  it("set a chain default limit, enable limb mode, capture per-joint — both coexist", () => {
    const ids = ["A", "B", "C", "D"];
    let map = buildChain({}, ids, GRID, GROT)![0];
    const id = Object.keys(map)[0];
    map = setDefaultLimit(map, id, { min: -1, max: 1 });
    map = enableSegmentRig(map, id, GRID, GROT);
    map = setNodeLimit(map, id, "C", { min: -0.2, max: 0.2 });
    // C uses its override; B falls back to the chain default; both limitable in limb.
    expect(isLimitable(map[id], "B")).toBe(true);
    expect(map[id].nodes["C"].limit).toEqual({ min: -0.2, max: 0.2 });
    expect(map[id].settings.defaultLimit).toEqual({ min: -1, max: 1 });
  });
});

describe("attach then build overlapping — token appears in a later build", () => {
  it("building a new chain that reuses an attached chain's token stays coherent", () => {
    let map = buildChain({}, ["A", "B"], GRID, GROT)![0];
    map = buildChain(map, ["C", "D"], GRID, GROT)![0];
    map = setParentNode(map, findChainForToken(map, "C")!.id, "B"); // C-chain follows B
    // Now the user anchor-builds off C (a root that's also a follower).
    const res = onNewChain(map, ["C", "E"]);
    expect("map" in res).toBe(true);
    if ("map" in res) coherent(res.map);
  });
});
