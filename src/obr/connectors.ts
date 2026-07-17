import OBR, { buildLine, buildShape, type Item, type Vector2 } from "@owlbear-rodeo/sdk";
import { type Vec2 } from "../types";
import { CONNECTOR_TAG } from "./constants";
import { getChains } from "./chainStore";

const HANDLE_COLOR = "#f2b134";
const JOINT_DIAMETER = 16;
const ROOT_DIAMETER = 26;

/** A circle centered on `at`, tagged so it's cleaned up with the rest of the overlay. */
function handle(at: Vector2, diameter: number, root: boolean) {
  return buildShape()
    .shapeType("CIRCLE")
    .width(diameter)
    .height(diameter)
    // OBR centers a CIRCLE on its position, so place it right on the joint point.
    .position(at)
    .fillColor(HANDLE_COLOR)
    .fillOpacity(root ? 0.15 : 0.85)
    .strokeColor(HANDLE_COLOR)
    .strokeWidth(root ? 4 : 0)
    .strokeOpacity(root ? 0.9 : 0)
    .layer("DRAWING")
    .locked(true)
    .disableHit(true)
    .metadata({ [CONNECTOR_TAG]: true })
    .build();
}

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

  // Fetch every chained token's position AND visibility in ONE scene scan.
  // Doing it per-chain meant N full getItems sweeps for N active chains.
  const allIds = new Set(active.flatMap((c) => Object.keys(c.nodes)));
  const scan = await OBR.scene.items.getItems((i: Item) => allIds.has(i.id));
  const positions: Record<string, Vec2> = {};
  const visible: Record<string, boolean> = {};
  for (const it of scan) {
    positions[it.id] = { x: it.position.x, y: it.position.y };
    visible[it.id] = it.visible;
  }
  // Overlay items live on the shared DRAWING layer and are seen by everyone, so
  // never draw a bone or handle onto a hidden token — that would betray the
  // position of something the GM deliberately hid from players.
  const shown = (id: string) => positions[id] && visible[id] !== false;

  const items: Item[] = [];
  for (const chain of active) {
    // Bones first, then handle dots on top, then a distinct ring on the root.
    for (const [id, node] of Object.entries(chain.nodes)) {
      if (!node.parentId) continue;
      if (!shown(id) || !shown(node.parentId)) continue;
      const a = positions[node.parentId];
      const b = positions[id];
      if (!a || !b) continue;
      items.push(
        buildLine()
          .startPosition(a)
          .endPosition(b)
          .strokeColor(HANDLE_COLOR)
          .strokeWidth(6)
          .strokeOpacity(0.7)
          .layer("DRAWING")
          .locked(true)
          .disableHit(true)
          .metadata({ [CONNECTOR_TAG]: true })
          .build(),
      );
    }
    for (const id of Object.keys(chain.nodes)) {
      if (!shown(id)) continue;
      const p = positions[id];
      const isRoot = id === chain.rootId;
      items.push(handle(p, isRoot ? ROOT_DIAMETER : JOINT_DIAMETER, isRoot));
    }
  }
  if (items.length) await OBR.scene.items.addItems(items);
}
