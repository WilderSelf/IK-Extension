/**
 * Multi-effector FABRIK over a fork.
 *
 * When two (or more) grabbed tips share an intermediate joint — an unlocked
 * sub-base — solving each root->tip path on its own makes them fight over the
 * shared joint (last write wins). This solver poses the whole active sub-tree at
 * once: the shared sub-base settles at the average of what each branch wants
 * (classic FABRIK sub-base centroid), so the branches negotiate instead of
 * clobbering each other.
 *
 * The chain root is pinned to its original position; so is any locked joint on
 * the active tree (a locked node stays put and its sub-branches flex from it).
 */
import type { Chain, Vec2 } from "../types";
import { branchPath, childrenMap, orderedNodes } from "./tree";
import { add, angle, dir, dist, scale } from "./vec";

export interface TreeSolveResult {
  /** New positions for every node on the active tree (root -> each target). */
  positions: Record<string, Vec2>;
  /** The active node ids (root and every joint on a path to a target). */
  active: Set<string>;
}

/**
 * Jointly solve the union of root->target paths for `targets` (a fork's grabbed
 * tips). Positions are seeded from `snap`. Returns new positions for the active
 * nodes only; callers rigidly carry off-tree sub-trees separately.
 */
export function solveTree(
  chain: Chain,
  snap: Record<string, Vec2>,
  targets: Record<string, Vec2>,
  opts: { iterations?: number; tolerance?: number } = {},
): TreeSolveResult {
  const iterations = opts.iterations ?? 16;
  const tolerance = opts.tolerance ?? 0.5;
  const locked = (id: string) => !!chain.settings.nodeOverrides?.[id]?.locked;

  // Active node set = union of every root->target path.
  const active = new Set<string>();
  for (const id of Object.keys(targets)) {
    for (const n of branchPath(chain, id)) active.add(n);
  }

  // Root-first topological order restricted to the active tree (parents precede
  // children), plus its reverse for the backward pass.
  const topo = orderedNodes(chain).map((n) => n.id).filter((id) => active.has(id));
  const revTopo = [...topo].reverse();

  const kids = childrenMap(chain);
  const activeChildren = (id: string) => (kids.get(id) ?? []).filter((c) => active.has(c));

  // Fixed anchors: the root and any locked joint hold their original position.
  const isFixed = (id: string) => id === chain.rootId || locked(id);
  const restOf = (id: string) => chain.nodes[id].restLength;

  const pos: Record<string, Vec2> = {};
  for (const id of active) pos[id] = { ...snap[id] };

  for (let iter = 0; iter < iterations; iter++) {
    // Backward reaching: pin each effector to its target, then walk toward the
    // root. A sub-base takes the centroid of the position each child wants for it.
    for (const [tid, tp] of Object.entries(targets)) pos[tid] = { ...tp };
    for (const id of revTopo) {
      if (id in targets) continue; // effector already pinned to its target
      const children = activeChildren(id);
      if (children.length === 0) continue;
      let sx = 0;
      let sy = 0;
      for (const c of children) {
        const d = dir(pos[c], pos[id]); // from child toward the current joint
        const cand = add(pos[c], scale(d, restOf(c)));
        sx += cand.x;
        sy += cand.y;
      }
      pos[id] = { x: sx / children.length, y: sy / children.length };
    }

    // Forward reaching: re-pin fixed nodes to their originals, propagate outward
    // toward each effector at fixed bone lengths.
    for (const id of topo) {
      if (isFixed(id)) {
        pos[id] = { ...snap[id] };
        continue;
      }
      const parentId = chain.nodes[id].parentId!;
      const d = dir(pos[parentId], pos[id]); // parent -> this joint's backward estimate
      pos[id] = add(pos[parentId], scale(d, restOf(id)));
    }

    let worst = 0;
    for (const [tid, tp] of Object.entries(targets)) worst = Math.max(worst, dist(pos[tid], tp));
    if (worst < tolerance) break;
  }

  return { positions: pos, active };
}

/**
 * Bone-frame transform (translation + incoming-bone rotation) that a node
 * underwent between `snap` and `out`. Used to rigidly carry a node's off-tree
 * sub-trees. `dRot` falls back to 0 for a degenerate (zero-length) bone.
 */
export function nodeTransform(
  chain: Chain,
  snap: Record<string, Vec2>,
  out: Record<string, Vec2>,
  id: string,
): { trans: Vec2; dRot: number } {
  const parentId = chain.nodes[id].parentId;
  const trans = { x: out[id].x - snap[id].x, y: out[id].y - snap[id].y };
  let dRot = 0;
  if (parentId && snap[parentId] && out[parentId]) {
    if (dist(snap[parentId], snap[id]) > 1e-9 && dist(out[parentId], out[id]) > 1e-9) {
      dRot = angle(out[parentId], out[id]) - angle(snap[parentId], snap[id]);
    }
  }
  return { trans, dRot };
}
