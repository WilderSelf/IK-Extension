/**
 * CARDINALITY stress: too many pieces, not enough pieces, too-big chains, too many
 * chains, and too-deep attachment nesting. Every case must terminate (vitest's 5s
 * timeout is the hang detector), keep the root pinned, preserve bone lengths, and
 * never emit NaN.
 */
import { describe, it, expect } from "vitest";
import type { ChainMap, Vec2 } from "../types";
import { CHAIN_PALETTE } from "../types";
import {
  buildChain,
  createChain,
  descendantChainIds,
  enableSegmentRig,
  orderedNodes,
  pickChainColor,
  pruneMissing,
  setParentNode,
} from "../model/chains";
import { poseRig, solvePose } from "../ik/pose";
import { solveChain } from "../ik/fabrik";
import { allFinite, boneLengths, finitePt, idOf, makeLine, pos, rot0 } from "./helpers";

describe("TOO MANY PIECES — huge single chain", () => {
  it("a 1000-node chain solves: root pinned, all lengths preserved, finite", () => {
    const { chain, positions } = makeLine(1000, 10);
    const order = orderedNodes(chain);
    expect(order.length).toBe(1000);
    // Grab the tip and reach somewhere reachable but bent.
    const { positions: out } = solvePose(chain, positions, order[999], { x: 3000, y: 1500 });
    expect(out[order[0]]).toEqual(positions[order[0]]); // root pinned
    boneLengths(order, out).forEach((l) => expect(l).toBeCloseTo(10, 3));
    expect(allFinite(out)).toBe(true);
  });

  it("a 2000-point raw solveChain stays finite and length-true", () => {
    const points: Vec2[] = Array.from({ length: 2000 }, (_, i) => ({ x: i, y: 0 }));
    const rest = Array.from({ length: 1999 }, () => 1);
    const out = solveChain(points, rest, { x: 500, y: 900 });
    expect(out[0]).toEqual({ x: 0, y: 0 });
    for (let i = 1; i < out.length; i++) expect(Number.isFinite(out[i].x) && Number.isFinite(out[i].y)).toBe(true);
  });

  it("buildChain of 250 tokens completes and is well-formed", () => {
    const ids = Array.from({ length: 250 }, (_, i) => `t${i}`);
    const positions = pos(Object.fromEntries(ids.map((id, i) => [id, [i * 5, 0]])));
    const built = buildChain({}, ids, positions, rot0(ids));
    expect(built).not.toBeNull();
    const chain = Object.values(built![0])[0];
    expect(orderedNodes(chain).length).toBe(250);
    expect(chain.nodes[ids[249]].restLength).toBeCloseTo(5, 6);
  });

  it("limb mode on a 300-node chain reconstructs finitely", () => {
    const ids = Array.from({ length: 300 }, (_, i) => `s${i}`);
    const positions = pos(Object.fromEntries(ids.map((id, i) => [id, [i * 8, (i % 2) * 2]])));
    let chains = buildChain({}, ids, positions, rot0(ids))![0];
    const id = idOf(chains, "s0");
    chains = enableSegmentRig(chains, id, positions, rot0(ids));
    const { positions: out } = poseRig(chains, id, positions,
      { mode: "solve", grabbedId: "s299", target: { x: 100, y: 80 } }, undefined, rot0(ids));
    expect(allFinite(out)).toBe(true);
  });
});

describe("NOT ENOUGH PIECES — degenerate small chains", () => {
  it("buildChain rejects 0 and 1 tokens", () => {
    expect(buildChain({}, [], {}, {})).toBeNull();
    expect(buildChain({}, ["only"], pos({ only: [0, 0] }), rot0(["only"]))).toBeNull();
  });

  it("a lone-root chain: solvePose/poseRig are safe no-ops", () => {
    const [map, id] = createChain({}, "R");
    const chain = map[id];
    expect(orderedNodes(chain)).toEqual(["R"]);
    const p = pos({ R: [5, 5] });
    expect(solvePose(chain, p, "R", { x: 9, y: 9 }).positions).toEqual(p);
    // grabbing a non-existent node
    expect(solvePose(chain, p, "ghost", { x: 9, y: 9 }).positions).toEqual(p);
    const rigged = poseRig(map, id, p, { mode: "solve", grabbedId: "R", target: { x: 1, y: 1 } });
    expect(finitePt(rigged.positions.R)).toBe(true);
  });

  it("enableSegmentRig needs >=2 positioned nodes (no-op otherwise)", () => {
    const [map, id] = createChain({}, "R");
    expect(enableSegmentRig(map, id, pos({ R: [0, 0] }), rot0(["R"]))).toBe(map);
  });

  it("empty chain map: queries return empty, pose is inert", () => {
    const empty: ChainMap = {};
    expect(descendantChainIds(empty, "nope")).toEqual([]);
    expect(orderedNodes({ id: "x", rootId: "R", nodes: {}, settings: { autoRotate: true } })).toEqual([]);
  });
});

describe("TOO BIG A CHAIN — extreme span", () => {
  it("astronomically long bones stay finite and length-true", () => {
    const { chain, positions } = makeLine(6, 1e6);
    const order = orderedNodes(chain);
    const { positions: out } = solvePose(chain, positions, order[5], { x: 1e6, y: 2e6 });
    expect(out[order[0]]).toEqual(positions[order[0]]);
    boneLengths(order, out).forEach((l) => expect(l).toBeCloseTo(1e6, 0));
    expect(allFinite(out)).toBe(true);
  });

  it("far-flung root coordinates keep the solve finite", () => {
    const { chain, positions } = makeLine(5, 10);
    for (const id of Object.keys(positions)) { positions[id].x += 1e9; positions[id].y -= 1e9; }
    const order = orderedNodes(chain);
    const { positions: out } = solvePose(chain, positions, order[4], { x: 1e9 + 5, y: -1e9 + 30 });
    expect(allFinite(out)).toBe(true);
  });
});

describe("TOO MANY CHAINS — big maps & palette exhaustion", () => {
  it("500 independent chains: build, query, prune all coherent", () => {
    let map: ChainMap = {};
    for (let i = 0; i < 500; i++) {
      const ids = [`c${i}_0`, `c${i}_1`];
      map = buildChain(map, ids, pos({ [ids[0]]: [i, 0], [ids[1]]: [i, 10] }), rot0(ids))![0];
    }
    expect(Object.keys(map).length).toBe(500);
    expect(new Set(Object.keys(map)).size).toBe(500); // unique ids
    // Prune with everything present -> unchanged count.
    const existing = new Set(Object.values(map).flatMap((c) => Object.keys(c.nodes)));
    expect(Object.keys(pruneMissing(map, existing)).length).toBe(500);
  });

  it("pickChainColor cycles through the palette without throwing past its length", () => {
    let map: ChainMap = {};
    for (let i = 0; i < CHAIN_PALETTE.length + 5; i++) {
      const c = pickChainColor(map);
      expect(typeof c).toBe("string");
      [map] = createChain(map, `x${i}`);
      const ks = Object.keys(map); map[ks[ks.length - 1]].color = c;
    }
    // No crash; still returns a palette-ish value.
    expect(CHAIN_PALETTE).toContain(pickChainColor(map));
  });
});

describe("TOO DEEP NESTING — long attachment forests", () => {
  it("a 60-level attachment chain: descendants listed, translate carries all", () => {
    // Chain L0 <- L1 follows a node of L0 <- ... 60 deep.
    let map: ChainMap = buildChain({}, ["L0a", "L0b"], pos({ L0a: [0, 0], L0b: [10, 0] }), rot0(["L0a", "L0b"]))![0];
    let prevTail = "L0b";
    for (let i = 1; i < 60; i++) {
      const a = `L${i}a`, b = `L${i}b`;
      map = buildChain(map, [a, b], pos({ [a]: [i * 10, 5], [b]: [i * 10 + 10, 5] }), rot0([a, b]))![0];
      map = setParentNode(map, idOf(map, a), prevTail);
      prevTail = b;
    }
    const rootId = idOf(map, "L0a");
    expect(descendantChainIds(map, rootId).length).toBe(59);
    // A translate of the root chain must carry the whole forest, finitely.
    const base = pos(Object.fromEntries(Object.values(map).flatMap((c) => orderedNodes(c)).map((id, _i) => {
      // reconstruct positions from ids like L{n}a/L{n}b
      const m = /^L(\d+)([ab])$/.exec(id)!;
      const n = Number(m[1]);
      return [id, m[2] === "a" ? [n * 10, n === 0 ? 0 : 5] : [n * 10 + 10, n === 0 ? 0 : 5]] as [string, [number, number]];
    })));
    const { positions: out } = poseRig(map, rootId, base, { mode: "translate", delta: { x: 7, y: -3 } });
    expect(allFinite(out)).toBe(true);
    expect(out.L0a).toEqual({ x: 7, y: -3 });
    // The deepest child moved by exactly the delta too (pure translate is rigid).
    expect(out["L59b"]).toEqual({ x: base["L59b"].x + 7, y: base["L59b"].y - 3 });
  });
});
