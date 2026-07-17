import { describe, expect, it } from "vitest";
import type { ChainMap } from "../types";
import {
  addNode,
  createChain,
  deleteChain,
  findChainForToken,
  pruneMissing,
  recalibrate,
  removeToken,
  setNodeOverride,
  updateSettings,
} from "./chains";

function build(): ChainMap {
  let [m, id] = createChain({}, "body");
  m = addNode(m, id, "a1", "body", 10);
  m = addNode(m, id, "a2", "a1", 10);
  m = addNode(m, id, "b1", "body", 10);
  return m;
}

describe("chain model", () => {
  it("creates a chain rooted at the token", () => {
    const [m, id] = createChain({}, "body");
    expect(m[id].rootId).toBe("body");
    expect(m[id].nodes.body.parentId).toBeNull();
  });

  it("finds the chain for a token", () => {
    const m = build();
    expect(findChainForToken(m, "a2")?.rootId).toBe("body");
    expect(findChainForToken(m, "nope")).toBeUndefined();
  });

  it("removing the root deletes the whole chain", () => {
    const m = build();
    expect(Object.keys(removeToken(m, "body"))).toHaveLength(0);
  });

  it("removing an interior node re-parents its children", () => {
    const m = removeToken(build(), "a1");
    const chain = Object.values(m)[0];
    expect(chain.nodes.a2.parentId).toBe("body");
    expect(chain.nodes.a1).toBeUndefined();
  });

  it("pruneMissing drops chains referencing deleted tokens", () => {
    const m = build();
    // a1 deleted -> a2 reparents to body, chain survives (3 nodes)
    const pruned = pruneMissing(m, new Set(["body", "a2", "b1"]));
    const chain = Object.values(pruned)[0];
    expect(chain.nodes.a2.parentId).toBe("body");
    // root deleted -> chain removed entirely
    expect(Object.keys(pruneMissing(m, new Set(["a1", "a2", "b1"])))).toHaveLength(0);
  });

  it("recalibrate re-measures rest lengths", () => {
    const m = build();
    const positions = {
      body: { x: 0, y: 0 },
      a1: { x: 3, y: 4 }, // distance 5
      a2: { x: 3, y: 4 },
      b1: { x: 0, y: 0 },
    };
    const chainId = Object.keys(m)[0];
    const r = recalibrate(m, chainId, positions);
    expect(r[chainId].nodes.a1.restLength).toBeCloseTo(5, 5);
    expect(r[chainId].nodes.a2.restLength).toBeCloseTo(0, 5);
  });

  it("deleteChain removes the chain", () => {
    const m = build();
    const id = Object.keys(m)[0];
    expect(deleteChain(m, id)[id]).toBeUndefined();
  });

  it("updateSettings merges settings", () => {
    const m = build();
    const id = Object.keys(m)[0];
    const r = updateSettings(m, id, { autoRotate: false, rotationOffsetDeg: 0 });
    expect(r[id].settings.autoRotate).toBe(false);
    expect(r[id].settings.rotationOffsetDeg).toBe(0);
  });

  it("setNodeOverride sets and clears per-node flags", () => {
    const m = build();
    const id = Object.keys(m)[0];
    const withLock = setNodeOverride(m, id, "a2", { locked: true });
    expect(withLock[id].settings.nodeOverrides?.a2.locked).toBe(true);
    // clearing the only flag removes the override entry
    const cleared = setNodeOverride(withLock, id, "a2", { locked: undefined });
    expect(cleared[id].settings.nodeOverrides?.a2).toBeUndefined();
  });

  it("does not mutate the input map", () => {
    const m = build();
    const snapshot = JSON.stringify(m);
    removeToken(m, "a1");
    updateSettings(m, Object.keys(m)[0], { autoRotate: false });
    expect(JSON.stringify(m)).toBe(snapshot);
  });
});
