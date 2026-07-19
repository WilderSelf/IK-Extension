import { type ChainMap, type Vec2 } from "../types";
import { add, dist, rotateAround, sub } from "./vec";

/**
 * REACTIVE FOLLOW — carry a chain when its parent TOKEN moves.
 *
 * A chain can follow a token that isn't part of any chain (a body sprite, say) via
 * `Chain.parentNodeId`. When that bare token is moved by ANY tool, every chain
 * attached to it should ride along rigidly. This module is the pure geometry of
 * that carry; `obr/follow.ts` wires it to the live scene.
 *
 * Deliberately scoped to BARE parents (a parent token not in any chain). A parent
 * token that IS a chain node is already carried by `poseRig` when that chain is
 * posed, so following it here too would double-apply the same transform.
 */

/** A token's world transform: position + rotation in DEGREES (OBR's `item.rotation`). */
export interface Transform {
  pos: Vec2;
  rot: number;
}

// Ignore sub-threshold jitter so floating-point noise from the scene never
// triggers a spurious carry (and thus a needless scene write).
const POS_EPS = 0.01;
const ROT_EPS = 0.01;
const wrapDeg = (d: number): number => (((d + 180) % 360) + 360) % 360 - 180;

function moved(a: Transform, b: Transform): boolean {
  return dist(a.pos, b.pos) > POS_EPS || Math.abs(wrapDeg(a.rot - b.rot)) > ROT_EPS;
}

/**
 * The rigid-follow token updates for one scene tick: for every chain whose BARE
 * parent token moved between `last` and `cur`, carry all the chain's tokens by the
 * parent's translation + rotation about its NEW position. Returns token id → new
 * transform for exactly the tokens that must move (empty if nothing to do).
 *
 * Pure: `last`/`cur` map token id → transform. The caller diffs the scene and
 * applies the result; keeping it side-effect-free makes the carry unit-testable.
 */
export function followUpdates(
  chains: ChainMap,
  last: Record<string, Transform>,
  cur: Record<string, Transform>,
): Record<string, Transform> {
  const chainTokens = new Set<string>();
  for (const c of Object.values(chains)) for (const id of Object.keys(c.nodes)) chainTokens.add(id);

  const updates: Record<string, Transform> = {};
  for (const c of Object.values(chains)) {
    const p = c.parentNodeId;
    if (!p || chainTokens.has(p)) continue; // only BARE-token parents (see header)
    const lp = last[p];
    const cp = cur[p];
    if (!lp || !cp || !moved(lp, cp)) continue;

    const trans = sub(cp.pos, lp.pos);
    const dRot = cp.rot - lp.rot;
    const dRotRad = (dRot * Math.PI) / 180;
    for (const t of Object.keys(c.nodes)) {
      const base = last[t] ?? cur[t];
      if (!base) continue;
      // Rigid transform about the parent's new position: R·(x − pivotOld) + pivotNew,
      // written as rotate(translate(x)) which is algebraically identical.
      updates[t] = { pos: rotateAround(add(base.pos, trans), cp.pos, dRotRad), rot: base.rot + dRot };
    }
  }
  return updates;
}
