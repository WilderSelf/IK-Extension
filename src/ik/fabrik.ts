import type { Vec2 } from "../types";
import { add, angle, dir, dist, scale } from "./vec";

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
}

/** Wrap an angle into (-π, π]. */
function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
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
  const hasStiffness = !!stiffness?.some((s) => s !== 0);

  const total = restLengths.reduce((s, l) => s + l, 0);
  const p = points.map((pt) => ({ ...pt }));

  // A chain with no length (all-zero rest, e.g. coincident tokens captured at
  // build time) has nothing to solve — return it unchanged rather than collapse
  // every node onto the root via the straighten path below.
  if (total <= 0) return p;

  // Unreachable target: point the whole chain straight at it. This shortcut
  // ignores stiffness, so skip it when any bone is weighted and let the
  // iterative solver settle into a stiffness-respecting reach instead.
  if (!hasStiffness && dist(root, target) >= total) {
    const d = dir(root, target);
    p[0] = root;
    for (let i = 1; i < n; i++) {
      p[i] = add(p[i - 1], scale(d, restLengths[i - 1]));
    }
    return p;
  }

  // Pre-solve bone angles: the reference each weighted bone relaxes back toward.
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

    // Forward reaching: re-pin the root and propagate outward. With stiffness,
    // scale each bone's turn toward its ideal angle by (1 - retention) about its
    // pre-solve angle, so stiff bones barely swing and the bend flows elsewhere.
    p[0] = { ...root };
    if (refAngles) {
      for (let i = 1; i < n; i++) {
        const b = i - 1;
        const ret = stiffness![b] ?? 0;
        let a = angle(p[i - 1], p[i]);
        if (ret !== 0) a = refAngles[b] + wrapAngle(a - refAngles[b]) * (1 - ret);
        p[i] = add(p[i - 1], scale({ x: Math.cos(a), y: Math.sin(a) }, restLengths[b]));
      }
    } else {
      for (let i = 1; i < n; i++) {
        const d = dir(p[i - 1], p[i]);
        p[i] = add(p[i - 1], scale(d, restLengths[i - 1]));
      }
    }

    // A weighted solve keeps iterating so the stiffness settles; only the plain
    // path may bail early once the tip is within tolerance.
    if (!hasStiffness && dist(p[n - 1], target) < tolerance) break;
  }

  return p;
}
