/**
 * Pure chain-model operations. No Owlbear SDK imports, so these are fully
 * unit-testable. `chainStore.ts` re-exports them alongside its OBR persistence.
 */
import {
  type Chain,
  type ChainMap,
  type JointConstraint,
  type NodeOverride,
  defaultSettings,
} from "../types";

const clone = (chains: ChainMap): ChainMap =>
  JSON.parse(JSON.stringify(chains)) as ChainMap;

/** Find the chain that contains `tokenId`, if any. */
export function findChainForToken(
  chains: ChainMap,
  tokenId: string,
): Chain | undefined {
  return Object.values(chains).find((c) => tokenId in c.nodes);
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
 * Link `tokenId` under `parentId` in `chainId`, capturing `restLength` and,
 * when provided, the token's authored `boneOffsetDeg` (rotation relative to its
 * incoming bone) so auto-rotate preserves its orientation while posing.
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
 * Remove a token from whichever chain contains it. Removing the root deletes
 * the whole chain; removing an interior node re-parents its children to that
 * node's parent (keeping the branch connected).
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
  const removed = c.nodes[tokenId];
  for (const node of Object.values(c.nodes)) {
    if (node.parentId === tokenId) node.parentId = removed.parentId;
  }
  delete c.nodes[tokenId];
  return next;
}

/**
 * Drop nodes whose token no longer exists in the scene, and delete any chain
 * whose root token is gone (an empty chain has no root either). A chain that
 * still has only its root is a valid in-progress chain and is kept.
 */
export function pruneMissing(chains: ChainMap, existingIds: Set<string>): ChainMap {
  const next = clone(chains);
  for (const [chainId, chain] of Object.entries(next)) {
    // Fold removals cumulatively: each call must build on the previous result,
    // not re-derive from the original `chain`, or only the LAST missing token in
    // a chain gets pruned and the earlier ones linger as dangling references.
    let c = chain;
    for (const tokenId of Object.keys(chain.nodes)) {
      if (!existingIds.has(tokenId)) c = removeTokenFromChain(c, tokenId);
    }
    // Delete only when the root itself is gone (covers the empty case too). A
    // lone root with no children yet is a valid in-progress chain and is kept.
    if (!c.nodes[c.rootId]) delete next[chainId];
    else next[chainId] = c;
  }
  return next;
}

function removeTokenFromChain(chain: Chain, tokenId: string): Chain {
  if (chain.rootId === tokenId) {
    return { ...chain, nodes: {} };
  }
  const removed = chain.nodes[tokenId];
  const nodes = { ...chain.nodes };
  for (const [id, node] of Object.entries(nodes)) {
    if (node.parentId === tokenId) nodes[id] = { ...node, parentId: removed?.parentId ?? null };
  }
  delete nodes[tokenId];
  return { ...chain, nodes };
}

/** Delete an entire chain. */
export function deleteChain(chains: ChainMap, chainId: string): ChainMap {
  const next = clone(chains);
  delete next[chainId];
  return next;
}

/**
 * Re-capture rest lengths from current token positions, and — when `rotations`
 * are supplied — each node's `boneOffsetDeg` from its current rotation relative
 * to its (freshly measured) incoming bone. This is how an existing chain adopts
 * orientation preservation: re-orient the tokens by hand, then Recalibrate.
 */
export function recalibrate(
  chains: ChainMap,
  chainId: string,
  positions: Record<string, { x: number; y: number }>,
  rotations?: Record<string, number>,
): ChainMap {
  const next = clone(chains);
  const chain = next[chainId];
  if (!chain) return chains;
  for (const [id, node] of Object.entries(chain.nodes)) {
    if (!node.parentId) continue;
    const a = positions[node.parentId];
    const b = positions[id];
    if (!a || !b) continue;
    node.restLength = Math.hypot(a.x - b.x, a.y - b.y);
    if (rotations && rotations[id] !== undefined) {
      // Bone angle parent->node in degrees, matching ik/vec `angle` + boneAngles.
      const boneDeg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      node.boneOffsetDeg = rotations[id] - boneDeg;
    }
  }
  return next;
}

/** Merge partial settings into a chain. */
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
 * Set or clear a node's bend limit. Passing `null` removes the constraint.
 * Constraints on the root are ignored by the solver (no reference bone), but we
 * store whatever is asked and let the UI gate where it is offered.
 */
export function setNodeConstraint(
  chains: ChainMap,
  chainId: string,
  tokenId: string,
  constraint: JointConstraint | null,
): ChainMap {
  const next = clone(chains);
  const chain = next[chainId];
  if (!chain || !(tokenId in chain.nodes)) return chains;
  if (constraint === null) delete chain.nodes[tokenId].constraint;
  else chain.nodes[tokenId].constraint = constraint;
  return next;
}

/** Merge a per-node override (e.g. player-movable / locked) for one token. */
export function setNodeOverride(
  chains: ChainMap,
  chainId: string,
  tokenId: string,
  patch: Partial<NodeOverride>,
): ChainMap {
  const next = clone(chains);
  const chain = next[chainId];
  if (!chain || !(tokenId in chain.nodes)) return chains;
  const overrides = { ...(chain.settings.nodeOverrides ?? {}) };
  const current = { ...(overrides[tokenId] ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (current as Record<string, unknown>)[k];
    else (current as Record<string, unknown>)[k] = v;
  }
  if (Object.keys(current).length === 0) delete overrides[tokenId];
  else overrides[tokenId] = current;
  chain.settings.nodeOverrides = overrides;
  return next;
}
