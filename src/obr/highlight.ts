import OBR, { buildShape, type Item } from "@owlbear-rodeo/sdk";
import { HIGHLIGHT_META } from "./constants";

/**
 * On-canvas chain highlight: a coloured aura drawn behind each of a chain's
 * tokens when the chain is picked in the popover. Shapes are LOCAL (per-client,
 * never synced or persisted) and tagged with `HIGHLIGHT_META`, and each is
 * `attachedTo` its token so it rides along as the token is posed or moved. Only
 * one chain is highlighted at a time — `highlightTokens` clears the previous set
 * first.
 */

const isHighlight = (i: Item): boolean => i.metadata[HIGHLIGHT_META] === true;

/** Remove every highlight shape this client has drawn. */
export async function clearHighlights(): Promise<void> {
  const existing = await OBR.scene.local.getItems(isHighlight);
  if (existing.length) await OBR.scene.local.deleteItems(existing.map((i) => i.id));
}

/** Highlight `ids` in `color`, replacing any current highlight. */
export async function highlightTokens(ids: string[], color: string): Promise<void> {
  await clearHighlights();
  if (ids.length === 0) return;
  // Size the aura to the grid cell so it reads around a standard token; attach
  // at the token origin (a CIRCLE centres on its position) so it stays put.
  const dpi = await OBR.scene.grid.getDpi();
  const d = dpi * 1.3;
  const items = ids.map((id) =>
    buildShape()
      .shapeType("CIRCLE")
      .width(d)
      .height(d)
      .position({ x: 0, y: 0 })
      .attachedTo(id)
      .fillColor(color)
      .fillOpacity(0.12)
      .strokeColor(color)
      .strokeWidth(Math.max(3, dpi * 0.04))
      .strokeOpacity(0.95)
      .layer("DRAWING")
      .locked(true)
      .disableHit(true)
      .metadata({ [HIGHLIGHT_META]: true })
      .build(),
  );
  await OBR.scene.local.addItems(items);
}
