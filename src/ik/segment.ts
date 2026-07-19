import { type JointParam, type Vec2 } from "../types";
import { solveChain, type SolveOptions } from "./fabrik";
import { add, angle, dist, rotateAround, scale, sub } from "./vec";

/**
 * SEGMENT RIG — pivot at joints, not centres.
 *
 * The default rig treats each token's CENTRE as a FABRIK point, so a token
 * rotates about its own centre. A limb segment must instead pivot at its JOINT
 * (the proximal end where it meets its parent). This module reinterprets a
 * chain's N token centres as N+1 JOINTS. By default the joints are the midpoints
 * of adjacent centres (ends reflected outward), but each joint can be adjusted:
 * a `JointParam` places it in the frame of an anchor pair of centres, so a
 * dragged pivot stays defined relative to the tokens and follows the rig as it
 * poses. FABRIK runs on the joints (root joint pinned); each token is then
 * re-seated on its segment and re-oriented along it — so segments stay connected
 * at their joints by construction, and the root pivots at the shoulder.
 *
 * The token centres are the source of truth (robust to manual token moves): the
 * seed joints are reconstructed from them each solve, and FABRIK re-imposes the
 * fixed rest lengths, so segments never stretch. Everything here is pure geometry
 * (no Owlbear), so the joint invariants are unit testable; only the on-canvas
 * feel needs a live check.
 */

/** Per-token rigid-segment data, captured once from a rest pose. */
export interface SegData {
  /** Fixed length of this token's segment (joint i → joint i+1). */
  len: number;
  /** Token centre along its segment, as a fraction of the segment length. */
  seatAlong: number;
  /** Token centre perpendicular to its segment, as a fraction of its length. */
  seatPerp: number;
}

const perpOf = (d: Vec2): Vec2 => ({ x: -d.y, y: d.x });

/**
 * The two centre indices that anchor each of the N+1 joints. Interior joints sit
 * between their two adjacent tokens; the ends are anchored to the outermost pair
 * (reversed at the tip) so a positive/negative `along` extends past the end token.
 */
export function jointAnchors(n: number): [number, number][] {
  const out: [number, number][] = [[0, 1]]; // joint 0 (proximal end)
  for (let j = 1; j < n; j++) out.push([j - 1, j]); // interior joints
  out.push([n - 1, n - 2]); // joint N (distal end)
  return out;
}

/** The `JointParam`s that reproduce the auto-derived midpoint joints. */
export function defaultJointParams(n: number): JointParam[] {
  return jointAnchors(n).map((_, j) => ({ along: j === 0 || j === n ? -0.5 : 0.5, perp: 0 }));
}

/**
 * Reconstruct the N+1 joints from token centres and (optional) per-joint params.
 * With no params (or the defaults) this is the midpoint derivation. N<2 is
 * degenerate → a single zero-length segment at the lone centre.
 */
export function reconstructJoints(centres: Vec2[], params?: JointParam[]): Vec2[] {
  const n = centres.length;
  if (n === 0) return [];
  if (n === 1) return [centres[0], centres[0]];
  const p = params ?? defaultJointParams(n);
  const anchors = jointAnchors(n);
  return anchors.map(([ai, bi], j) => {
    const a = centres[ai];
    const b = centres[bi];
    const d = sub(b, a);
    return add(a, add(scale(d, p[j].along), scale(perpOf(d), p[j].perp)));
  });
}

/** Auto-derived midpoint joints (kept for callers that never adjust pivots). */
export function deriveJoints(centres: Vec2[]): Vec2[] {
  return reconstructJoints(centres);
}

/**
 * Invert a dragged world position into the `JointParam` for joint `jointIndex`,
 * against the current centres. Returns the default param if the anchor pair is
 * degenerate (coincident centres).
 */
export function jointParamFromWorld(centres: Vec2[], jointIndex: number, world: Vec2): JointParam {
  const n = centres.length;
  const [ai, bi] = jointAnchors(n)[jointIndex];
  const a = centres[ai];
  const d = sub(centres[bi], a);
  const len2 = d.x * d.x + d.y * d.y;
  if (len2 < 1e-12) return defaultJointParams(n)[jointIndex];
  const rel = sub(world, a);
  const perp = perpOf(d);
  return {
    along: (rel.x * d.x + rel.y * d.y) / len2,
    perp: (rel.x * perp.x + rel.y * perp.y) / len2,
  };
}

/** Where token centre `c` sits within the frame of its segment a→b. */
function seatOf(a: Vec2, b: Vec2, c: Vec2): { seatAlong: number; seatPerp: number } {
  const d = sub(b, a);
  const len2 = d.x * d.x + d.y * d.y;
  if (len2 < 1e-12) return { seatAlong: 0.5, seatPerp: 0 };
  const rel = sub(c, a);
  const perp = perpOf(d);
  return {
    seatAlong: (rel.x * d.x + rel.y * d.y) / len2,
    seatPerp: (rel.x * perp.x + rel.y * perp.y) / len2,
  };
}

/**
 * Capture each token's rigid-segment data (segment length + where its centre
 * sits within the segment frame) from a rest pose and joint params. Call when a
 * chain enters segment-rig mode or after a pivot is dragged.
 */
export function captureSegments(centres: Vec2[], params?: JointParam[]): SegData[] {
  const joints = reconstructJoints(centres, params);
  return centres.map((c, i) => {
    const a = joints[i];
    const b = joints[i + 1];
    return { len: dist(a, b), ...seatOf(a, b, c) };
  });
}

/** Re-seat every token within its segment's frame (along + perpendicular). */
export function seatTokens(joints: Vec2[], seg: SegData[]): Vec2[] {
  return seg.map((s, i) => {
    const d = sub(joints[i + 1], joints[i]);
    return add(joints[i], add(scale(d, s.seatAlong), scale(perpOf(d), s.seatPerp)));
  });
}

/** World-space direction (radians) of each token's segment, given the joints. */
export function jointAngles(joints: Vec2[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < joints.length; i++) out.push(angle(joints[i], joints[i + 1]));
  return out;
}

/** Each token's segment direction (radians) from centres + (optional) params. */
export function segmentAngles(centres: Vec2[], params?: JointParam[]): number[] {
  return jointAngles(reconstructJoints(centres, params));
}

/**
 * Solve a segment rig's JOINTS by reaching the grabbed token's DISTAL joint to
 * `target`. The centres + params seed the joints; FABRIK solves root (pinned) →
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
  params?: JointParam[],
): Vec2[] {
  const n = centres.length;
  const joints = reconstructJoints(centres, params); // n + 1 points
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
