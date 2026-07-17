import type { Vec2 } from "../types";
import { add, angle, dir, dist, scale } from "./vec";

/**
 * A bend limit in radians for one joint, expressed relative to the incoming
 * bone. `min <= max`, both in (-π, π].
 */
export interface AngleLimit {
  min: number;
  max: number;
}

export interface SolveOptions {
  /** Max solver iterations per solve. */
  iterations?: number;
  /** Convergence tolerance in scene units. */
  tolerance?: number;
  /**
   * Optional per-point bend limits, aligned with `points`. `constraints[k]`
   * limits the angle of bone (k-1 -> k) relative to bone (k-2 -> k-1) and so
   * only applies for k >= 2 (a joint needs a reference bone above it). Entries
   * that are null/undefined leave that joint free.
   */
  constraints?: (AngleLimit | null | undefined)[];
}

/** Wrap an angle into (-π, π]. */
function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * Classic 2D FABRIK (Forward And Backward Reaching Inverse Kinematics).
 *
 * `points[0]` is the root and is held fixed at its incoming position. The last
 * point is driven toward `target`. `restLengths[i]` is the fixed distance
 * between `points[i]` and `points[i+1]` (so `restLengths.length === points.length - 1`).
 *
 * Optional per-joint bend limits via `opts.constraints` clamp each joint's
 * angle during the forward pass (see `SolveOptions`). Returns a NEW array;
 * inputs are not mutated.
 *
 * If the target is farther than the chain can reach, an unconstrained chain
 * straightens directly toward the target from the root; a constrained one falls
 * through to the iterative solver so its limits are still respected.
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
  const constraints = opts.constraints;
  const hasConstraints = !!constraints?.some(Boolean);

  const total = restLengths.reduce((s, l) => s + l, 0);
  const p = points.map((pt) => ({ ...pt }));

  // A chain with no length (all-zero rest, e.g. coincident tokens captured at
  // build time) has nothing to solve — return it unchanged rather than collapse
  // every node onto the root via the straighten path below.
  if (total <= 0) return p;

  // Unreachable target: point the whole chain straight at it. This shortcut
  // ignores bend limits, so skip it when any joint is constrained and let the
  // iterative solver settle into a constraint-respecting reach instead.
  if (!hasConstraints && dist(root, target) >= total) {
    const d = dir(root, target);
    p[0] = root;
    for (let i = 1; i < n; i++) {
      p[i] = add(p[i - 1], scale(d, restLengths[i - 1]));
    }
    return p;
  }

  for (let iter = 0; iter < iterations; iter++) {
    // Backward reaching: pull the end effector onto the target.
    p[n - 1] = { ...target };
    for (let i = n - 2; i >= 0; i--) {
      const d = dir(p[i + 1], p[i]);
      p[i] = add(p[i + 1], scale(d, restLengths[i]));
    }

    // Forward reaching: re-pin the root and propagate outward, clamping each
    // joint's bend to its limit (relative to the already-placed incoming bone).
    p[0] = { ...root };
    for (let i = 1; i < n; i++) {
      let outAngle = angle(p[i - 1], p[i]);
      const limit = i >= 2 ? constraints?.[i] : undefined;
      if (limit) {
        const inAngle = angle(p[i - 2], p[i - 1]);
        const rel = wrapAngle(outAngle - inAngle);
        // Tolerate an inverted limit (min > max, e.g. a user typo in the
        // sidebar): order the bounds so the joint clamps to the real range
        // instead of collapsing onto a single angle.
        const lo = Math.min(limit.min, limit.max);
        const hi = Math.max(limit.min, limit.max);
        const clamped = Math.min(hi, Math.max(lo, rel));
        outAngle = inAngle + clamped;
      }
      p[i] = add(p[i - 1], scale({ x: Math.cos(outAngle), y: Math.sin(outAngle) }, restLengths[i - 1]));
    }

    if (!hasConstraints && dist(p[n - 1], target) < tolerance) break;
  }

  return p;
}
