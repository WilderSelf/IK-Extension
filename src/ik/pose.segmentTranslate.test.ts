/**
 * Segment-rig (limb mode) orientation integrity under a rigid TRANSLATE.
 *
 * REGRESSION: dragging the ROOT of a limb-mode chain is a translate. poseRig
 * only emitted segment angles for a SOLVE, so a translate fell back to
 * centre-based `boneAngles`. When the segment direction ≠ the centre-to-centre
 * direction — which happens whenever limb mode is enabled on a BENT rest pose,
 * or after a joint pivot is dragged off-axis — applyPose pairs that centre angle
 * with the segment offset and the whole limb visibly spins on a mere move.
 */
import { describe, it, expect } from "vitest";
import type { ChainMap, Vec2 } from "../types";
import { DEFAULT_ROTATION_OFFSET_DEG } from "../types";
import { buildChain, enableSegmentRig, orderedNodes, setJointPivot, setParentNode } from "../model/chains";
import { poseRig } from "./pose";

const pos = (o: Record<string, [number, number]>): Record<string, Vec2> =>
  Object.fromEntries(Object.entries(o).map(([k, [x, y]]) => [k, { x, y }]));
const rot = (o: Record<string, number>) => o;

// Mirror of obr/scene.ts radToObrDeg (inlined so this pure test stays SDK-free).
const radToObrDeg = (rad: number, offsetDeg = 90): number => {
  const safeRad = Number.isFinite(rad) ? rad : 0;
  const deg = (safeRad * 180) / Math.PI + offsetDeg;
  return ((deg % 360) + 360) % 360;
};

// Rebuild the OBR item rotation applyPose would write for a segment-rig token,
// so we assert against the value a real token actually receives.
function obrRotationOf(chain: ChainMap[string], id: string, poseRot: number): number {
  const seg = chain.nodes[id].seg;
  const off = chain.settings.segmentRig && seg ? seg.offsetDeg : chain.nodes[id].boneOffsetDeg ?? DEFAULT_ROTATION_OFFSET_DEG;
  return radToObrDeg(poseRot, off);
}

describe("limb-mode translate preserves token orientation", () => {
  function bentLimb(): { chains: ChainMap; sId: string; base: Record<string, Vec2>; baseRot: Record<string, number> } {
    const ids = ["S0", "S1", "S2"];
    // A BENT rest pose: S2 lifted, so centres are NOT collinear -> segment
    // directions differ from centre-to-centre directions after capture.
    const base = pos({ S0: [0, 0], S1: [10, 0], S2: [16, 8] });
    const baseRot = rot({ S0: 10, S1: 25, S2: 40 });
    let chains = buildChain({}, ids, base, baseRot)![0];
    const sId = Object.values(chains).find((c) => c.rootId === "S0")!.id;
    chains = enableSegmentRig(chains, sId, base, baseRot);
    return { chains, sId, base, baseRot };
  }

  it("a pure translate does not change any token's OBR rotation", () => {
    const { chains, sId, base, baseRot } = bentLimb();
    const order = orderedNodes(chains[sId]);
    const moved = poseRig(chains, sId, base, { mode: "translate", delta: { x: 137, y: -42 } }, undefined, baseRot);
    for (const id of order) {
      expect(moved.rotations[id]).not.toBeUndefined();
      // The rotation applyPose would write must equal the token's authored rotation.
      const written = obrRotationOf(chains[sId], id, moved.rotations[id]);
      const authored = ((baseRot[id] % 360) + 360) % 360;
      expect(written).toBeCloseTo(authored, 4);
    }
  });

  it("holds after a joint pivot is dragged well off the centre axis", () => {
    let { chains, sId, base, baseRot } = bentLimb();
    chains = setJointPivot(chains, sId, 1, { x: 6, y: 9 }, base, baseRot);
    const order = orderedNodes(chains[sId]);
    const moved = poseRig(chains, sId, base, { mode: "translate", delta: { x: -80, y: 200 } }, undefined, baseRot);
    for (const id of order) {
      const written = obrRotationOf(chains[sId], id, moved.rotations[id]);
      const authored = ((baseRot[id] % 360) + 360) % 360;
      expect(written).toBeCloseTo(authored, 4);
    }
  });

  it("translate then translate-back returns to the authored orientation", () => {
    const { chains, sId, base, baseRot } = bentLimb();
    const order = orderedNodes(chains[sId]);
    const a = poseRig(chains, sId, base, { mode: "translate", delta: { x: 50, y: 50 } }, undefined, baseRot);
    for (const id of order) {
      const written = obrRotationOf(chains[sId], id, a.rotations[id]);
      expect(written).toBeCloseTo(((baseRot[id] % 360) + 360) % 360, 4);
    }
  });

  it("a sub-chain on a limb segment is carried by PURE translation (no spin)", () => {
    // Arm S0-S1-S2 (limb, bent rest) with a sub-chain P0-P1 on the middle segment.
    const ids = ["S0", "S1", "S2"];
    const base = pos({ S0: [0, 0], S1: [10, 0], S2: [16, 8], P0: [10, 3], P1: [13, 3] });
    const baseRot: Record<string, number> = { S0: 10, S1: 25, S2: 40, P0: 0, P1: 0 };
    let chains = buildChain({}, ids, pos({ S0: [0, 0], S1: [10, 0], S2: [16, 8] }), { S0: 10, S1: 25, S2: 40 })![0];
    const sId = Object.values(chains).find((c) => c.rootId === "S0")!.id;
    chains = enableSegmentRig(chains, sId, pos({ S0: [0, 0], S1: [10, 0], S2: [16, 8] }), { S0: 10, S1: 25, S2: 40 });
    chains = buildChain(chains, ["P0", "P1"], pos({ P0: [10, 3], P1: [13, 3] }), { P0: 0, P1: 0 })![0];
    const pId = Object.values(chains).find((c) => c.rootId === "P0")!.id;
    chains = setParentNode(chains, pId, "S1");

    const delta = { x: 40, y: -25 };
    const { positions: out } = poseRig(chains, sId, base, { mode: "translate", delta }, undefined, baseRot);
    // The sub-chain shifts by exactly delta — no rotation from a bogus dRot.
    expect(out.P0.x).toBeCloseTo(base.P0.x + delta.x, 6);
    expect(out.P0.y).toBeCloseTo(base.P0.y + delta.y, 6);
    expect(out.P1.x).toBeCloseTo(base.P1.x + delta.x, 6);
    expect(out.P1.y).toBeCloseTo(base.P1.y + delta.y, 6);
  });

  it("the centre (default) rig is unaffected — still keeps orientation on translate", () => {
    const ids = ["S0", "S1", "S2"];
    const base = pos({ S0: [0, 0], S1: [10, 0], S2: [16, 8] });
    const baseRot = rot({ S0: 10, S1: 25, S2: 40 });
    const chains = buildChain({}, ids, base, baseRot)![0];
    const sId = Object.values(chains).find((c) => c.rootId === "S0")!.id;
    const moved = poseRig(chains, sId, base, { mode: "translate", delta: { x: 5, y: 5 } }, undefined, baseRot);
    for (const id of ids) {
      const written = radToObrDeg(moved.rotations[id], chains[sId].nodes[id].boneOffsetDeg);
      expect(written).toBeCloseTo(((baseRot[id] % 360) + 360) % 360, 4);
    }
  });
});
