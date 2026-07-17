import OBR from "@owlbear-rodeo/sdk";
import { setupTool } from "./obr/tool";
import { setupContextMenu } from "./obr/contextMenu";
import { getChains, onChainsChange, pruneMissing, saveChains } from "./obr/chainStore";
import { refreshConnectors } from "./obr/connectors";

OBR.onReady(async () => {
  // Register the toolbar tool and context-menu entries (scene-independent).
  await Promise.all([setupTool(), setupContextMenu()]);

  // Prune chains that reference deleted tokens whenever items change.
  OBR.scene.items.onChange(async (items) => {
    try {
      const existing = new Set(items.map((i) => i.id));
      const chains = await getChains();
      const pruned = pruneMissing(chains, existing);
      // Only write when something actually changed, or we'd loop forever.
      if (JSON.stringify(pruned) !== JSON.stringify(chains)) {
        await saveChains(pruned);
      }
    } catch {
      // No active scene yet; ignore.
    }
  });

  // Keep the connector overlay in sync with chain edits.
  onChainsChange(() => {
    refreshConnectors().catch(() => {});
  });

  // Initial overlay pass once a scene is ready.
  try {
    if (await OBR.scene.isReady()) await refreshConnectors();
  } catch {
    /* ignore */
  }
  OBR.scene.onReadyChange((ready) => {
    if (ready) refreshConnectors().catch(() => {});
  });
});
