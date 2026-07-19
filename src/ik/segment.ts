import { type Vec2 } from "../types";
import { solveChain, type SolveOptions } from "./fabrik";
import { add, angle, dist, rotateAround, scale, sub } from "./vec";

/**
 * SEGMENT RIG — pivot at joints, not centres.
 *
 * The default rig treats each token's CENTRE as a FABRIK point, so a token
 * rotates about its own centre. A limb segment must instead pivot at its JOINT
 * (the proximal end where it meets its parent). A chain's N token centres imply
 * N+1 JOINTS.
 *
 * Each joint is anchored RIGIDLY to a token: its position is fixed in that
 * token's own rotated frame, so it follows the token exactly as the rig poses.
 * That's the whole point — a joint reconstructed from `centre + rotation` cannot
 * "wander" the way one re-derived from bent centre midpoints does. The geometry
 * is fully encoded by each token's transform plus its captured `SegData` (segment
 * length, where the centre sits in the segment frame, and the token's rotation
 * offset from the segment direction) — there is no separate pivot array.
 *
 * `deriveMidpointJoints` gives the DEFAULT joint layout (adjacent-centre
 * midpoints, ends reflected) which `captureSegData` freezes into rigid `SegData`
 * when limb mode is turned on; dragging a joint just recaptures against a moved
 * joint set. Everything here is pure geometry (no Owlbear), so the rigid-follow
 * invariant is unit testable; only the on-canvas feel needs a live check.
 */

/** Per-token rigid-segment data, captured once from a rest pose. */
export interface SegData {
  /** Fixed length of this token's segment (joint i → joint i+1). */
  len: number;
  /** Token centre along its segment, as a fraction of the segment length. */
  seatAlong: number;
  /** Token centre perpendicular to its segment, as a fraction of its length. */
  seatPerp: number;
  /** Token rotation (deg) minus the segment direction (deg) — the seg-model offset. */
  offsetDeg: number;
}

const perpOf = (d: Vec2): Vec2 => ({ x: -d.y, y: d.x });
const DEG = Math.PI / 180;

/**
 * The DEFAULT joints for N token centres: interior joints at midpoints of
 * adjacent centres, the ends reflected outward (`2*Cend - Mnear`). N<2 is
 * degenerate → a single zero-length segment at the lone centre. Used only to
 * seed a fresh capture; live reconstruction is rigid (`reconstructJoints`).
 */
export function deriveMidpointJoints(centres: Vec2[]): Vec2[] {
  const n = centres.length;
  if (n === 0) return [];
  if (n === 1) return [centres[0], centres[0]];
  const mids: Vec2[] = [];
  for (let i = 0; i < n - 1; i++) mids.push(scale(add(centres[i], centres[i + 1]), 0.5));
  const first = sub(scale(centres[0], 2), mids[0]); // 2*C0 - M0
  const last = sub(scale(centres[n - 1], 2), mids[n - 2]); // 2*C_{n-1} - M_{n-2}
  return [first, ...mids, last];
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
 * Freeze a joint layout into per-token `SegData`, measured against each token's
 * centre + rotation (deg). This is what makes joints rigid: the segment length,
 * the centre's seat within the segment frame, and the rotation offset are all
 * captured so `reconstructJoints` can rebuild the joints from the transforms
 * alone. Call on enable (with `deriveMidpointJoints`) or after a joint is dragged.
 */
export function captureSegData(centres: Vec2[], rotationsDeg: number[], joints: Vec2[]): SegData[] {
  return centres.map((c, i) => {
    const a = joints[i];
    const b = joints[i + 1];
    const seat = seatOf(a, b, c);
    return {
      len: dist(a, b),
      seatAlong: seat.seatAlong,
      seatPerp: seat.seatPerp,
      offsetDeg: (rotationsDeg[i] ?? 0) - (angle(a, b) * 180) / Math.PI,
    };
  });
}

/**
 * Rigidly reconstruct the N+1 joints from token centres + rotations (deg) + the
 * captured `SegData`. Each token's rotation gives its segment DIRECTION (rotation
 * − offset); the chain is walked from the root's proximal joint, adding each
 * segment vector. So every joint is fixed relative to the tokens and follows them
 * as they pose — no wander. N<2 → a single zero-length segment.
 */
export function reconstructJoints(centres: Vec2[], rotationsDeg: number[], seg: SegData[]): Vec2[] {
  const n = centres.length;
  if (n === 0) return [];
  if (n === 1) return [centres[0], centres[0]];
  const dirs = seg.map((s, i) => {
    const t = ((rotationsDeg[i] ?? 0) - s.offsetDeg) * DEG;
    return { x: Math.cos(t), y: Math.sin(t) };
  });
  // Root proximal joint: fixed in token 0's frame (its shoulder).
  const j0 = sub(centres[0], add(scale(dirs[0], seg[0].seatAlong * seg[0].len), scale(perpOf(dirs[0]), seg[0].seatPerp * seg[0].len)));
  const joints: Vec2[] = [j0];
  for (let i = 0; i < n; i++) joints.push(add(joints[i], scale(dirs[i], seg[i].len)));
  return joints;
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

/**
 * Solve a segment rig's JOINTS by reaching the grabbed token's DISTAL joint to
 * `target`. The centres + rotations + seg rigidly seed the joints; FABRIK solves
 * root (pinned) → effector; joints past the effector are carried rigidly. Returns
 * the N+1 solved joints — feed them to `seatTokens` for centres and `jointAngles`
 * for orientations.
 *
 * `grabbedIndex` is the token's index in root→tip order and must be ≥ 1 (grabbing
 * the root translates the whole rig instead, handled by the caller).
 */
export function solveSegmentJoints(
  centres: Vec2[],
  rotationsDeg: number[],
  seg: SegData[],
  grabbedIndex: number,
  target: Vec2,
  opts?: SolveOptions,
): Vec2[] {
  const n = centres.length;
  const joints = reconstructJoints(centres, rotationsDeg, seg); // n + 1 points
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
