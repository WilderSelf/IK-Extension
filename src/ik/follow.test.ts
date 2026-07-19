import { describe, it, expect } from "vitest";
import type { ChainMap, Vec2 } from "../types";
import { buildChain, setParentNode } from "../model/chains";
import { followUpdates, type Transform } from "./follow";

const pos = (o: Record<string, [number, number]>): Record<string, Vec2> =>
  Object.fromEntries(Object.entries(o).map(([k, [x, y]]) => [k, { x, y }]));

const tf = (o: Record<string, { p: [number, number]; r: number }>): Record<string, Transform> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { pos: { x: v.p[0], y: v.p[1] }, rot: v.r }]));

// An arm chain (A0-A1) that follows a BARE body token "BODY" (not in any chain).
function armOnBody(): { chains: ChainMap; base: Record<string, Transform> } {
  let chains: ChainMap = buildChain({}, ["A0", "A1"],
    pos({ A0: [10, 0], A1: [20, 0] }), { A0: 0, A1: 0 })![0];
  const aId = Object.values(chains).find((c) => c.rootId === "A0")!.id;
  chains = setParentNode(chains, aId, "BODY");
  const base = tf({ BODY: { p: [0, 0], r: 0 }, A0: { p: [10, 0], r: 0 }, A1: { p: [20, 0], r: 0 } });
  return { chains, base };
}

describe("followUpdates", () => {
  it("translates the whole chain when the bare parent is dragged", () => {
    const { chains, base } = armOnBody();
    const cur = tf({ BODY: { p: [5, 7], r: 0 }, A0: { p: [10, 0], r: 0 }, A1: { p: [20, 0], r: 0 } });
    const up = followUpdates(chains, base, cur);
    expect(up.A0.pos).toEqual({ x: 15, y: 7 });
    expect(up.A1.pos).toEqual({ x: 25, y: 7 });
    expect(up.A0.rot).toBe(0);
    expect(Object.keys(up).sort()).toEqual(["A0", "A1"]); // never touches the parent
  });

  it("rotates the chain about the parent's new position when the parent turns", () => {
    const { chains, base } = armOnBody();
    // Parent stays put but rotates +90°; the arm swings around it.
    const cur = tf({ BODY: { p: [0, 0], r: 90 }, A0: { p: [10, 0], r: 0 }, A1: { p: [20, 0], r: 0 } });
    const up = followUpdates(chains, base, cur);
    expect(up.A0.pos.x).toBeCloseTo(0, 6);
    expect(up.A0.pos.y).toBeCloseTo(10, 6);
    expect(up.A1.pos.x).toBeCloseTo(0, 6);
    expect(up.A1.pos.y).toBeCloseTo(20, 6);
    expect(up.A0.rot).toBe(90); // token rotation carried too
  });

  it("does nothing when the parent hasn't moved", () => {
    const { chains, base } = armOnBody();
    expect(followUpdates(chains, base, base)).toEqual({});
    // sub-epsilon jitter is also ignored
    const jitter = tf({ BODY: { p: [0.001, 0], r: 0.001 }, A0: { p: [10, 0], r: 0 }, A1: { p: [20, 0], r: 0 } });
    expect(followUpdates(chains, base, jitter)).toEqual({});
  });

  it("ignores a parent that IS a chain node (poseRig carries those)", () => {
    // B follows A1 — a node of chain A. Moving A1 must NOT be handled here.
    let chains: ChainMap = buildChain({}, ["A0", "A1"], pos({ A0: [0, 0], A1: [10, 0] }), { A0: 0, A1: 0 })![0];
    chains = buildChain(chains, ["B0", "B1"], pos({ B0: [10, 5], B1: [20, 5] }), { B0: 0, B1: 0 })![0];
    const bId = Object.values(chains).find((c) => c.rootId === "B0")!.id;
    chains = setParentNode(chains, bId, "A1");
    const last = tf({ A0: { p: [0, 0], r: 0 }, A1: { p: [10, 0], r: 0 }, B0: { p: [10, 5], r: 0 }, B1: { p: [20, 5], r: 0 } });
    const cur = tf({ A0: { p: [0, 0], r: 0 }, A1: { p: [10, 9], r: 0 }, B0: { p: [10, 5], r: 0 }, B1: { p: [20, 5], r: 0 } });
    expect(followUpdates(chains, last, cur)).toEqual({});
  });

  it("does nothing for an unattached chain", () => {
    const chains: ChainMap = buildChain({}, ["A0", "A1"], pos({ A0: [10, 0], A1: [20, 0] }), { A0: 0, A1: 0 })![0];
    const base = tf({ A0: { p: [10, 0], r: 0 }, A1: { p: [20, 0], r: 0 } });
    const cur = tf({ A0: { p: [10, 0], r: 0 }, A1: { p: [20, 0], r: 0 } });
    expect(followUpdates(chains, base, cur)).toEqual({});
  });
});
