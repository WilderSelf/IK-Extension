/**
 * CAPTURE ↔ CLAMP agreement (the subtle one). "Capture from pose" and the solver's
 * bend clamp must measure a joint's bend the SAME way, or a captured range won't
 * hold when re-posed. Round-trip: pose two extremes → capture each joint's bend via
 * the REAL UI path (chainBends) → union into a limit → re-pose far past it → the
 * re-posed bend, measured the same way, must fall inside the captured range.
 * Run for BOTH the centre rig and the limb rig, over randomised poses.
 */
import { describe, it, expect } from "vitest";
import type { Chain, ChainMap, Vec2 } from "../types";
import {
  buildChain,
  enableSegmentRig,
  limitableTokens,
  orderedNodes,
  setNodeLimit,
  unionRange,
} from "../model/chains";
import { chainBends, poseRig } from "../ik/pose";
import { rng } from "./helpers";

// Degree rotations for a chain after a poseRig, as applyPose would write them —
// needed to feed chainBends for a limb rig (it reconstructs joints from degrees).
function degRotOf(chain: Chain, poseRot: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  const seg = chain.settings.segmentRig;
  for (const id of orderedNodes(chain)) {
    const r = poseRot[id];
    if (r === undefined) continue;
    const off = seg && chain.nodes[id].seg ? chain.nodes[id].seg!.offsetDeg : chain.nodes[id].boneOffsetDeg ?? 0;
    out[id] = (r * 180) / Math.PI + off;
  }
  return out;
}

function makeChain(seg: boolean): { chains: ChainMap; cid: string; base: Record<string, Vec2>; baseRot: Record<string, number> } {
  const ids = ["R", "A", "B", "C", "D"];
  const base: Record<string, Vec2> = Object.fromEntries(ids.map((id, i) => [id, { x: i * 10, y: 0 }]));
  const baseRot: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
  let chains = buildChain({}, ids, base, baseRot)![0];
  const cid = Object.keys(chains)[0];
  if (seg) chains = enableSegmentRig(chains, cid, base, baseRot);
  return { chains, cid, base, baseRot };
}

function runRoundTrip(seg: boolean, r: () => number): void {
  const { chains: c0, cid, base, baseRot } = makeChain(seg);
  const order = orderedNodes(c0[cid]);
  const tip = order[order.length - 1];

  // Two extreme poses (opposite side reaches) → capture bends each.
  const t1 = { x: -(20 + r() * 20), y: 20 + r() * 20 };
  const t2 = { x: -(20 + r() * 20), y: -(20 + r() * 20) };
  const p1 = poseRig(c0, cid, base, { mode: "solve", grabbedId: tip, target: t1 }, undefined, baseRot);
  const p2 = poseRig(c0, cid, base, { mode: "solve", grabbedId: tip, target: t2 }, undefined, baseRot);
  const bends1 = chainBends(c0[cid], p1.positions, degRotOf(c0[cid], p1.rotations));
  const bends2 = chainBends(c0[cid], p2.positions, degRotOf(c0[cid], p2.rotations));

  // Union per limitable joint into a captured range and store it.
  let chains = c0;
  const limits: Record<string, { min: number; max: number }> = {};
  for (const id of limitableTokens(c0[cid])) {
    if (bends1[id] === undefined || bends2[id] === undefined) return; // incomplete capture -> skip
    const range = unionRange({ min: bends1[id], max: bends1[id] }, { min: bends2[id], max: bends2[id] });
    limits[id] = range;
    chains = setNodeLimit(chains, cid, id, range);
  }
  if (Object.keys(limits).length === 0) return;

  // Re-pose FAR past both extremes; every joint's re-posed bend (measured the SAME
  // way) must sit inside its captured range.
  const t3 = { x: -(80 + r() * 40), y: (r() < 0.5 ? 1 : -1) * (60 + r() * 40) };
  const p3 = poseRig(chains, cid, base, { mode: "solve", grabbedId: tip, target: t3 }, undefined, baseRot);
  const bends3 = chainBends(chains[cid], p3.positions, degRotOf(chains[cid], p3.rotations));
  for (const id of Object.keys(limits)) {
    if (bends3[id] === undefined) continue;
    const { min, max } = limits[id];
    expect(bends3[id], `${seg ? "limb" : "centre"} joint ${id}: bend ${bends3[id].toFixed(3)} outside captured [${min.toFixed(3)}, ${max.toFixed(3)}]`)
      .toBeGreaterThanOrEqual(min - 0.02);
    expect(bends3[id]).toBeLessThanOrEqual(max + 0.02);
  }
}

describe("capture ↔ clamp agreement — CENTRE rig", () => {
  it("re-posed bends stay inside the captured range (randomised)", () => {
    const r = rng(0xCAB1);
    for (let t = 0; t < 200; t++) runRoundTrip(false, r);
  });
});

describe("capture ↔ clamp agreement — LIMB rig", () => {
  it("re-posed segment bends stay inside the captured range (randomised)", () => {
    const r = rng(0x11B2);
    for (let t = 0; t < 200; t++) runRoundTrip(true, r);
  });
});
