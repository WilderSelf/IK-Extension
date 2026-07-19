/**
 * Pure chain-model operations. No Owlbear SDK imports, so these are fully
 * unit-testable. `chainStore.ts` re-exports them alongside its OBR persistence.
 *
 * A chain is a single LINEAR strand: one pinned root, each subsequent node
 * parented to the one before it, no branching.
 */
import { type Chain, type ChainMap, type ChainNode, type Vec2, defaultSettings } from "../types";

const clone = (chains: ChainMap): ChainMap => JSON.parse(JSON.stringify(chains)) as ChainMap;

/** Find the chain that contains `tokenId`, if any. */
export function findChainForToken(chains: ChainMap, tokenId: string): Chain | undefined {
  return Object.values(chains).find((c) => tokenId in c.nodes);
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
    return next;
  }
  const order = orderedNodes(c);
  const idx = order.indexOf(tokenId);
  if (idx < 0) return chains;
  const nodes: Record<string, ChainNode> = {};
  for (let i = 0; i < idx; i++) nodes[order[i]] = c.nodes[order[i]];
  c.nodes = nodes;
  return next;
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
  return next;
}

/** Delete an entire chain. */
export function deleteChain(chains: ChainMap, chainId: string): ChainMap {
  const next = clone(chains);
  delete next[chainId];
  return next;
}

/** Merge partial settings into a chain (currently just `autoRotate`). */
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
