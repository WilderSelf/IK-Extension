/**
 * Pure chain-model operations. No Owlbear SDK imports, so these are fully
 * unit-testable. `chainStore.ts` re-exports them alongside its OBR persistence.
 *
 * A chain is a single LINEAR strand: one pinned root, each subsequent node
 * parented to the one before it, no branching.
 */
import {
  type BendLimit,
  type Chain,
  type ChainMap,
  type ChainNode,
  type Stiffness,
  type Vec2,
  CHAIN_PALETTE,
  STIFFNESS_ORDER,
  defaultSettings,
} from "../types";
import { type SegData, captureSegData, deriveMidpointJoints, reconstructJoints } from "../ik/segment";

const clone = (chains: ChainMap): ChainMap => JSON.parse(JSON.stringify(chains)) as ChainMap;

/**
 * Find the chain that contains `tokenId`, if any. A token can be a segment of
 * one chain AND the shared root/pivot of a sub-chain attached there — prefer the
 * chain where it's a real (non-root) segment, since that's the chain it "belongs"
 * to for posing and editing.
 */
export function findChainForToken(chains: ChainMap, tokenId: string): Chain | undefined {
  let rootMatch: Chain | undefined;
  for (const c of Object.values(chains)) {
    if (tokenId in c.nodes) {
      if (c.rootId !== tokenId) return c;
      rootMatch ??= c;
    }
  }
  return rootMatch;
}

/**
 * Node ids from the root outward, in strand order. Follows the single
 * parent->child link at each step; guarded against cycles so malformed metadata
 * can't hang a traversal.
 */
export function orderedNodes(chain: Chain): string[] {
  const childOf: Record<string, string> = {};
  for (const [id, node] of Object.entries(chain.nodes)) {
    if (node.parentId != null) childOf[node.parentId] = id;
  }
  const order: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = chain.rootId;
  while (cur && cur in chain.nodes && !seen.has(cur)) {
    seen.add(cur);
    order.push(cur);
    cur = childOf[cur];
  }
  return order;
}

/** Create a new chain rooted at `tokenId`. Returns [map, chainId]. */
export function createChain(chains: ChainMap, tokenId: string): [ChainMap, string] {
  const next = clone(chains);
  // Derive a readable id, but keep bumping the suffix until it is actually free.
  // A plain `count + 1` reuses suffixes after a chain is deleted, so a token
  // whose id shares the same 6-char prefix could silently overwrite a live chain.
  const prefix = `chain_${tokenId.slice(0, 6)}`;
  let n = Object.keys(chains).length + 1;
  let id = `${prefix}_${n}`;
  while (id in next) id = `${prefix}_${++n}`;
  next[id] = {
    id,
    rootId: tokenId,
    nodes: { [tokenId]: { parentId: null, restLength: 0 } },
    settings: defaultSettings(),
  };
  return [next, id];
}

/**
 * Append `tokenId` under `parentId` in `chainId`, capturing `restLength` and,
 * when provided, the token's authored `boneOffsetDeg`.
 */
export function addNode(
  chains: ChainMap,
  chainId: string,
  tokenId: string,
  parentId: string,
  restLength: number,
  boneOffsetDeg?: number,
): ChainMap {
  const next = clone(chains);
  const chain = next[chainId];
  if (!chain) return chains;
  chain.nodes[tokenId] = { parentId, restLength };
  if (boneOffsetDeg !== undefined) chain.nodes[tokenId].boneOffsetDeg = boneOffsetDeg;
  return next;
}

/**
 * Build a whole linear chain from an ordered list of token ids (root first,
 * then outward). Rest lengths come from `positions`; each non-root node's
 * `boneOffsetDeg` from its `rotations` relative to the measured bone. Returns
 * [map, chainId], or null if there are fewer than 2 ids or the list has
 * duplicates.
 */
export function buildChain(
  chains: ChainMap,
  orderedIds: string[],
  positions: Record<string, Vec2>,
  rotations: Record<string, number>,
): [ChainMap, string] | null {
  if (orderedIds.length < 2) return null;
  if (new Set(orderedIds).size !== orderedIds.length) return null;
  const [root, ...rest] = orderedIds;
  // Clone ONCE (createChain) and append nodes into the new chain in place. Routing
  // each node through `addNode` would deep-clone the whole growing map per token
  // (O(N²)); building into the single fresh chain is O(N) and byte-identical.
  const [map, id] = createChain(chains, root);
  const chain = map[id];
  let parent = root;
  for (const tokenId of rest) {
    const a = positions[parent];
    const b = positions[tokenId];
    const restLength = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
    const node: ChainNode = { parentId: parent, restLength };
    if (a && b && rotations[tokenId] !== undefined) {
      // Bone angle parent->node in degrees, matching ik/vec `angle` + boneAngles.
      const boneDeg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      node.boneOffsetDeg = rotations[tokenId] - boneDeg;
    }
    chain.nodes[tokenId] = node;
    parent = tokenId;
  }
  // Capture the ROOT's rotation offset too — against its OUTGOING bone
  // (root -> first child), the convention `boneAngles` uses for a root. A root
  // that's a visible limb segment (e.g. an upper arm) rotates about its pinned
  // joint when posed; without a captured offset it would fall back to the
  // default and snap to a wrong orientation the moment it turns.
  const firstChild = rest[0];
  const ra = positions[root];
  const rb = positions[firstChild];
  if (ra && rb && rotations[root] !== undefined) {
    const rootBoneDeg = (Math.atan2(rb.y - ra.y, rb.x - ra.x) * 180) / Math.PI;
    chain.nodes[root].boneOffsetDeg = rotations[root] - rootBoneDeg;
  }
  chain.color = pickChainColor(chains); // distinct highlight colour per chain
  return [map, id];
}

/**
 * A highlight colour for a new chain: the first palette entry not already used
 * by an existing chain, else cycling by chain count so distinct chains stay
 * visually distinct.
 */
export function pickChainColor(chains: ChainMap): string {
  const used = new Set(Object.values(chains).map((c) => c.color));
  return (
    CHAIN_PALETTE.find((c) => !used.has(c)) ??
    CHAIN_PALETTE[Object.keys(chains).length % CHAIN_PALETTE.length]
  );
}

/**
 * Remove `tokenId` from whichever chain contains it. Removing the root deletes
 * the whole chain; removing an interior node cuts the linear strand there,
 * dropping that node and everything past it.
 */
export function removeToken(chains: ChainMap, tokenId: string): ChainMap {
  const chain = findChainForToken(chains, tokenId);
  if (!chain) return chains;
  const next = clone(chains);
  const c = next[chain.id];
  if (c.rootId === tokenId) {
    delete next[chain.id];
    return detachDangling(next, chains);
  }
  const order = orderedNodes(c);
  const idx = order.indexOf(tokenId);
  if (idx < 0) return chains;
  const nodes: Record<string, ChainNode> = {};
  for (let i = 0; i < idx; i++) nodes[order[i]] = c.nodes[order[i]];
  c.nodes = nodes;
  return detachDangling(next, chains);
}

/**
 * Drop the trailing part of any strand whose token no longer exists in the
 * scene, and delete a chain whose root token is gone. A linear strand can't skip
 * a hole, so everything past the first missing token is dropped; a lone
 * surviving root is a valid in-progress chain and is kept.
 */
export function pruneMissing(chains: ChainMap, existingIds: Set<string>): ChainMap {
  const next: ChainMap = {};
  for (const [chainId, chain] of Object.entries(chains)) {
    const order = orderedNodes(chain);
    const keep: string[] = [];
    for (const id of order) {
      if (!existingIds.has(id)) break;
      keep.push(id);
    }
    if (keep.length === 0) continue; // root gone -> drop the chain entirely
    const nodes: Record<string, ChainNode> = {};
    for (const id of keep) nodes[id] = chain.nodes[id];
    next[chainId] = { ...chain, nodes };
  }
  // Scene-aware: `existingIds` lets a bare parent that was DELETED from the scene
  // be detached too, while a bare parent that still exists is preserved.
  return detachDangling(next, chains, existingIds);
}

/** Delete an entire chain (orphaning any chains that followed one of its nodes). */
export function deleteChain(chains: ChainMap, chainId: string): ChainMap {
  const next = clone(chains);
  delete next[chainId];
  return detachDangling(next, chains);
}

// ---- Attachment (a chain that follows a node of another chain) -------------

/**
 * Set or clear this chain's parent link — the token id (a node of a DIFFERENT
 * chain) it should ride with. Passing `null` detaches. Rejects (returns the map
 * unchanged) if the target isn't a node of another existing chain, or if the
 * link would create a cycle.
 */
export function setParentNode(
  chains: ChainMap,
  chainId: string,
  parentTokenId: string | null,
): ChainMap {
  if (!chains[chainId]) return chains;
  const next = clone(chains);
  if (parentTokenId === null) {
    delete next[chainId].parentNodeId;
    return next;
  }
  const owner = findChainForToken(chains, parentTokenId);
  // The parent may be a node of ANOTHER chain (carried by poseRig when that chain
  // is posed) OR a BARE token — a body sprite that isn't a chain — carried
  // reactively when it moves (see ik/follow.ts). Only the former can form a cycle.
  // `findChainForToken` prefers the chain where the token is a non-root SEGMENT, so
  // a shared anchor (this chain's root but another chain's segment) resolves to the
  // other chain and is allowed — only a token this chain truly owns is rejected.
  if (owner) {
    if (owner.id === chainId) return chains; // a segment of this same chain
    // Walk parent links up from the owner chain; reaching chainId means a cycle.
    const seen = new Set<string>();
    let cur: string | undefined = owner.id;
    while (cur && !seen.has(cur)) {
      if (cur === chainId) return chains;
      seen.add(cur);
      const pid: string | undefined = chains[cur]?.parentNodeId;
      cur = pid ? findChainForToken(chains, pid)?.id : undefined;
    }
  }
  next[chainId].parentNodeId = parentTokenId;
  return next;
}

/** The id of the chain that owns `chain`'s parent node, or undefined if top-level. */
export function parentChainId(chains: ChainMap, chainId: string): string | undefined {
  const pid = chains[chainId]?.parentNodeId;
  return pid ? findChainForToken(chains, pid)?.id : undefined;
}

/**
 * Ids of every chain that (transitively) follows a node of `chainId`, nearest
 * first. BFS over the attachment forest, cycle-guarded.
 */
export function descendantChainIds(chains: ChainMap, chainId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([chainId]);
  const queue = [chainId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const id of Object.keys(chains)) {
      if (seen.has(id)) continue;
      if (parentChainId(chains, id) === cur) {
        seen.add(id);
        out.push(id);
        queue.push(id);
      }
    }
  }
  return out;
}

/** Every token id that is a node of some chain in `m`. */
function chainTokenSet(m: ChainMap): Set<string> {
  const s = new Set<string>();
  for (const c of Object.values(m)) for (const t of Object.keys(c.nodes)) s.add(t);
  return s;
}

/**
 * Clear a chain's parent link ONLY when it has genuinely gone stale — while
 * preserving a valid link to a BARE parent token (a body sprite that isn't a
 * chain node, the whole point of the reactive-follow feature). A link is severed
 * when:
 *  - it resolves back to this same chain (a shared-pivot anchor whose parent
 *    chain was deleted, leaving the token as only this chain's own root); or
 *  - the parent token WAS a chain node (present in `prev`) and is now gone from
 *    every chain — a deleted / truncated / pruned node. A bare token was never a
 *    chain node, so it is not caught here; or
 *  - `existing` (a scene-id set) is supplied and the parent is a bare token that
 *    no longer exists in the scene (its body was deleted).
 *
 * `prev` is the pre-operation map. Earlier this used "not a node of any chain" as
 * the staleness test, which wrongly matched every bare parent — so any prune /
 * remove / delete silently detached arms-on-bodies. Returns a new map; inputs are
 * not mutated.
 */
function detachDangling(next: ChainMap, prev?: ChainMap, existing?: Set<string>): ChainMap {
  const nextTokens = chainTokenSet(next);
  const prevTokens = prev ? chainTokenSet(prev) : nextTokens;
  const out: ChainMap = {};
  for (const [id, chain] of Object.entries(next)) {
    const p = chain.parentNodeId;
    if (p != null) {
      const owner = findChainForToken(next, p);
      const resolvesToSelf = !!owner && owner.id === id;
      const wasChainNodeNowGone = prevTokens.has(p) && !nextTokens.has(p);
      const bareAndSceneGone = !owner && !prevTokens.has(p) && existing != null && !existing.has(p);
      if (resolvesToSelf || wasChainNodeNowGone || bareAndSceneGone) {
        const copy: Chain = { ...chain };
        delete copy.parentNodeId;
        out[id] = copy;
        continue;
      }
    }
    out[id] = chain;
  }
  return out;
}

/** Merge partial settings into a chain (`autoRotate`, `defaultStiffness`). */
export function updateSettings(
  chains: ChainMap,
  chainId: string,
  patch: Partial<Chain["settings"]>,
): ChainMap {
  const next = clone(chains);
  if (!next[chainId]) return chains;
  next[chainId].settings = { ...next[chainId].settings, ...patch };
  return next;
}

/**
 * Set or clear a single node's bend-resistance override. Passing `null` clears
 * the override so the node falls back to its chain's `defaultStiffness`. No-ops
 * (returns the map unchanged) if the token isn't in any chain or is its chain's
 * root — the root has no incoming bone to stiffen.
 */
export function setNodeStiffness(
  chains: ChainMap,
  tokenId: string,
  stiffness: Stiffness | null,
): ChainMap {
  const chain = findChainForToken(chains, tokenId);
  if (!chain || chain.rootId === tokenId) return chains;
  const next = clone(chains);
  const node = next[chain.id].nodes[tokenId];
  if (stiffness === null) delete node.stiffness;
  else node.stiffness = stiffness;
  return next;
}

/**
 * The bend-resistance actually in force for a node: its own override if set,
 * otherwise the chain default, falling back to `normal` (plain FABRIK) for
 * chains persisted before the setting existed.
 */
export function effectiveStiffness(chain: Chain, nodeId: string): Stiffness {
  const own = chain.nodes[nodeId]?.stiffness;
  if (own !== undefined) return own; // an explicit override always wins
  if (chain.settings.ease) return easedStiffness(chain, nodeId);
  return chain.settings.defaultStiffness ?? "normal";
}

/**
 * The eased stiffness for a node when the chain's `ease` ramp is on: stiffest at
 * the base, stepping down to loosest at the tip, spread evenly across the movable
 * joints. The root (no incoming bone) is irrelevant; a lone movable joint is left
 * stiff.
 */
function easedStiffness(chain: Chain, nodeId: string): Stiffness {
  const order = orderedNodes(chain);
  const idx = order.indexOf(nodeId);
  if (idx <= 0) return "normal"; // root or not found
  const movable = order.length - 1;
  const k = idx - 1; // 0 at the first movable joint … movable-1 at the tip
  if (movable <= 1) return "stiff";
  const top = STIFFNESS_ORDER.length - 1;
  const level = Math.round(top * (1 - k / (movable - 1)));
  return STIFFNESS_ORDER[level];
}

/** Set a chain's highlight colour (hex). No-op if the chain is gone. */
export function setChainColor(chains: ChainMap, chainId: string, color: string): ChainMap {
  if (!chains[chainId]) return chains;
  const next = clone(chains);
  next[chainId].color = color;
  return next;
}

// ---- Segment rig (limb mode) ------------------------------------------------

/**
 * Turn limb mode ON for a chain, capturing each node's rigid-segment data from
 * the CURRENT pose (`positions` centres + `rotations` in degrees): the segment
 * length, where the token's centre sits along it, and its rotation relative to
 * the segment direction. Needs ≥ 2 nodes with known positions; a no-op otherwise
 * (returns the same map). Turning it on treats the current pose as the rest pose.
 */
export function enableSegmentRig(
  chains: ChainMap,
  chainId: string,
  positions: Record<string, Vec2>,
  rotations: Record<string, number>,
): ChainMap {
  const chain = chains[chainId];
  if (!chain) return chains;
  const order = orderedNodes(chain);
  const centres = order.map((id) => positions[id]);
  if (order.length < 2 || centres.some((c) => !c)) return chains;
  const next = clone(chains);
  // Fresh capture treats the current pose as rest and freezes the auto (midpoint)
  // joints into rigid seg data — the user then drags individual joints off that.
  const joints = deriveMidpointJoints(centres as Vec2[]);
  writeSegData(next[chainId], order, captureSegData(centres as Vec2[], order.map((id) => rotations[id] ?? 0), joints));
  next[chainId].settings.segmentRig = true;
  return next;
}

/** Assign captured SegData to each node in order. Mutates the (cloned) chain. */
function writeSegData(chain: Chain, order: string[], seg: SegData[]): void {
  order.forEach((id, i) => {
    chain.nodes[id].seg = seg[i];
  });
}

/**
 * Move segment-rig joint `jointIndex` to world position `world` (from a canvas
 * drag), then recapture the rest data so the new pivot sticks. Reconstructs the
 * current joints rigidly (from centres + rotations + seg), replaces the dragged
 * one, and re-freezes — so the joint stays rigidly attached and won't wander when
 * posed. Needs a segment rig with ≥ 2 positioned nodes; a no-op otherwise.
 */
export function setJointPivot(
  chains: ChainMap,
  chainId: string,
  jointIndex: number,
  world: Vec2,
  positions: Record<string, Vec2>,
  rotations: Record<string, number>,
): ChainMap {
  const chain = chains[chainId];
  if (!chain?.settings.segmentRig || !isSegmentRig(chain)) return chains;
  const order = orderedNodes(chain);
  const centres = order.map((id) => positions[id]);
  if (order.length < 2 || centres.some((c) => !c)) return chains;
  if (jointIndex < 0 || jointIndex > order.length) return chains;
  const rot = order.map((id) => rotations[id] ?? 0);
  const seg = order.map((id) => chain.nodes[id].seg!);
  const joints = reconstructJoints(centres as Vec2[], rot, seg);
  joints[jointIndex] = world;
  const next = clone(chains);
  writeSegData(next[chainId], order, captureSegData(centres as Vec2[], rot, joints));
  return next;
}

/** Reset a segment rig's joints back to the auto midpoints, recapturing rest data. */
export function resetJointPivots(
  chains: ChainMap,
  chainId: string,
  positions: Record<string, Vec2>,
  rotations: Record<string, number>,
): ChainMap {
  const chain = chains[chainId];
  if (!chain?.settings.segmentRig) return chains;
  const order = orderedNodes(chain);
  const centres = order.map((id) => positions[id]);
  if (order.length < 2 || centres.some((c) => !c)) return chains;
  const next = clone(chains);
  const joints = deriveMidpointJoints(centres as Vec2[]);
  writeSegData(next[chainId], order, captureSegData(centres as Vec2[], order.map((id) => rotations[id] ?? 0), joints));
  return next;
}

/**
 * Turn limb mode OFF. The captured `seg` data is left in place (harmless when the
 * flag is off) so re-enabling reuses it; the centre-based `boneOffsetDeg` was
 * never touched, so the default rig resumes exactly.
 */
export function disableSegmentRig(chains: ChainMap, chainId: string): ChainMap {
  if (!chains[chainId]) return chains;
  const next = clone(chains);
  delete next[chainId].settings.segmentRig;
  return next;
}

/** Whether a chain is a segment rig with capture data ready for every node. */
export function isSegmentRig(chain: Chain): boolean {
  return !!chain.settings.segmentRig && orderedNodes(chain).every((id) => chain.nodes[id].seg);
}

// ---- Display names (cosmetic; never touch the Owlbear item) -----------------

/**
 * Set or clear a chain's popover display name. An empty/whitespace name clears
 * it, so the label falls back to the root token's scene name. No-op if the chain
 * is gone. Does not rename the Owlbear item.
 */
export function renameChain(chains: ChainMap, chainId: string, name: string): ChainMap {
  if (!chains[chainId]) return chains;
  const next = clone(chains);
  const trimmed = name.trim();
  if (trimmed) next[chainId].name = trimmed;
  else delete next[chainId].name;
  return next;
}

/**
 * Set or clear a node's popover display name. Empty/whitespace clears it (falls
 * back to the token's scene name). Works for any node including the root; no-op
 * if the token isn't in any chain. Does not rename the Owlbear item.
 */
export function renameNode(chains: ChainMap, tokenId: string, name: string): ChainMap {
  const chain = findChainForToken(chains, tokenId);
  if (!chain) return chains;
  const next = clone(chains);
  const trimmed = name.trim();
  const node = next[chain.id].nodes[tokenId];
  if (trimmed) node.name = trimmed;
  else delete node.name;
  return next;
}

// ---- Bend limits (captured by posing) --------------------------------------
//
// Two tiers, mirroring stiffness: a chain-wide `settings.defaultLimit` (one
// interval applied to every limitable joint) and a per-node `node.limit`
// override that wins where set. Both are captured by posing — never typed.

/**
 * Is `id` a *limitable* joint of `chain` — one with a reference bone above it to
 * measure a bend against? The default (centre) rig needs two bones, so the root
 * and the first movable node are free (the 3rd token onward can be limited). A
 * segment rig measures the turn between adjacent SEGMENTS, so every non-root
 * segment articulates against the one before it and can be limited.
 */
export function isLimitable(chain: Chain, id: string): boolean {
  const i = orderedNodes(chain).indexOf(id);
  if (i < 0) return false;
  return isSegmentRig(chain) ? i >= 1 : i >= 2;
}

/** The limitable joints of a chain, in root→tip order. */
export function limitableTokens(chain: Chain): string[] {
  return orderedNodes(chain).filter((id) => isLimitable(chain, id));
}

/** True if the chain has any limitable joint at all (so limit UI is meaningful). */
export function chainCanLimit(chain: Chain): boolean {
  return limitableTokens(chain).length > 0;
}

/** True if a chain-wide default bend limit is set. */
export function hasDefaultLimit(chain: Chain): boolean {
  return chain.settings.defaultLimit != null;
}

/**
 * True if this chain is attached to a token OTHER than its own root — a body or
 * another chain's node. Only then is the ANCHOR limit meaningful (the parent
 * supplies the reference the root swings against); a shared-pivot anchor-build
 * (`parentNodeId === rootId`) limits that joint via the normal per-joint limits.
 */
export function isExternallyAnchored(chain: Chain): boolean {
  return chain.parentNodeId != null && chain.parentNodeId !== chain.rootId;
}

/** True if this chain has a captured anchor limit AND it's externally anchored. */
export function hasAnchorLimit(chain: Chain): boolean {
  return chain.anchorLimit != null && isExternallyAnchored(chain);
}

/** True if any limit — chain default, a per-node override, or the anchor — is set. */
export function chainHasLimits(chain: Chain): boolean {
  return hasDefaultLimit(chain) || chain.anchorLimit != null || Object.values(chain.nodes).some((n) => n.limit != null);
}

/**
 * The effective bend limit for one joint: its own `limit` override if set, else
 * the chain default, else `null` (free). Callers still gate on joint index (the
 * solver only clamps limitable positions), so this may return the default for a
 * non-limitable node — harmless, as that node's limit is never consulted.
 */
export function effectiveLimit(chain: Chain, id: string): BendLimit | null {
  return chain.nodes[id]?.limit ?? chain.settings.defaultLimit ?? null;
}

/** Union two relative-bend intervals (or seed from one) into the widest range. */
export function unionRange(a: BendLimit | null | undefined, b: BendLimit): BendLimit {
  return a ? { min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) } : { min: b.min, max: b.max };
}

/** Set (or, with `null`, clear) the chain-wide default bend limit. */
export function setDefaultLimit(chains: ChainMap, chainId: string, limit: BendLimit | null): ChainMap {
  const next = clone(chains);
  const chain = next[chainId];
  if (!chain) return chains;
  if (limit) chain.settings.defaultLimit = { min: limit.min, max: limit.max };
  else delete chain.settings.defaultLimit;
  return next;
}

/** Set (or, with `null`, clear) one node's bend-limit override. */
export function setNodeLimit(chains: ChainMap, chainId: string, nodeId: string, limit: BendLimit | null): ChainMap {
  const next = clone(chains);
  const node = next[chainId]?.nodes[nodeId];
  if (!node) return chains;
  if (limit) node.limit = { min: limit.min, max: limit.max };
  else delete node.limit;
  return next;
}

/** Set (or, with `null`, clear) the chain's anchor limit (root ↔ parent token). */
export function setAnchorLimit(chains: ChainMap, chainId: string, limit: BendLimit | null): ChainMap {
  const next = clone(chains);
  const chain = next[chainId];
  if (!chain) return chains;
  if (limit) chain.anchorLimit = { min: limit.min, max: limit.max };
  else delete chain.anchorLimit;
  return next;
}

/** Free every joint in the chain: drop the default, the anchor, AND every override. */
export function clearLimits(chains: ChainMap, chainId: string): ChainMap {
  const next = clone(chains);
  const chain = next[chainId];
  if (!chain) return chains;
  delete chain.settings.defaultLimit;
  delete chain.anchorLimit;
  for (const n of Object.values(chain.nodes)) delete n.limit;
  return next;
}
