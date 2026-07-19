import OBR, { buildLine, buildShape, type Item } from "@owlbear-rodeo/sdk";
import { type Chain, type Vec2 } from "../types";
import { BONES_META } from "./constants";
import { getChains, orderedNodes } from "./chainStore";
import { getPositions } from "./scene";

/**
 * On-canvas SKELETON overlay: a line for every bone and a dot on every joint of
 * every chain, drawn in the chain's colour ON TOP of the tokens (the NOTE layer,
 * above CHARACTER) so the rig stays legible even where segment art overlaps.
 *
 * Like the highlight aura these are LOCAL items (per-client, never synced or
 * persisted) — so only the GM driving the rig sees them, with no shared-scene
 * ownership races or hidden-token privacy concerns. A single global toggle
 * (`ik.bones` in localStorage, shared across the extension's iframes) turns the
 * whole overlay on or off; `refreshBones` reads it each time.
 */

const isBone = (i: Item): boolean => i.metadata[BONES_META] === true;
const NEUTRAL = "#8b8f9a"; // chains built before colours existed

/** localStorage flag: "1" shows the skeleton overlay for every chain. */
export const BONES_KEY = "ik.bones";
export function bonesEnabled(): boolean {
  try {
    return localStorage.getItem(BONES_KEY) === "1";
  } catch {
    return false;
  }
}

// Serialize every op so a clear can't interleave with a rebuild — concurrent
// runs (a pose finishing as the chain list changes) would otherwise each read
// the same "existing" set and both add, stranding a duplicate skeleton.
let queue: Promise<unknown> = Promise.resolve();
function serialize(op: () => Promise<void>): Promise<void> {
  const run = queue.then(op, op);
  queue = run.catch(() => {});
  return run;
}

// Grid dpi is fixed for a session, so cache it — repeated refreshes shouldn't
// each pay an IPC round-trip.
let dpi: number | undefined;
async function gridDpi(): Promise<number> {
  if (dpi === undefined) dpi = await OBR.scene.grid.getDpi();
  return dpi;
}

async function removeAll(): Promise<void> {
  const existing = await OBR.scene.local.getItems(isBone);
  if (existing.length) await OBR.scene.local.deleteItems(existing.map((i) => i.id));
}

/** Remove every bone/joint shape this client has drawn. */
export function clearBones(): Promise<void> {
  return serialize(removeAll);
}

function boneShapes(chain: Chain, positions: Record<string, Vec2>, d: number): Item[] {
  const color = chain.color ?? NEUTRAL;
  const order = orderedNodes(chain);
  const items: Item[] = [];
  // Bones first so the joint dots sit on top of the line ends.
  for (const id of order) {
    const parentId = chain.nodes[id]?.parentId;
    if (!parentId) continue;
    const a = positions[parentId];
    const b = positions[id];
    if (!a || !b) continue;
    items.push(
      buildLine()
        .startPosition(a)
        .endPosition(b)
        .strokeColor(color)
        .strokeWidth(Math.max(3, d * 0.03))
        .strokeOpacity(0.9)
        .layer("NOTE") // above the CHARACTER layer, so the rig reads on top
        .locked(true)
        .disableHit(true)
        .metadata({ [BONES_META]: true })
        .build(),
    );
  }
  for (const id of order) {
    const p = positions[id];
    if (!p) continue;
    // The root joint is drawn larger and hollow so the chain's anchor stands out.
    const root = id === chain.rootId;
    const size = d * (root ? 0.22 : 0.13);
    items.push(
      buildShape()
        .shapeType("CIRCLE")
        .width(size)
        .height(size)
        .position(p) // OBR centres a CIRCLE on its position — right on the joint
        .fillColor(color)
        .fillOpacity(root ? 0.2 : 0.95)
        .strokeColor(color)
        .strokeWidth(Math.max(2, d * 0.02))
        .strokeOpacity(0.95)
        .layer("NOTE")
        .locked(true)
        .disableHit(true)
        .metadata({ [BONES_META]: true })
        .build(),
    );
  }
  return items;
}

/**
 * Rebuild the skeleton overlay from scratch: clear any existing bone/joint
 * shapes, then — when the overlay is enabled — draw the bones and joints of
 * every chain in its colour. Call after a pose completes and whenever the chain
 * set changes. A no-op (just a clear) while the toggle is off.
 */
export function refreshBones(): Promise<void> {
  return serialize(async () => {
    await removeAll();
    if (!bonesEnabled()) return;
    const chains = await getChains();
    const list = Object.values(chains);
    if (list.length === 0) return;
    const allIds = [...new Set(list.flatMap((c) => Object.keys(c.nodes)))];
    const [positions, d] = await Promise.all([getPositions(allIds), gridDpi()]);
    const items = list.flatMap((c) => boneShapes(c, positions, d));
    if (items.length) await OBR.scene.local.addItems(items);
  });
}
