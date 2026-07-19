import OBR from "@owlbear-rodeo/sdk";
import { type ChainMap, METADATA_KEY } from "../types";

// Re-export the pure chain-model helpers so callers have one import surface.
export {
  findChainForToken,
  orderedNodes,
  createChain,
  addNode,
  buildChain,
  removeToken,
  pruneMissing,
  deleteChain,
  updateSettings,
} from "../model/chains";

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
