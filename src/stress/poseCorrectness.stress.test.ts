/**
 * POSE CORRECTNESS under stress — beyond finiteness, the geometry must be right on
 * randomised, WELL-FORMED multi-chain rigs:
 *   • translate is PERFECTLY rigid: every token (posed chain + all descendants)
 *     moves by exactly the delta;
 *   • solve pins the posed chain's root and preserves its consecutive bone lengths
 *     (centre rig) or segment lengths (limb rig);
 *   • descendants are carried RIGIDLY: their internal bone lengths are preserved.
 */
import { describe, it, expect } from "vitest";
import type { ChainMap, Vec2 } from "../types";
import {
  buildChain,
  descendantChainIds,
  enableSegmentRig,
  isSegmentRig,
  orderedNodes,
  setParentNode,
} from "../model/chains";
import { poseRig } from "../ik/pose";
import { reconstructJoints } from "../ik/segment";
import { rng } from "./helpers";

function d(a: Vec2, b: Vec2): number { return Math.hypot(a.x - b.x, a.y - b.y); }

/** Build a random acyclic rig: `nChains` linear chains, each maybe attached to an
 *  already-built chain's node. Returns the map, the root-chain id, and base pos. */
function randomRig(r: () => number, nChains: number): { map: ChainMap; rootChainId: string; base: Record<string, Vec2>; baseRot: Record<string, number>; segChains: Set<string> } {
  let map: ChainMap = {};
  const base: Record<string, Vec2> = {};
  const baseRot: Record<string, number> = {};
  const segChains = new Set<string>();
  const builtIds: string[] = [];
  const allTokens: string[] = [];
  let counter = 0;
  for (let ci = 0; ci < nChains; ci++) {
    const len = 2 + Math.floor(r() * 4);
    const ids: string[] = [];
    let x = (r() - 0.5) * 100, y = (r() - 0.5) * 100, ang = r() * 6.283;
    for (let i = 0; i < len; i++) {
      const id = `c${ci}n${counter++}`;
      ids.push(id);
      base[id] = { x, y };
      baseRot[id] = (r() - 0.5) * 360;
      const step = 8 + r() * 20;
      ang += (r() - 0.5) * 1.5;
      x += Math.cos(ang) * step; y += Math.sin(ang) * step;
      allTokens.push(id);
    }
    const built = buildChain(map, ids, base, baseRot);
    if (!built) continue;
    map = built[0];
    const cid = built[1];
    builtIds.push(cid);
    // Maybe make it a limb rig.
    if (r() < 0.35) { map = enableSegmentRig(map, cid, Object.fromEntries(ids.map((id) => [id, base[id]])), Object.fromEntries(ids.map((id) => [id, baseRot[id]]))); if (isSegmentRig(map[cid])) segChains.add(cid); }
    // Maybe attach to an earlier chain's node (keeps the forest acyclic).
    if (ci > 0 && r() < 0.6) {
      const parentChain = builtIds[Math.floor(r() * (builtIds.length - 1))];
      const pnodes = orderedNodes(map[parentChain]);
      const pnode = pnodes[Math.floor(r() * pnodes.length)];
      const attempt = setParentNode(map, cid, pnode);
      map = attempt; // setParentNode rejects cycles by returning the map unchanged
    }
  }
  return { map, rootChainId: builtIds[0], base, baseRot, segChains };
}

describe("translate is perfectly rigid across random forests", () => {
  const r = rng(0x2C0FFEE);
  it("every token in the posed chain + all descendants moves by exactly delta", () => {
    for (let t = 0; t < 300; t++) {
      const { map, rootChainId, base, baseRot } = randomRig(r, 1 + Math.floor(r() * 5));
      if (!rootChainId) continue;
      const delta = { x: (r() - 0.5) * 300, y: (r() - 0.5) * 300 };
      const { positions } = poseRig(map, rootChainId, base, { mode: "translate", delta }, undefined, baseRot);
      const involved = new Set([rootChainId, ...descendantChainIds(map, rootChainId)].flatMap((id) => orderedNodes(map[id])));
      for (const id of involved) {
        if (!base[id]) continue;
        expect(positions[id].x).toBeCloseTo(base[id].x + delta.x, 6);
        expect(positions[id].y).toBeCloseTo(base[id].y + delta.y, 6);
      }
    }
  });
});

describe("solve pins the root & preserves lengths across random forests", () => {
  const r = rng(0x50FA);
  it("posed centre-rig chain: root pinned + consecutive bone lengths preserved", () => {
    for (let t = 0; t < 400; t++) {
      const { map, rootChainId, base, baseRot, segChains } = randomRig(r, 1 + Math.floor(r() * 4));
      if (!rootChainId || segChains.has(rootChainId)) continue; // centre rig only here
      const order = orderedNodes(map[rootChainId]);
      if (order.length < 2) continue;
      const grabbed = order[1 + Math.floor(r() * (order.length - 1))];
      const target = { x: (r() - 0.5) * 200, y: (r() - 0.5) * 200 };
      const { positions } = poseRig(map, rootChainId, base, { mode: "solve", grabbedId: grabbed, target }, undefined, baseRot);
      // Root pinned.
      expect(positions[order[0]].x).toBeCloseTo(base[order[0]].x, 6);
      expect(positions[order[0]].y).toBeCloseTo(base[order[0]].y, 6);
      // Consecutive bone lengths preserved.
      for (let i = 1; i < order.length; i++) {
        expect(d(positions[order[i - 1]], positions[order[i]])).toBeCloseTo(d(base[order[i - 1]], base[order[i]]), 3);
      }
    }
  });

  it("posed limb-rig chain: SEGMENT lengths preserved (centres re-seat)", () => {
    for (let t = 0; t < 400; t++) {
      const { map, rootChainId, base, baseRot, segChains } = randomRig(r, 1 + Math.floor(r() * 4));
      if (!rootChainId || !segChains.has(rootChainId)) continue; // limb rig only
      const order = orderedNodes(map[rootChainId]);
      if (order.length < 2) continue;
      const seg = order.map((id) => map[rootChainId].nodes[id].seg!);
      const grabbed = order[1 + Math.floor(r() * (order.length - 1))];
      const { positions, rotations } = poseRig(map, rootChainId, base, { mode: "solve", grabbedId: grabbed, target: { x: (r() - 0.5) * 150, y: (r() - 0.5) * 150 } }, undefined, baseRot);
      // Reconstruct joints from the SOLVED centres + emitted seg rotations and check
      // each segment kept its captured length.
      const centres = order.map((id) => positions[id]);
      const rotd = order.map((id) => (rotations[id] ?? 0) * 180 / Math.PI + (map[rootChainId].nodes[id].seg!.offsetDeg));
      const joints = reconstructJoints(centres as Vec2[], rotd, seg);
      for (let i = 0; i + 1 < joints.length; i++) {
        expect(d(joints[i], joints[i + 1])).toBeCloseTo(seg[i].len, 2);
      }
    }
  });

  it("descendant chains keep their internal bone lengths (rigid carry)", () => {
    for (let t = 0; t < 400; t++) {
      const { map, rootChainId, base, baseRot } = randomRig(r, 2 + Math.floor(r() * 4));
      if (!rootChainId) continue;
      const desc = descendantChainIds(map, rootChainId);
      if (desc.length === 0) continue;
      const order = orderedNodes(map[rootChainId]);
      const grab = order.length > 1
        ? { mode: "solve" as const, grabbedId: order[1 + Math.floor(r() * (order.length - 1))], target: { x: (r() - 0.5) * 200, y: (r() - 0.5) * 200 } }
        : { mode: "translate" as const, delta: { x: 10, y: 5 } };
      const { positions } = poseRig(map, rootChainId, base, grab, undefined, baseRot);
      for (const cid of desc) {
        const dorder = orderedNodes(map[cid]);
        for (let i = 1; i < dorder.length; i++) {
          if (!positions[dorder[i - 1]] || !positions[dorder[i]]) continue;
          // A rigid carry preserves the descendant's own inter-node distances.
          expect(d(positions[dorder[i - 1]], positions[dorder[i]])).toBeCloseTo(d(base[dorder[i - 1]], base[dorder[i]]), 2);
        }
      }
    }
  });
});
