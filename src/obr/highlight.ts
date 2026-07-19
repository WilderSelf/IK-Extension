import OBR, { buildShape, type Item } from "@owlbear-rodeo/sdk";
import { HIGHLIGHT_META } from "./constants";
import { getPositions } from "./scene";

/**
 * On-canvas chain highlight: a coloured aura drawn on each of a chain's tokens
 * when the chain is picked in the popover. Shapes are LOCAL (per-client, never
 * synced or persisted), tagged with `HIGHLIGHT_META`, placed at each token's
 * scene position and `attachedTo` it — so the POSITION/SCALE attachment
 * behaviours carry the aura along (and size it) as the token is posed or moved.
 * Only one chain is highlighted at a time.
 */

const isHighlight = (i: Item): boolean => i.metadata[HIGHLIGHT_META] === true;

// Serialize every highlight op so a clear can never interleave with an add:
// rapid chain-name clicks would otherwise race (clear-clear-add-add) and leave
// two colour sets stranded on the canvas.
let queue: Promise<unknown> = Promise.resolve();
function serialize(op: () => Promise<void>): Promise<void> {
  const run = queue.then(op, op);
  queue = run.catch(() => {}); // keep the chain from staying rejected
  return run;
}

// Grid dpi is fixed for a session, so cache it — repeated clicks shouldn't each
// pay an IPC round-trip.
let dpi: number | undefined;
async function gridDpi(): Promise<number> {
  if (dpi === undefined) dpi = await OBR.scene.grid.getDpi();
  return dpi;
}

async function removeAll(): Promise<void> {
  const existing = await OBR.scene.local.getItems(isHighlight);
  if (existing.length) await OBR.scene.local.deleteItems(existing.map((i) => i.id));
}

/** Remove every highlight shape this client has drawn. */
export function clearHighlights(): Promise<void> {
  return serialize(removeAll);
}

/** Highlight `ids` in `color`, replacing any current highlight. */
export function highlightTokens(ids: string[], color: string): Promise<void> {
  return serialize(async () => {
    await removeAll();
    if (ids.length === 0) return;
    const [positions, d] = await Promise.all([getPositions(ids), gridDpi()]);
    const size = d * 1.3; // ~one grid cell; the SCALE behaviour grows it with the token
    const items = ids
      .filter((id) => positions[id]) // skip any token whose position we couldn't read
      .map((id) =>
        buildShape()
          .shapeType("CIRCLE")
          .width(size)
          .height(size)
          .position(positions[id]) // absolute scene coords; attach carries it from here
          .attachedTo(id)
          .fillColor(color)
          .fillOpacity(0.12)
          .strokeColor(color)
          .strokeWidth(Math.max(3, d * 0.04))
          .strokeOpacity(0.95)
          .layer("DRAWING")
          .locked(true)
          .disableHit(true)
          .metadata({ [HIGHLIGHT_META]: true })
          .build(),
      );
    if (items.length) await OBR.scene.local.addItems(items);
  });
}
