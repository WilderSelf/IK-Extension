import OBR from "@owlbear-rodeo/sdk";
import {
  type Chain,
  type ChainMap,
  METADATA_KEY,
  defaultSettings,
} from "../types";

// ---- Persistence (scene metadata) -----------------------------------------

export async function getChains(): Promise<ChainMap> {
  const md = await OBR.scene.getMetadata();
  return ((md[METADATA_KEY] as ChainMap | undefined) ?? {}) as ChainMap;
}

export async function saveChains(chains: ChainMap): Promise<void> {
  await OBR.scene.setMetadata({ [METADATA_KEY]: chains });
}

export function onChainsChange(cb: (chains: ChainMap) => void): () => void {
  return OBR.scene.onMetadataChange((md) => {
    cb(((md[METADATA_KEY] as ChainMap | undefined) ?? {}) as ChainMap);
  });
}

// ---- Pure helpers (operate on a ChainMap, return a new one) ----------------

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
  const id = `chain_${tokenId.slice(0, 6)}_${Object.keys(chains).length + 1}`;
  next[id] = {
    id,
    rootId: tokenId,
    nodes: { [tokenId]: { parentId: null, restLength: 0 } },
    settings: defaultSettings(),
  };
  return [next, id];
}

/** Link `tokenId` under `parentId` in `chainId`, capturing `restLength`. */
export function addNode(
  chains: ChainMap,
  chainId: string,
  tokenId: string,
  parentId: string,
  restLength: number,
): ChainMap {
  const next = clone(chains);
  const chain = next[chainId];
  if (!chain) return chains;
  chain.nodes[tokenId] = { parentId, restLength };
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
 * left with fewer than two nodes or a missing root.
 */
export function pruneMissing(chains: ChainMap, existingIds: Set<string>): ChainMap {
  const next = clone(chains);
  for (const [chainId, chain] of Object.entries(next)) {
    for (const tokenId of Object.keys(chain.nodes)) {
      if (!existingIds.has(tokenId)) {
        next[chainId] = removeTokenFromChain(chain, tokenId);
      }
    }
    const c = next[chainId];
    if (!c || !c.nodes[c.rootId] || Object.keys(c.nodes).length < 2) {
      delete next[chainId];
    }
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

/** Re-capture rest lengths from current token positions. */
export function recalibrate(
  chains: ChainMap,
  chainId: string,
  positions: Record<string, { x: number; y: number }>,
): ChainMap {
  const next = clone(chains);
  const chain = next[chainId];
  if (!chain) return chains;
  for (const [id, node] of Object.entries(chain.nodes)) {
    if (!node.parentId) continue;
    const a = positions[node.parentId];
    const b = positions[id];
    if (a && b) node.restLength = Math.hypot(a.x - b.x, a.y - b.y);
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
