import type { Chain, Vec2 } from "../types";
import { solveChain, type SolveOptions } from "./fabrik";
import { branchPath, childrenMap, childrenOf } from "./tree";
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
  const kids = childrenMap(chain);

  for (const [targetId, targetPos] of Object.entries(targets)) {
    if (!(targetId in chain.nodes) || targetId === chain.rootId) continue;

    const path = branchPath(chain, targetId); // [root, ..., targetId]

    // Snapshot pre-solve positions for THIS target so the rigid carry below is
    // measured against a stable frame (correct even across sequential targets).
    const snap: Record<string, Vec2> = { ...out };
    const pts = path.map((id) => snap[id]);
    // A path node with no known position (e.g. its token was deleted mid-drag)
    // would inject NaN through the solver and persist it — skip this target.
    if (pts.some((p) => !p)) continue;

    const rest = path.slice(1).map((id) => chain.nodes[id].restLength);
    const solved = solveChain(pts, rest, targetPos, opts);
    path.forEach((id, i) => {
      out[id] = solved[i];
    });

    // Rigidly carry every sub-tree that hangs OFF the solved path — not just the
    // grabbed node's own descendants. Each joint on the path moved (and rotated
    // about its incoming bone), so its off-path children must ride along or the
    // bone to a sibling branch would silently stretch/detach. The root (i=0) is
    // pinned, so its branches never move here.
    for (let i = 1; i < path.length; i++) {
      const nodeId = path[i];
      const nextOnPath: string | undefined = path[i + 1];
      const oldSelf = snap[nodeId];
      const oldParent = snap[path[i - 1]];
      const newSelf = solved[i];
      const newParent = solved[i - 1];
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

  return { positions: out, rotations: boneAngles(chain, out) };
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
