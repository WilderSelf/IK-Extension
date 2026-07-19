import type { Chain, Vec2 } from "../types";
import { orderedNodes } from "../model/chains";
import { solveChain, type SolveOptions } from "./fabrik";
import { add, angle, dist, rotateAround, sub } from "./vec";

/** Positions (and bone-angle rotations, in radians) for chain nodes. */
export interface Pose {
  positions: Record<string, Vec2>;
  /** Bone angle (math radians, parent -> node) for each node. */
  rotations: Record<string, number>;
}

/**
 * Rigidly translate every node in the chain by `delta`. Used when the root
 * itself is dragged — the whole strand moves as one, orientations unchanged.
 */
export function rigidTranslate(
  chain: Chain,
  positions: Record<string, Vec2>,
  delta: Vec2,
): Pose {
  const out: Record<string, Vec2> = {};
  for (const id of Object.keys(chain.nodes)) {
    const p = positions[id];
    out[id] = p ? add(p, delta) : p;
  }
  return { positions: out, rotations: boneAngles(chain, out) };
}

/**
 * Solve the strand for a grabbed node reaching `targetPos`.
 *
 * FABRIK solves the path root->grabbed (root pinned, rest lengths preserved);
 * every node BEYOND the grabbed one is carried rigidly — translated by the
 * grabbed node's displacement and rotated by its incoming-bone turn — so the
 * tip trails naturally instead of detaching or re-solving.
 */
export function solvePose(
  chain: Chain,
  positions: Record<string, Vec2>,
  grabbedId: string,
  targetPos: Vec2,
  opts?: SolveOptions,
): Pose {
  const out: Record<string, Vec2> = { ...positions };
  const order = orderedNodes(chain);
  const gi = order.indexOf(grabbedId);

  // The grabbed node must be in the strand and not the root, and every node on
  // the root->grabbed path must have a position (a gap would inject NaN).
  if (gi <= 0) return { positions: out, rotations: boneAngles(chain, out) };
  const path = order.slice(0, gi + 1); // [root, ..., grabbed]
  if (!path.every((id) => out[id])) {
    return { positions: out, rotations: boneAngles(chain, out) };
  }

  const snap: Record<string, Vec2> = { ...out };
  const pts = path.map((id) => snap[id]);
  const rest = path.slice(1).map((id) => chain.nodes[id].restLength);
  const solved = solveChain(pts, rest, targetPos, opts);
  path.forEach((id, i) => {
    out[id] = solved[i];
  });

  // Rigidly carry the tail (nodes past the grabbed one). Measure the grabbed
  // node's translation + incoming-bone rotation against the pre-solve frame.
  const oldSelf = snap[grabbedId];
  const oldParent = snap[order[gi - 1]];
  const newSelf = out[grabbedId];
  const newParent = out[order[gi - 1]];
  const trans = sub(newSelf, oldSelf);
  // atan2(0,0) is 0, so a zero-length bone would yield a bogus rotation — fall
  // back to translation-only when either frame is degenerate.
  const dRot =
    dist(oldParent, oldSelf) > 1e-9 && dist(newParent, newSelf) > 1e-9
      ? angle(newParent, newSelf) - angle(oldParent, oldSelf)
      : 0;
  for (let i = gi + 1; i < order.length; i++) {
    const id = order[i];
    const base = snap[id];
    if (!base) continue;
    out[id] = rotateAround(add(base, trans), newSelf, dRot);
  }

  return { positions: out, rotations: boneAngles(chain, out) };
}

/**
 * Bone angle (math radians) for every node: the direction from its parent to
 * itself. The root uses the direction toward its (single) child.
 */
export function boneAngles(
  chain: Chain,
  positions: Record<string, Vec2>,
): Record<string, number> {
  const order = orderedNodes(chain);
  const rot: Record<string, number> = {};
  order.forEach((id, i) => {
    const self = positions[id];
    if (!self) return;
    const node = chain.nodes[id];
    if (node.parentId && positions[node.parentId]) {
      rot[id] = angle(positions[node.parentId], self);
    } else {
      // root: face its child if any
      const childId = order[i + 1];
      const child = childId ? positions[childId] : undefined;
      rot[id] = child ? angle(self, child) : 0;
    }
  });
  return rot;
}
