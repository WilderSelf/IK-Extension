/** Shared builders/asserts for the adversarial stress suites. */
import type { Chain, ChainMap, ChainNode, Vec2 } from "../types";
import { defaultSettings } from "../types";
import { dist } from "../ik/vec";

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pos = (o: Record<string, [number, number]>): Record<string, Vec2> =>
  Object.fromEntries(Object.entries(o).map(([k, [x, y]]) => [k, { x, y }]));
export const rot0 = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, 0]));
export const idOf = (m: ChainMap, root: string) => Object.values(m).find((c) => c.rootId === root)!.id;

export const finite = (v: number | undefined): boolean => v !== undefined && Number.isFinite(v);
export const finitePt = (p: Vec2 | undefined): boolean => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
export const allFinite = (ps: Record<string, Vec2>): boolean => Object.values(ps).every(finitePt);

/**
 * Build a straight N-token chain DIRECTLY (no buildChain O(N²) clone), root at the
 * origin, bones of length `step` along +x. Returns the chain + its rest positions.
 */
export function makeLine(n: number, step = 10, prefix = "n"): { chain: Chain; positions: Record<string, Vec2> } {
  const nodes: Record<string, ChainNode> = {};
  const positions: Record<string, Vec2> = {};
  for (let i = 0; i < n; i++) {
    const id = `${prefix}${i}`;
    nodes[id] = { parentId: i === 0 ? null : `${prefix}${i - 1}`, restLength: i === 0 ? 0 : step, boneOffsetDeg: 0 };
    positions[id] = { x: i * step, y: 0 };
  }
  return {
    chain: { id: "big", rootId: `${prefix}0`, nodes, settings: { ...defaultSettings() }, color: "#ef4444" },
    positions,
  };
}

/** Every consecutive bone length of an ordered position list. */
export function boneLengths(order: string[], p: Record<string, Vec2>): number[] {
  const out: number[] = [];
  for (let i = 1; i < order.length; i++) out.push(dist(p[order[i - 1]], p[order[i]]));
  return out;
}
