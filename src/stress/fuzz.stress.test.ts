/**
 * OPERATION FUZZER — the whole model+solver driven by random operation sequences.
 * After EVERY step, global invariants must hold:
 *   1. no operation throws;
 *   2. each op leaves its INPUT map unmutated (all ops are pure/clone);
 *   3. every chain is structurally coherent (id===key, root∈nodes, orderedNodes
 *      starts at the root with no repeats, descendants terminate & exclude self);
 *   4. poseRig on finite positions yields finite positions (no silent NaN).
 */
import { describe, it, expect } from "vitest";
import type { BendLimit, ChainMap, Stiffness, Vec2 } from "../types";
import { STIFFNESS_ORDER } from "../types";
import {
  addNode,
  buildChain,
  clearLimits,
  createChain,
  deleteChain,
  descendantChainIds,
  disableSegmentRig,
  enableSegmentRig,
  orderedNodes,
  pruneMissing,
  removeToken,
  renameChain,
  renameNode,
  resetJointPivots,
  setAnchorLimit,
  setChainColor,
  setDefaultLimit,
  setJointPivot,
  setNodeLimit,
  setNodeStiffness,
  setParentNode,
  updateSettings,
} from "../model/chains";
import { poseRig } from "../ik/pose";
import { rng } from "./helpers";

const POOL = Array.from({ length: 16 }, (_, i) => `t${i}`);
// A fixed, finite transform grid for every pool token.
const GRID_POS: Record<string, Vec2> = Object.fromEntries(POOL.map((id, i) => [id, { x: (i % 4) * 30 + (i * 7) % 11, y: Math.floor(i / 4) * 25 + (i * 13) % 9 }]));
const GRID_ROT: Record<string, number> = Object.fromEntries(POOL.map((id, i) => [id, (i * 37) % 360]));

function checkInvariants(map: ChainMap): void {
  for (const [cid, c] of Object.entries(map)) {
    expect(c.id).toBe(cid);
    expect(c.rootId in c.nodes).toBe(true);
    const order = orderedNodes(c);
    expect(order[0]).toBe(c.rootId);
    expect(new Set(order).size).toBe(order.length);
    // Every ordered node has a real record.
    for (const id of order) expect(c.nodes[id]).toBeDefined();
    const desc = descendantChainIds(map, cid);
    expect(desc.includes(cid)).toBe(false);
    expect(new Set(desc).size).toBe(desc.length);
  }
}

function poseFinite(map: ChainMap, r: () => number): void {
  const ids = Object.keys(map);
  if (ids.length === 0) return;
  const cid = ids[Math.floor(r() * ids.length)];
  const involved = [cid, ...descendantChainIds(map, cid)];
  const tokens = new Set(involved.flatMap((id) => Object.keys(map[id].nodes)));
  const base: Record<string, Vec2> = {};
  const baseRot: Record<string, number> = {};
  for (const t of tokens) { base[t] = { ...(GRID_POS[t] ?? { x: 0, y: 0 }) }; baseRot[t] = GRID_ROT[t] ?? 0; }
  const order = orderedNodes(map[cid]);
  const grab = order.length > 1 && r() < 0.8
    ? { mode: "solve" as const, grabbedId: order[1 + Math.floor(r() * (order.length - 1))], target: { x: (r() - 0.5) * 200, y: (r() - 0.5) * 200 } }
    : { mode: "translate" as const, delta: { x: (r() - 0.5) * 100, y: (r() - 0.5) * 100 } };
  const { positions } = poseRig(map, cid, base, grab, undefined, baseRot);
  for (const [id, p] of Object.entries(positions)) {
    expect(Number.isFinite(p.x), `NaN x at ${id}`).toBe(true);
    expect(Number.isFinite(p.y), `NaN y at ${id}`).toBe(true);
  }
}

describe("operation fuzzer", () => {
  for (const seed of [0x1234, 0xABCD, 0x9E37, 0x2718, 0x5A5A]) {
    it(`random op sequences preserve all invariants (seed ${seed.toString(16)})`, () => {
      const r = rng(seed);
      const pick = <T>(a: T[]): T => a[Math.floor(r() * a.length)];
      const someIds = (k: number): string[] => {
        const out: string[] = [];
        const shuffled = [...POOL].sort(() => r() - 0.5);
        for (let i = 0; i < k; i++) out.push(shuffled[i]);
        return out;
      };
      const posOf = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, GRID_POS[id]]));
      const rotOf = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, GRID_ROT[id]]));
      const range = (): BendLimit => { const a = (r() - 0.5) * 3, b = (r() - 0.5) * 3; return { min: Math.min(a, b), max: Math.max(a, b) }; };
      const someChain = (m: ChainMap): string | undefined => { const k = Object.keys(m); return k.length ? pick(k) : undefined; };

      let map: ChainMap = {};
      const STEPS = 700;
      for (let step = 0; step < STEPS; step++) {
        const prev = map; // keep the pre-op object; ops must not mutate it
        const before = JSON.stringify(map);
        const op = Math.floor(r() * 22);
        try {
          switch (op) {
            case 0: { const ids = someIds(2 + Math.floor(r() * 4)); const b = buildChain(map, ids, posOf(ids), rotOf(ids)); if (b) map = b[0]; break; }
            case 1: { [map] = createChain(map, pick(POOL)); break; }
            case 2: { const c = someChain(map); if (c) map = addNode(map, c, pick(POOL), pick(POOL), r() * 20, (r() - 0.5) * 360); break; }
            case 3: { map = removeToken(map, pick(POOL)); break; }
            case 4: { const c = someChain(map); if (c) map = deleteChain(map, c); break; }
            case 5: { const c = someChain(map); if (c) map = setParentNode(map, c, r() < 0.2 ? null : pick(POOL)); break; }
            case 6: { map = setNodeStiffness(map, pick(POOL), pick(STIFFNESS_ORDER) as Stiffness); break; }
            case 7: { const c = someChain(map); if (c) map = updateSettings(map, c, { autoRotate: r() < 0.5, ease: r() < 0.5, defaultStiffness: pick(STIFFNESS_ORDER) as Stiffness }); break; }
            case 8: { const c = someChain(map); if (c) map = setDefaultLimit(map, c, r() < 0.2 ? null : range()); break; }
            case 9: { const c = someChain(map); if (c) map = setNodeLimit(map, c, pick(POOL), r() < 0.2 ? null : range()); break; }
            case 10: { const c = someChain(map); if (c) map = setAnchorLimit(map, c, r() < 0.2 ? null : range()); break; }
            case 11: { const c = someChain(map); if (c) map = clearLimits(map, c); break; }
            case 12: { const c = someChain(map); if (c) { const ids = orderedNodes(map[c]); map = enableSegmentRig(map, c, posOf(ids), rotOf(ids)); } break; }
            case 13: { const c = someChain(map); if (c) map = disableSegmentRig(map, c); break; }
            case 14: { const c = someChain(map); if (c) { const ids = orderedNodes(map[c]); map = setJointPivot(map, c, Math.floor(r() * (ids.length + 2)), { x: (r() - 0.5) * 100, y: (r() - 0.5) * 100 }, posOf(ids), rotOf(ids)); } break; }
            case 15: { const c = someChain(map); if (c) { const ids = orderedNodes(map[c]); map = resetJointPivots(map, c, posOf(ids), rotOf(ids)); } break; }
            case 16: { const c = someChain(map); if (c) map = renameChain(map, c, r() < 0.3 ? "  " : `name${Math.floor(r() * 5)}`); break; }
            case 17: { map = renameNode(map, pick(POOL), r() < 0.3 ? "" : `nn${Math.floor(r() * 5)}`); break; }
            case 18: { const c = someChain(map); if (c) map = setChainColor(map, c, `#${Math.floor(r() * 0xffffff).toString(16).padStart(6, "0")}`); break; }
            case 19: { const keep = new Set(POOL.filter(() => r() < 0.7)); map = pruneMissing(map, keep); break; }
            case 20: { map = pruneMissing(map, new Set(POOL)); break; }
            case 21: { poseFinite(map, r); break; }
          }
        } catch (e) {
          throw new Error(`op ${op} threw at step ${step} (seed ${seed.toString(16)}): ${(e as Error).message}\nmap=${before}`);
        }
        // Invariant 2: the op did not MUTATE its input map (all ops clone).
        // `prev` still points at the pre-op object; its value must be unchanged.
        expect(JSON.stringify(prev), `op ${op} mutated its input at step ${step}`).toBe(before);
        checkInvariants(map);
      }
      // Final sanity: a full prune-to-empty clears everything.
      expect(pruneMissing(map, new Set<string>())).toEqual({});
    });
  }
});
