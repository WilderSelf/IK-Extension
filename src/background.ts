import OBR from "@owlbear-rodeo/sdk";
import type { ChainMap } from "./types";
import { setupTool } from "./obr/tool";
import { setupContextMenu } from "./obr/contextMenu";
import { getChains, onChainsChange, pruneMissing, saveChains } from "./obr/chainStore";
import { refreshConnectors } from "./obr/connectors";

// Cached copy of the chain map, kept current via onChainsChange, so the
// high-frequency items.onChange handler never has to fetch scene metadata.
let cachedChains: ChainMap = {};

/** True if any chain references a token id that is no longer in the scene. */
function hasMissingToken(chains: ChainMap, existing: Set<string>): boolean {
  return Object.values(chains).some((c) =>
    Object.keys(c.nodes).some((id) => !existing.has(id)),
  );
}

OBR.onReady(async () => {
  // Register the toolbar tool and context-menu entries (scene-independent).
  await Promise.all([setupTool(), setupContextMenu()]);

  // Seed and maintain the cached chain map.
  getChains().then((c) => (cachedChains = c)).catch(() => {});
  onChainsChange((chains) => {
    cachedChains = chains;
    refreshConnectors().catch(() => {});
  });

  // Prune chains that reference deleted tokens. Fast path: skip entirely unless
  // a referenced token actually went missing (avoids fetching + diffing the
  // whole chain map on every item mutation in the scene).
  OBR.scene.items.onChange((items) => {
    const chains = cachedChains;
    if (Object.keys(chains).length === 0) return;
    const existing = new Set(items.map((i) => i.id));
    if (!hasMissingToken(chains, existing)) return;
    const pruned = pruneMissing(chains, existing);
    cachedChains = pruned;
    saveChains(pruned).catch(() => {});
  });

  // Initial overlay pass once a scene is ready.
  try {
    if (await OBR.scene.isReady()) await refreshConnectors();
  } catch {
    /* no active scene yet */
  }
  OBR.scene.onReadyChange((ready) => {
    if (ready) {
      getChains().then((c) => (cachedChains = c)).catch(() => {});
      refreshConnectors().catch(() => {});
    }
  });
});
