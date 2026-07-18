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
  setNodeConstraint,
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

  it("never reuses a chain id after deletion (no silent overwrite)", () => {
    // Two tokens sharing the same 6-char id prefix, so the readable part of the
    // generated chain id is identical; only the numeric suffix separates them.
    const [m, id1] = createChain({}, "abcdef-one");
    const [m2, id2] = createChain(m, "abcdef-two");
    expect(id2).not.toBe(id1);
    // Delete the first chain, then create a third. The old count-based suffix
    // would collide with id2 and clobber it; the ids must all stay distinct.
    const afterDelete = deleteChain(m2, id1);
    const [m3, id3] = createChain(afterDelete, "abcdef-three");
    expect(id3).not.toBe(id2);
    expect(m3[id2]).toBeDefined(); // the surviving chain was not overwritten
    expect(Object.keys(m3)).toHaveLength(2);
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

  it("pruneMissing removes EVERY missing token in a chain, not just the last", () => {
    // a1 and b1 both deleted at once; a2 reparents to body. a1 must not linger.
    const pruned = pruneMissing(build(), new Set(["body", "a2"]));
    const chain = Object.values(pruned)[0];
    expect(Object.keys(chain.nodes).sort()).toEqual(["a2", "body"]);
    expect(chain.nodes.a2.parentId).toBe("body");
  });

  it("pruneMissing keeps a valid lone-root (in-progress) chain", () => {
    // A brand-new root awaiting its first child must NOT be pruned.
    const [m, id] = createChain({}, "body");
    const pruned = pruneMissing(m, new Set(["body"]));
    expect(pruned[id]?.rootId).toBe("body");
    // ...but a lone root whose token was deleted is removed.
    expect(Object.keys(pruneMissing(m, new Set<string>()))).toHaveLength(0);
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

  it("addNode stores boneOffsetDeg only when provided", () => {
    let [m, id] = createChain({}, "body");
    m = addNode(m, id, "a1", "body", 10, 35);
    m = addNode(m, id, "a2", "a1", 10);
    expect(m[id].nodes.a1.boneOffsetDeg).toBe(35);
    expect(m[id].nodes.a2.boneOffsetDeg).toBeUndefined();
  });

  it("recalibrate captures boneOffsetDeg from rotations relative to the bone", () => {
    const m = build();
    const chainId = Object.keys(m)[0];
    // a1 sits due east of body, so its bone angle is 0deg; a token rotated 90deg
    // has a +90 offset. b1 sits due north (bone angle -90deg in y-down math), and
    // a token rotated 0deg yields offset 0 - (-90) = 90.
    const positions = {
      body: { x: 0, y: 0 },
      a1: { x: 10, y: 0 },
      a2: { x: 20, y: 0 },
      b1: { x: 0, y: -10 },
    };
    const rotations = { body: 0, a1: 90, a2: 0, b1: 0 };
    const r = recalibrate(m, chainId, positions, rotations);
    expect(r[chainId].nodes.a1.boneOffsetDeg).toBeCloseTo(90, 5);
    expect(r[chainId].nodes.b1.boneOffsetDeg).toBeCloseTo(90, 5);
    // Root has no incoming bone, so it never gets an offset.
    expect(r[chainId].nodes.body.boneOffsetDeg).toBeUndefined();
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

  it("setNodeConstraint sets and clears a node bend limit", () => {
    const m = build();
    const id = Object.keys(m)[0];
    const withLimit = setNodeConstraint(m, id, "a2", { minDeg: -120, maxDeg: 0 });
    expect(withLimit[id].nodes.a2.constraint).toEqual({ minDeg: -120, maxDeg: 0 });
    // input is not mutated
    expect(m[id].nodes.a2.constraint).toBeUndefined();
    const cleared = setNodeConstraint(withLimit, id, "a2", null);
    expect(cleared[id].nodes.a2.constraint).toBeUndefined();
  });

  it("setNodeConstraint ignores an unknown token", () => {
    const m = build();
    const id = Object.keys(m)[0];
    expect(setNodeConstraint(m, id, "nope", { minDeg: 0, maxDeg: 90 })).toBe(m);
  });

  it("does not mutate the input map", () => {
    const m = build();
    const snapshot = JSON.stringify(m);
    removeToken(m, "a1");
    updateSettings(m, Object.keys(m)[0], { autoRotate: false });
    setNodeConstraint(m, Object.keys(m)[0], "a2", { minDeg: -90, maxDeg: 90 });
    expect(JSON.stringify(m)).toBe(snapshot);
  });
});
