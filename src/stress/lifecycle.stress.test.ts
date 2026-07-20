/**
 * LIFECYCLE / INTERACTION storms: rapid build/delete churn, shared-pivot chaos,
 * attach→delete cascades, prune extremes, cross-layer filtering contract, and
 * limb-mode toggle churn. Asserts structural coherence survives every sequence.
 */
import { describe, it, expect } from "vitest";
import type { ChainMap } from "../types";
import { TOKEN_LAYERS } from "../obr/constants";
import {
  buildChain,
  deleteChain,
  descendantChainIds,
  disableSegmentRig,
  enableSegmentRig,
  findChainForToken,
  isSegmentRig,
  orderedNodes,
  parentChainId,
  pruneMissing,
  removeToken,
  resetJointPivots,
  setJointPivot,
  setParentNode,
} from "../model/chains";
import { idOf, pos, rot0 } from "./helpers";

const line = (map: ChainMap, ids: string[], y = 0): ChainMap =>
  buildChain(map, ids, pos(Object.fromEntries(ids.map((id, i) => [id, [i * 10, y]]))), rot0(ids))![0];

describe("rapid build/delete churn keeps ids unique & map coherent", () => {
  it("100 rounds of build-then-delete on the same token ids leaves an empty, valid map", () => {
    let map: ChainMap = {};
    for (let i = 0; i < 100; i++) {
      map = line(map, ["A", "B", "C"]);
      const id = idOf(map, "A");
      // Every chain is walkable and starts at its root.
      for (const c of Object.values(map)) expect(orderedNodes(c)[0]).toBe(c.rootId);
      map = deleteChain(map, id);
    }
    expect(map).toEqual({});
  });

  it("interleaved builds with reused ids never collide", () => {
    let map: ChainMap = {};
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      map = line(map, [`p${i % 5}`, `q${i % 5}`]); // ids recycle every 5 rounds
      for (const cid of Object.keys(map)) seen.add(cid);
      expect(new Set(Object.keys(map)).size).toBe(Object.keys(map).length);
      if (i % 3 === 0 && Object.keys(map).length) map = deleteChain(map, Object.keys(map)[0]);
    }
  });
});

describe("shared-pivot chaos", () => {
  // Arm A: A0-A1-A2. Sub-chains P and Q both rooted at the SHARED pivot A2.
  function sharedRig(): ChainMap {
    let map = line({}, ["A0", "A1", "A2"]);
    map = buildChain(map, ["A2", "P1"], pos({ A2: [20, 0], P1: [20, 10] }), rot0(["A2", "P1"]))![0];
    map = buildChain(map, ["A2", "Q1"], pos({ A2: [20, 0], Q1: [30, 0] }), rot0(["A2", "Q1"]))![0];
    return map;
  }

  it("findChainForToken prefers the chain where the token is a real segment", () => {
    const map = sharedRig();
    // A2 is a non-root segment of A and the root of P and Q → resolves to A.
    expect(findChainForToken(map, "A2")!.rootId).toBe("A0");
  });

  it("removing the shared pivot via its owning chain stays coherent", () => {
    const map = sharedRig();
    const next = removeToken(map, "A2"); // resolves to chain A, truncates it at A1
    for (const c of Object.values(next)) {
      const order = orderedNodes(c);
      expect(order[0]).toBe(c.rootId);
      expect(new Set(order).size).toBe(order.length);
    }
    // Chain A truncated to A0-A1.
    const a = Object.values(next).find((c) => c.rootId === "A0");
    expect(a && orderedNodes(a)).toEqual(["A0", "A1"]);
  });

  it("a token that is a segment of three chains resolves & prunes sanely", () => {
    // X is a mid-segment of three separate arms.
    let map = line({}, ["X", "m1"], 0);
    map = buildChain(map, ["r2", "X", "m2"], pos({ r2: [-10, 5], X: [0, 5], m2: [10, 5] }), rot0(["r2", "X", "m2"]))![0];
    map = buildChain(map, ["r3", "X", "m3"], pos({ r3: [-10, 9], X: [0, 9], m3: [10, 9] }), rot0(["r3", "X", "m3"]))![0];
    // X is a non-root segment in two of them → findChainForToken returns one of those.
    const owner = findChainForToken(map, "X");
    expect(owner && owner.rootId !== "X").toBe(true);
    // Pruning X out everywhere leaves each chain truncated coherently.
    const existing = new Set(Object.values(map).flatMap((c) => Object.keys(c.nodes)).filter((t) => t !== "X"));
    const pruned = pruneMissing(map, existing);
    for (const c of Object.values(pruned)) {
      expect(orderedNodes(c).includes("X")).toBe(false);
      expect(orderedNodes(c)[0]).toBe(c.rootId);
    }
  });
});

describe("attach → delete → re-attach cascades", () => {
  it("deleting a mid-forest chain detaches its followers, re-attach works", () => {
    let map = line({}, ["A0", "A1"]);
    map = line(map, ["B0", "B1"], 5);
    map = line(map, ["C0", "C1"], 9);
    const a = idOf(map, "A0"), b = idOf(map, "B0"), c = idOf(map, "C0");
    map = setParentNode(map, b, "A1"); // B→A
    map = setParentNode(map, c, "B1"); // C→B
    expect(descendantChainIds(map, a).sort()).toEqual([b, c].sort());
    // Delete B (the middle): C loses its parent node -> detaches.
    map = deleteChain(map, b);
    expect(map[c].parentNodeId).toBeUndefined();
    expect(descendantChainIds(map, a)).toEqual([]);
    // Re-attach C directly to A.
    map = setParentNode(map, c, "A1");
    expect(descendantChainIds(map, a)).toEqual([c]);
  });

  it("100 attach/detach toggles converge to a clean state", () => {
    let map = line({}, ["A0", "A1"]);
    map = line(map, ["B0", "B1"], 5);
    const b = idOf(map, "B0");
    for (let i = 0; i < 100; i++) {
      map = setParentNode(map, b, i % 2 === 0 ? "A1" : null);
    }
    // Last op was detach (i=99 odd → null).
    expect(map[b].parentNodeId).toBeUndefined();
    expect(parentChainId(map, b)).toBeUndefined();
  });
});

describe("prune extremes", () => {
  it("pruneMissing with an empty scene wipes everything", () => {
    let map = line({}, ["A0", "A1", "A2"]);
    map = line(map, ["B0", "B1"], 5);
    expect(pruneMissing(map, new Set<string>())).toEqual({});
  });

  it("pruneMissing keeps a lone surviving root (in-progress chain)", () => {
    const map = line({}, ["A0", "A1", "A2"]);
    const pruned = pruneMissing(map, new Set(["A0"])); // only the root remains
    expect(orderedNodes(Object.values(pruned)[0])).toEqual(["A0"]);
  });

  it("removeToken one-at-a-time down to nothing", () => {
    let map = line({}, ["A0", "A1", "A2", "A3"]);
    map = removeToken(map, "A3");
    map = removeToken(map, "A2");
    map = removeToken(map, "A1");
    expect(orderedNodes(Object.values(map)[0])).toEqual(["A0"]);
    map = removeToken(map, "A0"); // removing the root drops the chain
    expect(map).toEqual({});
  });
});

describe("limb-mode toggle churn", () => {
  it("enable/pivot-drag/reset/disable/re-enable stays a valid rig", () => {
    let map = line({}, ["R", "A", "B", "C"]);
    const id = idOf(map, "R");
    const P = pos({ R: [0, 0], A: [10, 0], B: [20, 0], C: [30, 0] });
    const ROT = rot0(["R", "A", "B", "C"]);
    for (let i = 0; i < 25; i++) {
      map = enableSegmentRig(map, id, P, ROT);
      expect(isSegmentRig(map[id])).toBe(true);
      map = setJointPivot(map, id, (i % 4), { x: 5 + i, y: (i % 3) - 1 }, P, ROT);
      map = resetJointPivots(map, id, P, ROT);
      map = disableSegmentRig(map, id);
      expect(isSegmentRig(map[id])).toBe(false);
    }
    // boneOffsetDeg for the default rig is untouched across all the churn.
    expect(map[id].nodes["A"].boneOffsetDeg).toBeCloseTo(0, 6);
  });
});

describe("cross-layer 'wrong pieces' filter contract (TOKEN_LAYERS)", () => {
  it("only CHARACTER/MOUNT/PROP/ATTACHMENT are riggable; fog/drawing/etc excluded", () => {
    for (const ok of ["CHARACTER", "MOUNT", "PROP", "ATTACHMENT"]) expect(TOKEN_LAYERS.has(ok)).toBe(true);
    for (const no of ["FOG", "DRAWING", "GRID", "TEXT", "NOTE", "POINTER", "RULER", "MAP", "POPOVER", "CONTROL"]) {
      expect(TOKEN_LAYERS.has(no)).toBe(false);
    }
  });
});
