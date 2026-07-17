import OBR, { type Item } from "@owlbear-rodeo/sdk";
import type { Chain, Vec2 } from "../types";
import { ROTATION_OFFSET_DEG, TOKEN_LAYERS } from "./constants";

/** Convert a bone math-angle (radians) to an OBR item rotation in degrees. */
export function radToObrDeg(rad: number): number {
  const deg = (rad * 180) / Math.PI + ROTATION_OFFSET_DEG;
  return ((deg % 360) + 360) % 360;
}

export function isToken(item: Item): boolean {
  return TOKEN_LAYERS.has(item.layer);
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

/** All token ids referenced by a chain (root included). */
export function chainTokenIds(chain: Chain): string[] {
  return Object.keys(chain.nodes);
}
