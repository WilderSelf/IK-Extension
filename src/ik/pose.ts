import type { Chain, Vec2 } from "../types";
import { solveChain, type SolveOptions } from "./fabrik";
import { branchPath, childrenOf, subtree } from "./tree";
import { add, angle, rotateAround, sub } from "./vec";

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
 * to the world position it should reach. For each target the path root->target
 * is solved with FABRIK (root pinned), and everything beyond the target is
 * carried rigidly (translated + rotated with the target's incoming bone).
 *
 * Branches are independent, so multiple targets on different root-branches are
 * solved without interfering.
 */
export function solvePose(
  chain: Chain,
  positions: Record<string, Vec2>,
  targets: Record<string, Vec2>,
  opts?: SolveOptions,
): Pose {
  const out: Record<string, Vec2> = { ...positions };

  for (const [targetId, targetPos] of Object.entries(targets)) {
    if (!(targetId in chain.nodes) || targetId === chain.rootId) continue;

    const path = branchPath(chain, targetId); // [root, ..., targetId]
    const pts = path.map((id) => out[id] ?? positions[id]);
    const rest = path.slice(1).map((id) => chain.nodes[id].restLength);

    const oldTarget = out[targetId];
    const oldParent = out[path[path.length - 2]];

    const solved = solveChain(pts, rest, targetPos, opts);
    path.forEach((id, i) => {
      out[id] = solved[i];
    });

    const newTarget = solved[solved.length - 1];
    const newParent = solved[solved.length - 2];

    // Rigid carry of the sub-tree beyond the grabbed node:
    //   newPos = newTarget + R(dRot) * (oldPos - oldTarget)
    const dRot = angle(newParent, newTarget) - angle(oldParent, oldTarget);
    for (const s of subtree(chain, targetId)) {
      const translated = add(positions[s], sub(newTarget, oldTarget));
      out[s] = rotateAround(translated, newTarget, dRot);
    }
  }

  return { positions: out, rotations: boneAngles(chain, out) };
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
