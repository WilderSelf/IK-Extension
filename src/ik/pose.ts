import { type Chain, type ChainMap, type Vec2, STIFFNESS_RETENTION } from "../types";
import { descendantChainIds, effectiveStiffness, orderedNodes, parentChainId } from "../model/chains";
import { solveChain, type SolveOptions } from "./fabrik";
import { add, angle, dist, rotateAround, sub, wrapAngle } from "./vec";

/**
 * The signed relative bend at each *limitable* joint of the chain, keyed by
 * token id — the outgoing bone's angle minus the incoming bone's, wrapped to
 * (-π, π]. Only nodes from the third onward have a reference bone above them, so
 * the root and the first movable node are absent. This is what "capture from
 * pose" reads and what the solver's bend limits clamp.
 */
export function relativeBends(
  chain: Chain,
  positions: Record<string, Vec2>,
): Record<string, number> {
  const order = orderedNodes(chain);
  const out: Record<string, number> = {};
  for (let i = 2; i < order.length; i++) {
    const a = positions[order[i - 2]];
    const b = positions[order[i - 1]];
    const c = positions[order[i]];
    if (a && b && c) out[order[i]] = wrapAngle(angle(b, c) - angle(a, b));
  }
  return out;
}

/**
 * Is `tokenId` (the root of chain `chainId`) a shared pivot — i.e. also a
 * NON-root segment of some other chain? Such a token is owned, orientation-wise,
 * by that other (parent) chain, so its own chain must not re-rotate it toward its
 * child. A plain standalone root is not shared and does rotate to face its child.
 */
function isSharedPivot(chains: ChainMap, chainId: string, tokenId: string): boolean {
  for (const [cid, c] of Object.entries(chains)) {
    if (cid === chainId) continue;
    if (tokenId in c.nodes && c.rootId !== tokenId) return true;
  }
  return false;
}

/** How a chain is being dragged: its root (rigid translate) or a node (solve). */
export type Grab =
  | { mode: "translate"; delta: Vec2 }
  | { mode: "solve"; grabbedId: string; target: Vec2 };

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
  // Per-bone stiffness, aligned with `rest`: bone b (path[b]->path[b+1]) is owned
  // by its child node path[b+1], so its resistance is that node's effective
  // stiffness. All-normal yields all-zero → the solver runs its plain path.
  const stiffness = path.slice(1).map((id) => STIFFNESS_RETENTION[effectiveStiffness(chain, id)]);
  // Per-joint bend limits, aligned with `path` (points): a limit at point i
  // clamps the bend there, so it applies only for i >= 2 (needs a bone above).
  const limits = path.map((id, i) => (i >= 2 ? chain.nodes[id].limit ?? null : null));
  const solved = solveChain(pts, rest, targetPos, { ...opts, stiffness, limits });
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
 * Pose a whole rig: solve/translate the grabbed chain, then rigidly carry every
 * chain that (transitively) follows one of its nodes, so a linked sub-rig (a
 * crab's pincher) rides along with its parent. Returns positions + bone-angle
 * rotations covering the posed chain AND all its descendants.
 *
 * `base` holds the pre-drag positions of every involved token (posed chain +
 * descendants). Posing a chain never moves its ancestors — only descendants.
 */
export function poseRig(
  chains: ChainMap,
  posedChainId: string,
  base: Record<string, Vec2>,
  grab: Grab,
  opts?: SolveOptions,
): Pose {
  const out: Record<string, Vec2> = { ...base };
  const posed = chains[posedChainId];
  if (posed) {
    const solved =
      grab.mode === "translate"
        ? rigidTranslate(posed, base, grab.delta)
        : solvePose(posed, base, grab.grabbedId, grab.target, opts);
    Object.assign(out, solved.positions);
  }

  const descendants = descendantChainIds(chains, posedChainId);

  // Bone angles per owning chain, cached (base is constant; `out` is final for a
  // given owner by the time its children are processed — BFS is parent-first).
  const baseAngles = new Map<string, Record<string, number>>();
  const curAngles = new Map<string, Record<string, number>>();
  const anglesOf = (
    cache: Map<string, Record<string, number>>,
    chainId: string,
    pos: Record<string, Vec2>,
  ): Record<string, number> => {
    let a = cache.get(chainId);
    if (!a) {
      a = boneAngles(chains[chainId], pos);
      cache.set(chainId, a);
    }
    return a;
  };

  for (const childId of descendants) {
    const child = chains[childId];
    const p = child.parentNodeId;
    const ownerId = parentChainId(chains, childId);
    if (!p || !ownerId || !(p in base) || !(p in out)) continue;
    const owner = chains[ownerId];
    // The parent node's rigid transform: translation, plus the turn of its
    // incoming bone. A pinned root doesn't rotate (its "bone angle" tracks its
    // first child, which would spin an attached sub-rig oddly), so use 0 there.
    const trans = sub(out[p], base[p]);
    const dRotRaw =
      p === owner.rootId
        ? 0
        : anglesOf(curAngles, ownerId, out)[p] - anglesOf(baseAngles, ownerId, base)[p];
    const dRot = Number.isFinite(dRotRaw) ? dRotRaw : 0;
    for (const b of Object.keys(child.nodes)) {
      const baseB = base[b];
      if (!baseB) continue;
      out[b] = rotateAround(add(baseB, trans), out[p], dRot);
    }
  }

  const rotations: Record<string, number> = {};
  for (const id of [posedChainId, ...descendants]) {
    const chain = chains[id];
    if (!chain) continue;
    const angles = boneAngles(chain, out);
    for (const [tid, a] of Object.entries(angles)) {
      // A chain's own root normally DOES rotate — to face its child — so a limb's
      // upper segment swings about its pinned joint (shoulder) as the tip is
      // posed. Skip it ONLY when the token is a SHARED PIVOT: a non-root segment
      // of some other chain (an anchor-built sub-chain rooted on its parent). The
      // parent chain owns that token's orientation, so honouring the child-root's
      // child-facing angle would fight it. `[posed, ...descendants]` is ordered
      // parent-first, so a parent already wrote the shared node's segment angle.
      if (tid === chain.rootId && isSharedPivot(chains, id, tid)) continue;
      rotations[tid] = a;
    }
  }
  return { positions: out, rotations };
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
