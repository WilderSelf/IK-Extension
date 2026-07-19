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
  defaultSettings,
} from "../types";

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
  const created = createChain(chains, root);
  let map = created[0];
  const id = created[1];
  let parent = root;
  for (const tokenId of rest) {
    const a = positions[parent];
    const b = positions[tokenId];
    const restLength = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
    let boneOffsetDeg: number | undefined;
    if (a && b && rotations[tokenId] !== undefined) {
      // Bone angle parent->node in degrees, matching ik/vec `angle` + boneAngles.
      const boneDeg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      boneOffsetDeg = rotations[tokenId] - boneDeg;
    }
    map = addNode(map, id, tokenId, parent, restLength, boneOffsetDeg);
    parent = tokenId;
  }
  return [map, id];
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
    return detachDangling(next);
  }
  const order = orderedNodes(c);
  const idx = order.indexOf(tokenId);
  if (idx < 0) return chains;
  const nodes: Record<string, ChainNode> = {};
  for (let i = 0; i < idx; i++) nodes[order[i]] = c.nodes[order[i]];
  c.nodes = nodes;
  return detachDangling(next);
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
  return detachDangling(next);
}

/** Delete an entire chain (orphaning any chains that followed one of its nodes). */
export function deleteChain(chains: ChainMap, chainId: string): ChainMap {
  const next = clone(chains);
  delete next[chainId];
  return detachDangling(next);
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
  if (!owner || owner.id === chainId) return chains; // must be another chain's node
  // Walk parent links up from the target chain; reaching chainId means a cycle.
  const seen = new Set<string>();
  let cur: string | undefined = owner.id;
  while (cur && !seen.has(cur)) {
    if (cur === chainId) return chains;
    seen.add(cur);
    const pid: string | undefined = chains[cur]?.parentNodeId;
    cur = pid ? findChainForToken(chains, pid)?.id : undefined;
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

/**
 * Clear any parent link whose target token is no longer a node of a different
 * existing chain (its parent chain or node was deleted / truncated / pruned).
 * Returns a new map; inputs are not mutated.
 */
function detachDangling(chains: ChainMap): ChainMap {
  const out: ChainMap = {};
  for (const [id, chain] of Object.entries(chains)) {
    if (chain.parentNodeId != null) {
      const owner = findChainForToken(chains, chain.parentNodeId);
      if (!owner || owner.id === id) {
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
  return chain.nodes[nodeId]?.stiffness ?? chain.settings.defaultStiffness ?? "normal";
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

/** True if any joint in the chain carries a captured bend limit. */
export function chainHasLimits(chain: Chain): boolean {
  return Object.values(chain.nodes).some((n) => n.limit != null);
}

/** The chain's current per-node bend limits, keyed by token id. */
export function chainLimits(chain: Chain): Record<string, BendLimit> {
  const out: Record<string, BendLimit> = {};
  for (const [id, n] of Object.entries(chain.nodes)) {
    if (n.limit) out[id] = { min: n.limit.min, max: n.limit.max };
  }
  return out;
}

/**
 * Replace a chain's bend limits wholesale: nodes named in `limits` get that
 * interval, every other node is freed. No-ops if the chain is missing.
 */
export function setChainLimits(
  chains: ChainMap,
  chainId: string,
  limits: Record<string, BendLimit>,
): ChainMap {
  const next = clone(chains);
  const chain = next[chainId];
  if (!chain) return chains;
  for (const [id, n] of Object.entries(chain.nodes)) {
    const l = limits[id];
    if (l) n.limit = { min: l.min, max: l.max };
    else delete n.limit;
  }
  return next;
}

/** Free every joint in the chain (remove all captured limits). */
export function clearLimits(chains: ChainMap, chainId: string): ChainMap {
  const next = clone(chains);
  const chain = next[chainId];
  if (!chain) return chains;
  for (const n of Object.values(chain.nodes)) delete n.limit;
  return next;
}

/**
 * Widen (or create) each joint's interval so it includes the given `bends`. Pure
 * range math on a plain limits map — the UI unions two captured poses through
 * this before persisting, so a single degenerate pose is never stored alone.
 */
export function expandLimits(
  existing: Record<string, BendLimit>,
  bends: Record<string, number>,
): Record<string, BendLimit> {
  const out: Record<string, BendLimit> = {};
  for (const [id, l] of Object.entries(existing)) out[id] = { min: l.min, max: l.max };
  for (const [id, v] of Object.entries(bends)) {
    const cur = out[id];
    out[id] = cur ? { min: Math.min(cur.min, v), max: Math.max(cur.max, v) } : { min: v, max: v };
  }
  return out;
}
