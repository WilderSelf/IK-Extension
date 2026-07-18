/**
 * Pure geometry for the on-canvas bend-limit picker: a circle centred on a
 * joint with a filled wedge marking the allowed bend range and two draggable
 * handles at the range's extents.
 *
 * All angles are measured the SAME way the solver measures a bend — signed,
 * relative to a reference direction (the grandparent->parent bone), using
 * `atan2` in the scene's coordinate frame — so the filled wedge corresponds
 * exactly to the poses `fabrik` will permit. No Owlbear imports; unit-tested.
 */
import type { Vec2 } from "../types";

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Wrap degrees into (-180, 180]. */
export function wrapDeg180(d: number): number {
  const x = ((((d + 180) % 360) + 360) % 360) - 180;
  // Keep +180 as +180 (match the solver's (-pi, pi] convention) rather than -180.
  return x === -180 ? 180 : x;
}

/**
 * Signed bend of `pointer` about `pivot`, relative to reference angle `refRad`,
 * in degrees within (-180, 180]. This is the value a dragged handle writes to
 * the joint's min/max.
 */
export function bendAngleDeg(pivot: Vec2, refRad: number, pointer: Vec2): number {
  const a = Math.atan2(pointer.y - pivot.y, pointer.x - pivot.x);
  return wrapDeg180((a - refRad) * DEG);
}

/** The point on the circle at (`refRad` + `offsetDeg`), radius `r`, about `pivot`. */
export function anglePoint(pivot: Vec2, refRad: number, offsetDeg: number, r: number): Vec2 {
  const a = refRad + offsetDeg * RAD;
  return { x: pivot.x + Math.cos(a) * r, y: pivot.y + Math.sin(a) * r };
}

/**
 * Points tracing the ALLOWED arc from `minDeg` to `maxDeg` (the shorter of the
 * two orderings is irrelevant — the solver clamps to [min(lo,hi), max(lo,hi)],
 * so the wedge always spans that contiguous interval). Includes both endpoints;
 * prepend `pivot` to close a filled sector.
 */
export function arcPoints(
  pivot: Vec2,
  refRad: number,
  minDeg: number,
  maxDeg: number,
  r: number,
  segments = 64,
): Vec2[] {
  const lo = Math.min(minDeg, maxDeg);
  const hi = Math.max(minDeg, maxDeg);
  const steps = Math.max(1, Math.ceil((segments * (hi - lo)) / 360));
  const pts: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    pts.push(anglePoint(pivot, refRad, lo + ((hi - lo) * i) / steps, r));
  }
  return pts;
}
