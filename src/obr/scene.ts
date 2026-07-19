import OBR, { type Item } from "@owlbear-rodeo/sdk";
import { type Vec2, DEFAULT_ROTATION_OFFSET_DEG } from "../types";
import { TOKEN_LAYERS } from "./constants";

/** Convert a bone math-angle (radians) to an OBR item rotation in degrees. */
export function radToObrDeg(
  rad: number,
  offsetDeg: number = DEFAULT_ROTATION_OFFSET_DEG,
): number {
  // Guard against a non-finite bone angle (degenerate geometry); writing NaN to
  // an item's rotation would corrupt the token's transform.
  const safeRad = Number.isFinite(rad) ? rad : 0;
  const deg = (safeRad * 180) / Math.PI + offsetDeg;
  return ((deg % 360) + 360) % 360;
}

/** Only CHARACTER/MOUNT/PROP/ATTACHMENT layers are riggable (fog/drawings out). */
export function isToken(item: Item): boolean {
  return TOKEN_LAYERS.has(item.layer);
}

/** Current raw selection as an ordered list of item ids (selection order kept). */
export async function getSelection(): Promise<string[]> {
  return (await OBR.player.getSelection()) ?? [];
}

/**
 * Selected *token* ids in selection order, with non-token layers (fog,
 * drawings, …) filtered out — the ordered basis for building a chain
 * (root first, then outward).
 */
export async function getSelectedTokenIds(): Promise<string[]> {
  const ids = (await OBR.player.getSelection()) ?? [];
  if (ids.length === 0) return [];
  const idSet = new Set(ids);
  const items = await OBR.scene.items.getItems((i) => idSet.has(i.id));
  const tokenIds = new Set(items.filter(isToken).map((i) => i.id));
  return ids.filter((id) => tokenIds.has(id));
}

/** Fetch display names for the given item ids. */
export async function getItemNames(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const idSet = new Set(ids);
  const items = await OBR.scene.items.getItems((i) => idSet.has(i.id));
  const out: Record<string, string> = {};
  for (const item of items) out[item.id] = item.name || item.id.slice(0, 8);
  return out;
}

/** Fetch current positions for the given item ids. */
export async function getPositions(ids: string[]): Promise<Record<string, Vec2>> {
  if (ids.length === 0) return {};
  const idSet = new Set(ids);
  const items = await OBR.scene.items.getItems((i) => idSet.has(i.id));
  const out: Record<string, Vec2> = {};
  for (const item of items) out[item.id] = { x: item.position.x, y: item.position.y };
  return out;
}

/** Fetch current rotations (degrees) for the given item ids. */
export async function getRotations(ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const idSet = new Set(ids);
  const items = await OBR.scene.items.getItems((i) => idSet.has(i.id));
  const out: Record<string, number> = {};
  for (const item of items) out[item.id] = item.rotation;
  return out;
}
