import OBR from "@owlbear-rodeo/sdk";
import { type ChainMap } from "../types";
import { getChains, onChainsChange } from "./chainStore";
import { followUpdates, type Transform } from "../ik/follow";

/**
 * Reactive follow wiring: when a BARE parent token (a body that isn't a chain) is
 * moved by ANY tool, rigidly carry the chains attached to it. Only the GM writes
 * (its `updateItems` syncs to every client), matching the prune handler's single-
 * writer posture so N clients don't clobber each other. The geometry is the pure
 * `followUpdates`; here we just diff the scene and apply.
 */

let cached: ChainMap = {};
let isGM = false;
// Last-seen transform of every scene item, so we can tell which parent tokens
// actually moved this tick. Reset on scene switch (positions are scene-specific).
let last: Record<string, Transform> = {};

/** Does any chain follow a token that isn't itself a chain node? */
function anyBareAttached(chains: ChainMap): boolean {
  const tokens = new Set<string>();
  for (const c of Object.values(chains)) for (const id of Object.keys(c.nodes)) tokens.add(id);
  return Object.values(chains).some((c) => c.parentNodeId && !tokens.has(c.parentNodeId));
}

export function setupFollow(): void {
  getChains().then((c) => (cached = c)).catch(() => {});
  onChainsChange((c) => (cached = c));
  OBR.player.getRole().then((r) => (isGM = r === "GM")).catch(() => {});
  OBR.player.onChange((p) => (isGM = p.role === "GM"));
  // A new scene has its own coordinates — forget the old snapshot so the first
  // tick there just records (rather than "carrying" by a cross-scene delta).
  OBR.scene.onReadyChange((ready) => {
    if (ready) last = {};
  });

  OBR.scene.items.onChange((items) => {
    if (!isGM) return; // single writer
    if (items.length === 0) return; // empty = mid scene-switch, not a real state
    // Fast path: nothing follows a bare token, so there's nothing to carry.
    if (!anyBareAttached(cached)) {
      last = {};
      return;
    }
    const cur: Record<string, Transform> = {};
    for (const it of items) cur[it.id] = { pos: { x: it.position.x, y: it.position.y }, rot: it.rotation };
    // First tick after a (re)seed: record the baseline, don't carry — otherwise a
    // freshly-attached body would yank its arms by a bogus delta.
    if (Object.keys(last).length === 0) {
      last = cur;
      return;
    }
    const updates = followUpdates(cached, last, cur);
    // Advance the snapshot to the POST-carry state BEFORE writing, so the
    // onChange our own updateItems triggers sees no further movement (no loop).
    last = { ...cur, ...updates };
    const ids = Object.keys(updates);
    if (ids.length === 0) return;
    OBR.scene.items.updateItems(ids, (its) =>
      its.forEach((it) => {
        const u = updates[it.id];
        if (u) {
          it.position = u.pos;
          it.rotation = u.rot;
        }
      }),
    ).catch(() => {});
  });
}
