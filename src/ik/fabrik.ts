import type { BendLimit, Vec2 } from "../types";
import { add, angle, dir, dist, scale, wrapAngle } from "./vec";

export interface SolveOptions {
  /** Max solver iterations per solve. */
  iterations?: number;
  /** Convergence tolerance in scene units. */
  tolerance?: number;
  /**
   * Optional per-bone stiffness *retention* factors, aligned with `restLengths`
   * (so `stiffness[b]` governs the bone from `points[b]` to `points[b+1]`). In
   * the forward pass each bone's turn toward its ideal angle is scaled by
   * `(1 - retention)` about its pre-solve angle: 0 leaves the bone free, a
   * positive value resists the turn (stiff), a negative one over-relaxes it
   * (loose). Absent or all-zero ⇒ the plain unweighted solver runs unchanged.
   */
  stiffness?: number[];
  /**
   * Optional per-joint bend limits, aligned with `points`. `limits[i]` clamps
   * the bend at point `i` — the angle of bone (i-1 → i) relative to bone
   * (i-2 → i-1) — so it only applies for `i >= 2` (a joint needs a reference
   * bone above it). Null/undefined entries leave that joint free. Absent or
   * all-null ⇒ the plain solver runs unchanged.
   */
  limits?: (BendLimit | null | undefined)[];
  /**
   * Optional ANCHOR limit on the ROOT's outgoing bone (point 0 → 1), clamped
   * relative to `anchorRef` (a world reference angle in radians — a parent
   * token's orientation). This is the one joint a plain bend limit can't reach:
   * the root has no bone above it *inside* the chain, so the parent supplies the
   * reference. Applied only at `i === 1`, and only when both are present.
   */
  anchorRef?: number;
  anchorLimit?: BendLimit | null;
}

/**
 * Classic 2D FABRIK (Forward And Backward Reaching Inverse Kinematics).
 *
 * `points[0]` is the root, held fixed at its incoming position. The last point
 * is driven toward `target`. `restLengths[i]` is the fixed distance between
 * `points[i]` and `points[i+1]` (so `restLengths.length === points.length - 1`).
 * Returns a NEW array; inputs are not mutated.
 *
 * Linear per solve and capped at `iterations` (default 12) so a hot drag loop
 * stays cheap. If the target is farther than the chain can reach, the chain
 * straightens directly toward it from the root.
 */
export function solveChain(
  points: Vec2[],
  restLengths: number[],
  target: Vec2,
  opts: SolveOptions = {},
): Vec2[] {
  const n = points.length;
  if (n === 0) return [];
  const root = { ...points[0] };
  if (n === 1) return [root];

  const iterations = opts.iterations ?? 12;
  const tolerance = opts.tolerance ?? 0.5;
  const stiffness = opts.stiffness;
  const limits = opts.limits;
  const hasStiffness = !!stiffness?.some((s) => s !== 0);
  const hasLimits = !!limits?.some(Boolean);
  const anchorRef = opts.anchorRef;
  const anchorLimit = opts.anchorLimit;
  const hasAnchor = anchorLimit != null && anchorRef !== undefined;
  // Any weighting takes the angle-based forward pass; a plain solve stays on the
  // original fast path and is byte-identical to the unweighted solver.
  const weighted = hasStiffness || hasLimits || hasAnchor;

  const total = restLengths.reduce((s, l) => s + l, 0);
  const p = points.map((pt) => ({ ...pt }));

  // A chain with no length (all-zero rest, e.g. coincident tokens captured at
  // build time) has nothing to solve — return it unchanged rather than collapse
  // every node onto the root via the straighten path below.
  if (total <= 0) return p;

  // Unreachable target: point the whole chain straight at it. This shortcut
  // ignores stiffness and limits, so skip it when either is in play and let the
  // iterative solver settle into a constraint-respecting reach instead.
  if (!weighted && dist(root, target) >= total) {
    const d = dir(root, target);
    p[0] = root;
    for (let i = 1; i < n; i++) {
      p[i] = add(p[i - 1], scale(d, restLengths[i - 1]));
    }
    return p;
  }

  // Pre-solve bone angles: the reference each stiff bone relaxes back toward.
  const refAngles = hasStiffness
    ? Array.from({ length: n - 1 }, (_, b) => angle(points[b], points[b + 1]))
    : undefined;

  for (let iter = 0; iter < iterations; iter++) {
    // Backward reaching: pull the end effector onto the target.
    p[n - 1] = { ...target };
    for (let i = n - 2; i >= 0; i--) {
      const d = dir(p[i + 1], p[i]);
      p[i] = add(p[i + 1], scale(d, restLengths[i]));
    }

    // Forward reaching: re-pin the root and propagate outward. Stiffness scales
    // each bone's turn toward its ideal angle about its pre-solve angle; a bend
    // limit then hard-clamps the joint's angle relative to its incoming bone.
    p[0] = { ...root };
    if (weighted) {
      for (let i = 1; i < n; i++) {
        let a = angle(p[i - 1], p[i]);
        if (refAngles) {
          const ret = stiffness![i - 1] ?? 0;
          if (ret !== 0) a = refAngles[i - 1] + wrapAngle(a - refAngles[i - 1]) * (1 - ret);
        }
        const limit = i >= 2 ? limits?.[i] : undefined;
        if (limit) {
          const inAngle = angle(p[i - 2], p[i - 1]);
          const rel = wrapAngle(a - inAngle);
          // Order the bounds so an inverted range still clamps to a real interval.
          const lo = Math.min(limit.min, limit.max);
          const hi = Math.max(limit.min, limit.max);
          a = inAngle + Math.min(hi, Math.max(lo, rel));
        } else if (i === 1 && hasAnchor) {
          // The root's own bone, clamped against the external reference angle.
          const rel = wrapAngle(a - anchorRef!);
          const lo = Math.min(anchorLimit!.min, anchorLimit!.max);
          const hi = Math.max(anchorLimit!.min, anchorLimit!.max);
          a = anchorRef! + Math.min(hi, Math.max(lo, rel));
        }
        p[i] = add(p[i - 1], scale({ x: Math.cos(a), y: Math.sin(a) }, restLengths[i - 1]));
      }
    } else {
      for (let i = 1; i < n; i++) {
        const d = dir(p[i - 1], p[i]);
        p[i] = add(p[i - 1], scale(d, restLengths[i - 1]));
      }
    }

    // A weighted solve keeps iterating so stiffness/limits settle; only the plain
    // path may bail early once the tip is within tolerance.
    if (!weighted && dist(p[n - 1], target) < tolerance) break;
  }

  return p;
}
