import type { Chain, Vec2 } from "../types";
import { solveChain, type SolveOptions } from "./fabrik";
import { branchPath, childrenMap, childrenOf, lowestCommonAncestor } from "./tree";
import { nodeTransform, solveTree } from "./multi";
import { add, angle, dist, rotateAround, sub } from "./vec";

/** Positions (and bone-angle rotations, in radians) for chain nodes. */
export interface Pose {
  positions: Record<string, Vec2>;
  /** Bone angle (math radians, parent -> node) for each node. */
  rotations: Record<string, number>;
}

/**
 * Rigidly translate every node in the chain by `delta`. Used when the root
 * itself is dragged — the whole tree moves as one, orientations unchanged.
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
 * Solve the chain for one or more grabbed target nodes.
 *
 * `targets` maps a grabbed node id (the shallowest selected node in its branch)
 * to the world position it should reach. Each target's path root->target is
 * solved with FABRIK (root pinned), and everything beyond the target is carried
 * rigidly (translated + rotated with the target's incoming bone).
 *
 * Targets on genuinely independent branches are solved one at a time. But when
 * two targets fork off a *shared unlocked joint* (a sub-base), solving them
 * independently makes them fight over that joint — so such targets are grouped
 * and solved jointly with multi-effector FABRIK, where the shared joint settles
 * at the average of what each branch wants. A locked joint pins its segment, so
 * anything anchored above a lock is never contested.
 */
export function solvePose(
  chain: Chain,
  positions: Record<string, Vec2>,
  targets: Record<string, Vec2>,
  opts?: SolveOptions,
): Pose {
  const out: Record<string, Vec2> = { ...positions };
  const kids = childrenMap(chain);

  // Keep only well-formed targets: in the chain, not the root, and with every
  // node on their path positioned (a missing position would inject NaN).
  const ids = Object.keys(targets).filter((id) => {
    if (!(id in chain.nodes) || id === chain.rootId) return false;
    return branchPath(chain, id).every((n) => out[n]);
  });

  for (const group of groupBySharedSubBase(chain, ids)) {
    if (group.length === 1) {
      solveSingleTarget(chain, out, kids, group[0], targets[group[0]], opts);
    } else {
      const groupTargets: Record<string, Vec2> = {};
      for (const id of group) groupTargets[id] = targets[id];
      solveMultiTarget(chain, out, kids, groupTargets, opts);
    }
  }

  return { positions: out, rotations: boneAngles(chain, out) };
}

/** Index of the deepest locked node on `path` (excluding the grabbed tip), or 0. */
function pinIndex(chain: Chain, path: string[]): number {
  let baseIdx = 0;
  for (let i = 1; i < path.length - 1; i++) {
    if (chain.settings.nodeOverrides?.[path[i]]?.locked) baseIdx = i;
  }
  return baseIdx;
}

/**
 * Partition targets into groups that must be solved together. Two targets share
 * a group when their paths meet at a joint below any lock on the shared prefix —
 * i.e. a real, unlocked, contested sub-base. Independent targets are singletons.
 */
function groupBySharedSubBase(chain: Chain, ids: string[]): string[][] {
  const locked = (id: string) => !!chain.settings.nodeOverrides?.[id]?.locked;
  // Union-find over target indices.
  const parent = ids.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i: number, j: number) => {
    parent[find(i)] = find(j);
  };

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const lca = lowestCommonAncestor(chain, ids[i], ids[j]);
      if (!lca || lca === chain.rootId) continue; // meet only at the pinned root
      const prefix = branchPath(chain, lca); // root -> lca
      // The shared segment flexes only below the deepest lock on the prefix. If
      // that pin *is* the lca, the fork hangs off a fixed joint — not contested.
      let pinIdx = 0;
      for (let k = 1; k < prefix.length; k++) if (locked(prefix[k])) pinIdx = k;
      if (prefix[pinIdx] !== lca) union(i, j);
    }
  }

  const groups = new Map<number, string[]>();
  ids.forEach((id, i) => {
    const root = find(i);
    (groups.get(root) ?? groups.set(root, []).get(root)!).push(id);
  });
  return [...groups.values()];
}

/**
 * Solve one grabbed target: FABRIK on its root->target path (anchored at the
 * deepest locked ancestor), bend limits applied, then rigidly carry every
 * off-path sub-tree so sibling branches ride along instead of detaching.
 */
function solveSingleTarget(
  chain: Chain,
  out: Record<string, Vec2>,
  kids: Map<string, string[]>,
  targetId: string,
  targetPos: Vec2,
  opts?: SolveOptions,
): void {
  const path = branchPath(chain, targetId); // [root, ..., targetId]

  // Snapshot pre-solve positions so the rigid carry below is measured against a
  // stable frame (correct even across sequential targets).
  const snap: Record<string, Vec2> = { ...out };

  // A locked joint on the path acts as a pin (sub-base): the solve is anchored
  // at the DEEPEST locked ancestor of the grabbed node, so everything above it
  // stays put and only the segment below flexes. The grabbed node itself is
  // never locked, and the true root is always at least an implicit pin at 0.
  const baseIdx = pinIndex(chain, path);

  const solvePath = path.slice(baseIdx); // [pin, ..., targetId]
  const pts = solvePath.map((id) => snap[id]);

  const rest = solvePath.slice(1).map((id) => chain.nodes[id].restLength);
  // Bend limits aligned with `pts`: a joint needs a reference bone above it,
  // so only nodes at sub-path index >= 2 can be constrained. Degrees in the
  // model -> radians for the solver.
  const constraints = solvePath.map((id, i) => {
    if (i < 2) return undefined;
    const c = chain.nodes[id].constraint;
    if (!c) return undefined;
    return { min: (c.minDeg * Math.PI) / 180, max: (c.maxDeg * Math.PI) / 180 };
  });
  const solved = solveChain(pts, rest, targetPos, { ...opts, constraints });
  solvePath.forEach((id, i) => {
    out[id] = solved[i];
  });

  // Rigidly carry every sub-tree that hangs OFF the solved path. Joints above
  // the pin (indices 0..baseIdx) never move, so start the carry just below it.
  for (let i = baseIdx + 1; i < path.length; i++) {
    const nodeId = path[i];
    const nextOnPath: string | undefined = path[i + 1];
    const oldSelf = snap[nodeId];
    const oldParent = snap[path[i - 1]];
    const newSelf = out[nodeId];
    const newParent = out[path[i - 1]];
    const trans = sub(newSelf, oldSelf);
    // atan2(0,0) is 0, so a zero-length bone would yield a bogus rotation —
    // fall back to translation-only when either frame is degenerate.
    const dRot =
      dist(oldParent, oldSelf) > 1e-9 && dist(newParent, newSelf) > 1e-9
        ? angle(newParent, newSelf) - angle(oldParent, oldSelf)
        : 0;

    for (const child of kids.get(nodeId) ?? []) {
      if (child === nextOnPath) continue;
      for (const s of collectSubtree(kids, child)) {
        const base = snap[s];
        if (!base) continue;
        out[s] = rotateAround(add(base, trans), newSelf, dRot);
      }
    }
  }
}

/**
 * Solve a group of targets that share an unlocked sub-base with multi-effector
 * FABRIK, then rigidly carry each active node's off-tree sub-trees. Per-joint
 * bend limits are not applied in this joint solve (single-chain only).
 */
function solveMultiTarget(
  chain: Chain,
  out: Record<string, Vec2>,
  kids: Map<string, string[]>,
  groupTargets: Record<string, Vec2>,
  opts?: SolveOptions,
): void {
  const snap: Record<string, Vec2> = { ...out };
  const { positions: solved, active } = solveTree(chain, snap, groupTargets, {
    iterations: opts?.iterations,
    tolerance: opts?.tolerance,
  });
  for (const id of active) out[id] = solved[id];

  for (const id of active) {
    const { trans, dRot } = nodeTransform(chain, snap, out, id);
    const newSelf = out[id];
    for (const child of kids.get(id) ?? []) {
      if (active.has(child)) continue;
      for (const s of collectSubtree(kids, child)) {
        const base = snap[s];
        if (!base) continue;
        out[s] = rotateAround(add(base, trans), newSelf, dRot);
      }
    }
  }
}

/** `startId` plus all its descendants, using a prebuilt child map (cycle-safe). */
function collectSubtree(kids: Map<string, string[]>, startId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [startId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    const ch = kids.get(id);
    if (ch) for (const c of ch) stack.push(c);
  }
  return out;
}

/**
 * Bone angle (math radians) for every node: the direction from its parent to
 * itself. The root uses the direction toward its first child.
 */
export function boneAngles(chain: Chain, positions: Record<string, Vec2>): Record<string, number> {
  const rot: Record<string, number> = {};
  for (const [id, node] of Object.entries(chain.nodes)) {
    const self = positions[id];
    if (!self) continue;
    if (node.parentId && positions[node.parentId]) {
      rot[id] = angle(positions[node.parentId], self);
    } else {
      // root: face first child if any
      const kids = childrenOf(chain, id);
      const firstChild = kids.length ? positions[kids[0]] : undefined;
      rot[id] = firstChild ? angle(self, firstChild) : 0;
    }
  }
  return rot;
}
