import { type Vec2 } from "../types";
import { solveChain, type SolveOptions } from "./fabrik";
import { add, angle, dist, rotateAround, scale, sub } from "./vec";

/**
 * SEGMENT RIG — pivot at joints, not centres.
 *
 * The default rig treats each token's CENTRE as a FABRIK point, so a token
 * rotates about its own centre. A limb segment must instead pivot at its JOINT
 * (the proximal end where it meets its parent). This module reinterprets a
 * chain's N token centres as N+1 JOINTS: interior joints are the midpoints of
 * adjacent centres, and the two ends reflect outward past the outermost centres.
 * FABRIK runs on the joints (root joint pinned); each token is then re-seated on
 * its segment and re-oriented along it — so segments stay connected at their
 * joints by construction, and the root pivots at the shoulder instead of drifting.
 *
 * The token centres are the source of truth (robust to manual token moves): the
 * seed joints are re-derived from them each solve, and FABRIK re-imposes the
 * fixed rest lengths, so segments never stretch. Everything here is pure geometry
 * (no Owlbear), so the joint invariants are unit testable; only the on-canvas
 * feel needs a live check.
 */

/** Per-token rigid-segment data, captured once from a rest pose. */
export interface SegData {
  /** Fixed length of this token's segment (joint i → joint i+1). */
  len: number;
  /** Where the token's centre sits along its segment: 0 = proximal joint, 1 = distal. */
  frac: number;
}

/**
 * Derive N+1 joints from N token centres. Interior joints are midpoints of
 * adjacent centres; the ends are reflected outward (`2*Cend - Mnear`) so the
 * root and tip segments extend past the outermost centres. N=1 is degenerate
 * (a lone root) → a zero-length segment at that point.
 */
export function deriveJoints(centres: Vec2[]): Vec2[] {
  const n = centres.length;
  if (n === 0) return [];
  if (n === 1) return [centres[0], centres[0]];
  const mids: Vec2[] = [];
  for (let i = 0; i < n - 1; i++) mids.push(scale(add(centres[i], centres[i + 1]), 0.5));
  const first = sub(scale(centres[0], 2), mids[0]); // 2*C0 - M0
  const last = sub(scale(centres[n - 1], 2), mids[n - 2]); // 2*C_{n-1} - M_{n-2}
  return [first, ...mids, last];
}

/** Signed position of `c` along the segment a→b, as a fraction of its length. */
function fractionAlong(a: Vec2, b: Vec2, c: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-12) return 0.5;
  return ((c.x - a.x) * abx + (c.y - a.y) * aby) / len2;
}

/**
 * Capture each token's rigid-segment data (fixed length + where its centre sits
 * along the segment) from a rest pose. Call when a chain enters segment-rig mode.
 */
export function captureSegments(centres: Vec2[]): SegData[] {
  const joints = deriveJoints(centres);
  return centres.map((c, i) => {
    const a = joints[i];
    const b = joints[i + 1];
    return { len: dist(a, b), frac: fractionAlong(a, b, c) };
  });
}

/** Re-seat every token on its segment: centre = joint + frac·(nextJoint − joint). */
export function seatTokens(joints: Vec2[], seg: SegData[]): Vec2[] {
  return seg.map((s, i) => add(joints[i], scale(sub(joints[i + 1], joints[i]), s.frac)));
}

/** World-space direction (radians) of each token's segment, given the joints. */
export function jointAngles(joints: Vec2[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < joints.length; i++) out.push(angle(joints[i], joints[i + 1]));
  return out;
}

/** Convenience: each token's segment direction (radians) derived from centres. */
export function segmentAngles(centres: Vec2[]): number[] {
  return jointAngles(deriveJoints(centres));
}

/**
 * Solve a segment rig's JOINTS by reaching the grabbed token's DISTAL joint to
 * `target`. The token centres seed the joints; FABRIK solves root (pinned) →
 * effector; joints past the effector are carried rigidly (matching the default
 * rig's tail). Returns the N+1 solved joints — feed them to `seatTokens` for
 * centres and `jointAngles` for orientations.
 *
 * `grabbedIndex` is the token's index in root→tip order and must be ≥ 1 (grabbing
 * the root translates the whole rig instead, handled by the caller).
 */
export function solveSegmentJoints(
  centres: Vec2[],
  seg: SegData[],
  grabbedIndex: number,
  target: Vec2,
  opts?: SolveOptions,
): Vec2[] {
  const n = centres.length;
  const joints = deriveJoints(centres); // n + 1 points
  if (n < 2 || grabbedIndex < 1) return joints;
  const lengths = seg.map((s) => s.len); // n lengths, joints[i] → joints[i+1]

  // Effector = the grabbed token's DISTAL joint. Solve the root→effector sub-path.
  const effJoint = Math.min(grabbedIndex + 1, n);
  const solvedSub = solveChain(joints.slice(0, effJoint + 1), lengths.slice(0, effJoint), target, opts);
  const outJoints = joints.slice();
  for (let i = 0; i <= effJoint; i++) outJoints[i] = solvedSub[i];

  // Carry joints past the effector rigidly — translated + rotated by the effector
  // joint's own move, so the tip trails naturally instead of detaching.
  if (effJoint < n) {
    const oldSelf = joints[effJoint];
    const oldParent = joints[effJoint - 1];
    const newSelf = outJoints[effJoint];
    const newParent = outJoints[effJoint - 1];
    const trans = sub(newSelf, oldSelf);
    const dRot =
      dist(oldParent, oldSelf) > 1e-9 && dist(newParent, newSelf) > 1e-9
        ? angle(newParent, newSelf) - angle(oldParent, oldSelf)
        : 0;
    for (let i = effJoint + 1; i <= n; i++) {
      outJoints[i] = rotateAround(add(joints[i], trans), newSelf, dRot);
    }
  }

  return outJoints;
}
