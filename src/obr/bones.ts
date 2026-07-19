import OBR, { buildLine, buildShape, type Item } from "@owlbear-rodeo/sdk";
import { type Chain, type ChainMap, type Vec2 } from "../types";
import { BONES_META } from "./constants";
import { getChains, isSegmentRig, orderedNodes } from "./chainStore";
import { getPositions } from "./scene";
import { reconstructJoints } from "../ik/segment";
import { dist } from "../ik/vec";

/**
 * On-canvas SKELETON overlay: a line for every bone and a dot on every joint of
 * every chain, drawn in the chain's colour ON TOP of the tokens (the NOTE layer,
 * above CHARACTER) so the rig stays legible even where segment art overlaps. A
 * segment rig draws its actual JOINTS (shoulder/elbow/wrist); a default chain
 * draws the token-centre topology.
 *
 * Like the highlight aura these are LOCAL items (per-client, never synced or
 * persisted) — so only the GM driving the rig sees them, with no shared-scene
 * ownership races or hidden-token privacy concerns. A single global toggle
 * (`ik.bones` in localStorage, shared across the extension's iframes) turns the
 * whole overlay on or off; `refreshBones` reads it each time.
 */

const isBone = (i: Item): boolean => i.metadata[BONES_META] === true;
const NEUTRAL = "#8b8f9a"; // chains built before colours existed

/** A single joint moved to `world` for a live drag preview (before it's saved). */
export interface JointOverride {
  chainId: string;
  jointIndex: number;
  world: Vec2;
}

/** localStorage flag: "1" shows the skeleton overlay for every chain. */
export const BONES_KEY = "ik.bones";
export function bonesEnabled(): boolean {
  try {
    return localStorage.getItem(BONES_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * localStorage flag: "1" puts the Pose tool into pivot-edit mode — dragging near
 * a segment-rig joint moves that pivot instead of posing. Read by the tool (same
 * origin as the popover, so the key is shared). Only useful with the overlay on.
 */
export const EDIT_PIVOTS_KEY = "ik.editPivots";
export function editPivotsEnabled(): boolean {
  try {
    return localStorage.getItem(EDIT_PIVOTS_KEY) === "1";
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

/**
 * A chain's segment-rig JOINTS (world positions, N+1 of them), or `null` if it's
 * not a segment rig or a token position is missing. These are the draggable pivots.
 */
export function segmentJoints(chain: Chain, positions: Record<string, Vec2>): Vec2[] | null {
  if (!isSegmentRig(chain)) return null;
  const centres = orderedNodes(chain).map((id) => positions[id]);
  if (centres.some((c) => !c)) return null;
  return reconstructJoints(centres as Vec2[], chain.pivots);
}

/** The skeleton to draw for one chain: dots (with the root flagged) + bone segments. */
function skeletonOf(
  chain: Chain,
  positions: Record<string, Vec2>,
  override?: JointOverride,
): { dots: { p: Vec2; root: boolean }[]; bones: [Vec2, Vec2][] } {
  const joints = segmentJoints(chain, positions);
  if (joints) {
    if (override && override.chainId === chain.id && override.jointIndex < joints.length) {
      joints[override.jointIndex] = override.world;
    }
    const bones: [Vec2, Vec2][] = [];
    for (let i = 0; i + 1 < joints.length; i++) bones.push([joints[i], joints[i + 1]]);
    return { dots: joints.map((p, i) => ({ p, root: i === 0 })), bones };
  }
  // Default rig: token-centre topology.
  const order = orderedNodes(chain);
  const bones: [Vec2, Vec2][] = [];
  for (const id of order) {
    const parentId = chain.nodes[id]?.parentId;
    if (parentId && positions[parentId] && positions[id]) bones.push([positions[parentId], positions[id]]);
  }
  const dots = order
    .filter((id) => positions[id])
    .map((id) => ({ p: positions[id], root: id === chain.rootId }));
  return { dots, bones };
}

function boneShapes(chain: Chain, positions: Record<string, Vec2>, d: number, override?: JointOverride): Item[] {
  const color = chain.color ?? NEUTRAL;
  const { dots, bones } = skeletonOf(chain, positions, override);
  const items: Item[] = [];
  // Bones first so the joint dots sit on top of the line ends.
  for (const [a, b] of bones) {
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
  for (const { p, root } of dots) {
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

async function drawFrom(
  chains: ChainMap,
  positions: Record<string, Vec2>,
  override?: JointOverride,
): Promise<void> {
  await removeAll();
  if (!bonesEnabled()) return;
  const list = Object.values(chains);
  if (list.length === 0) return;
  const d = await gridDpi();
  const items = list.flatMap((c) => boneShapes(c, positions, d, override));
  if (items.length) await OBR.scene.local.addItems(items);
}

/**
 * Rebuild the skeleton overlay from the live scene: clear existing shapes, then
 * (when enabled) draw every chain's bones + joints in its colour. Call after a
 * pose completes and whenever the chain set changes. A no-op clear while off.
 */
export function refreshBones(): Promise<void> {
  return serialize(async () => {
    const chains = await getChains();
    const allIds = [...new Set(Object.values(chains).flatMap((c) => Object.keys(c.nodes)))];
    const positions = allIds.length ? await getPositions(allIds) : {};
    await drawFrom(chains, positions, undefined);
  });
}

/**
 * Redraw the overlay from CACHED chains + positions with one joint overridden —
 * used for live feedback while a pivot is dragged, without re-reading the scene
 * every pointer move.
 */
export function previewBones(
  chains: ChainMap,
  positions: Record<string, Vec2>,
  override: JointOverride,
): Promise<void> {
  return serialize(() => drawFrom(chains, positions, override));
}

/**
 * The nearest draggable segment-rig joint to `pointer` within `maxDist` scene
 * units, or `null`. Used by the tool to pick up a pivot for editing.
 */
export function findNearestJoint(
  chains: ChainMap,
  positions: Record<string, Vec2>,
  pointer: Vec2,
  maxDist: number,
): { chainId: string; jointIndex: number; world: Vec2 } | null {
  let best: { chainId: string; jointIndex: number; world: Vec2; d: number } | null = null;
  for (const chain of Object.values(chains)) {
    const joints = segmentJoints(chain, positions);
    if (!joints) continue;
    for (let i = 0; i < joints.length; i++) {
      const dd = dist(joints[i], pointer);
      if (dd <= maxDist && (!best || dd < best.d)) {
        best = { chainId: chain.id, jointIndex: i, world: joints[i], d: dd };
      }
    }
  }
  return best && { chainId: best.chainId, jointIndex: best.jointIndex, world: best.world };
}
