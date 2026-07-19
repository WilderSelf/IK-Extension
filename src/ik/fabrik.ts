import type { Vec2 } from "../types";
import { add, dir, dist, scale } from "./vec";

export interface SolveOptions {
  /** Max solver iterations per solve. */
  iterations?: number;
  /** Convergence tolerance in scene units. */
  tolerance?: number;
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

  const total = restLengths.reduce((s, l) => s + l, 0);
  const p = points.map((pt) => ({ ...pt }));

  // A chain with no length (all-zero rest, e.g. coincident tokens captured at
  // build time) has nothing to solve — return it unchanged rather than collapse
  // every node onto the root via the straighten path below.
  if (total <= 0) return p;

  // Unreachable target: point the whole chain straight at it.
  if (dist(root, target) >= total) {
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

    // Forward reaching: re-pin the root and propagate outward.
    p[0] = { ...root };
    for (let i = 1; i < n; i++) {
      const d = dir(p[i - 1], p[i]);
      p[i] = add(p[i - 1], scale(d, restLengths[i - 1]));
    }

    if (dist(p[n - 1], target) < tolerance) break;
  }

  return p;
}
