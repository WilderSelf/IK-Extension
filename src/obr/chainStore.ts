import OBR from "@owlbear-rodeo/sdk";
import { type ChainMap, METADATA_KEY, TEMPLATES_KEY } from "../types";
import type { TemplateMap } from "../model/templates";

// Re-export the pure chain-model helpers so existing imports keep working.
export {
  findChainForToken,
  createChain,
  addNode,
  removeToken,
  pruneMissing,
  deleteChain,
  recalibrate,
  updateSettings,
  setNodeOverride,
  setNodeConstraint,
} from "../model/chains";

export {
  toTemplate,
  instantiateTemplate,
  saveTemplate,
  deleteTemplate,
} from "../model/templates";

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

// ---- Template / preset persistence ----------------------------------------

export async function getTemplates(): Promise<TemplateMap> {
  const md = await OBR.scene.getMetadata();
  return ((md[TEMPLATES_KEY] as TemplateMap | undefined) ?? {}) as TemplateMap;
}

export async function saveTemplates(templates: TemplateMap): Promise<void> {
  await OBR.scene.setMetadata({ [TEMPLATES_KEY]: templates });
}

export function onTemplatesChange(cb: (templates: TemplateMap) => void): () => void {
  return OBR.scene.onMetadataChange((md) => {
    cb(((md[TEMPLATES_KEY] as TemplateMap | undefined) ?? {}) as TemplateMap);
  });
}
