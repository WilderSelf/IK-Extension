import OBR, { buildLine, type Item } from "@owlbear-rodeo/sdk";
import { CONNECTOR_TAG } from "./constants";
import { getChains } from "./chainStore";
import { getPositions } from "./scene";

// Serialize refreshes: concurrent runs would both read the same "existing" set
// and both add a full set of lines, leaving duplicates. If a refresh is
// requested while one is running, coalesce it into a single follow-up pass.
let refreshing = false;
let refreshQueued = false;

/**
 * Rebuild the connector-line overlay from scratch: delete any existing IK
 * connector lines, then draw a line for every bone of every chain that has
 * `showConnectors` enabled. Lines are non-interactive and locked.
 *
 * Deliberately NOT wired to items.onChange (that would loop on our own adds);
 * callers invoke this on chain-metadata changes and after a pose completes.
 */
export async function refreshConnectors(): Promise<void> {
  if (refreshing) {
    refreshQueued = true;
    return;
  }
  refreshing = true;
  try {
    await rebuildConnectors();
  } finally {
    refreshing = false;
    if (refreshQueued) {
      refreshQueued = false;
      void refreshConnectors();
    }
  }
}

async function rebuildConnectors(): Promise<void> {
  // Connector lines are shared scene items. If every client rebuilt them, they
  // would each read an empty "existing" set and each add a full set (duplicates),
  // and non-GM players usually can't delete/add these items anyway. Let a single
  // client — the GM — own the overlay.
  if ((await OBR.player.getRole()) !== "GM") return;

  const chains = await getChains();

  const existing = await OBR.scene.items.getItems(
    (i: Item) => i.metadata[CONNECTOR_TAG] === true,
  );
  if (existing.length) {
    await OBR.scene.items.deleteItems(existing.map((i) => i.id));
  }

  const active = Object.values(chains).filter((c) => c.settings.showConnectors);
  if (active.length === 0) return;

  // Fetch every chained token's position in ONE scene scan. Doing it per-chain
  // meant N full getItems sweeps for N active chains (50 chains -> 50 scans).
  const allIds = [...new Set(active.flatMap((c) => Object.keys(c.nodes)))];
  const positions = await getPositions(allIds);

  const lines = [];
  for (const chain of active) {
    for (const [id, node] of Object.entries(chain.nodes)) {
      if (!node.parentId) continue;
      const a = positions[node.parentId];
      const b = positions[id];
      if (!a || !b) continue;
      lines.push(
        buildLine()
          .startPosition(a)
          .endPosition(b)
          .strokeColor("#f2b134")
          .strokeWidth(6)
          .strokeOpacity(0.7)
          .layer("DRAWING")
          .locked(true)
          .disableHit(true)
          .metadata({ [CONNECTOR_TAG]: true })
          .build(),
      );
    }
  }
  if (lines.length) await OBR.scene.items.addItems(lines);
}
