import OBR, {
  type Item,
  type ToolContext,
  type ToolEvent,
} from "@owlbear-rodeo/sdk";
import { type Chain, type Vec2, DEFAULT_ROTATION_OFFSET_DEG } from "../types";
import { type Pose, rigidTranslate, solvePose } from "../ik/pose";
import { MODE_POSE, TOOL_ID, asset } from "./constants";
import { findChainForToken, getChains } from "./chainStore";
import { getPositions, radToObrDeg } from "./scene";
import { dist } from "../ik/vec";

/**
 * The extension's single canvas tool. It has ONE mode (Pose) because Owlbear
 * routes drag events only to a tool — there is no other way to intercept a
 * token drag for real-time solving. Building and every other control live in
 * the action popover + the right-click menu, so nothing else clutters the
 * top-center toolbar (where Owlbear's own messaging renders).
 */

/** Max distance (scene units) to associate a pointer with a chained token. */
const GRAB_RADIUS = 300;

type InteractionUpdate = (draft: (items: Item[]) => void) => Item[];
type InteractionStop = () => void;

interface DragState {
  chain: Chain;
  mode: "translate" | "solve";
  grabbedId: string;
  basePositions: Record<string, Vec2>;
  startPointer: Vec2;
  ids: string[];
  update: InteractionUpdate;
  stop: InteractionStop;
  autoRotate: boolean;
}

let drag: DragState | null = null;

// True while onPoseDragStart is awaiting async setup. If the drag is ended or
// cancelled during that window, `cancelledDuringStart` tells setup to tear the
// interaction down immediately instead of leaking it for ~30s.
let starting = false;
let cancelledDuringStart = false;

async function resolveGrabbed(
  event: ToolEvent,
): Promise<{ chain: Chain; grabbedId: string } | null> {
  const chains = await getChains();
  const targetId = event.target?.id;
  if (targetId) {
    const chain = findChainForToken(chains, targetId);
    if (chain) return { chain, grabbedId: targetId };
  }
  // Fallback: nearest chained token to the pointer, within GRAB_RADIUS. Only
  // used on a pointer *miss*; a direct hit resolves the exact token above.
  const ids = Object.values(chains).flatMap((c) => Object.keys(c.nodes));
  if (ids.length === 0) return null;
  const positions = await getPositions(ids);
  let best: { id: string; d: number } | null = null;
  for (const id of ids) {
    const p = positions[id];
    if (!p) continue;
    const d = dist(p, event.pointerPosition);
    if (!best || d < best.d) best = { id, d };
  }
  if (!best || best.d > GRAB_RADIUS) return null;
  const chain = findChainForToken(chains, best.id);
  return chain ? { chain, grabbedId: best.id } : null;
}

function computePose(state: DragState, pointer: Vec2): Pose {
  const delta = { x: pointer.x - state.startPointer.x, y: pointer.y - state.startPointer.y };
  if (state.mode === "translate") {
    return rigidTranslate(state.chain, state.basePositions, delta);
  }
  const base = state.basePositions[state.grabbedId];
  const target = base ? { x: base.x + delta.x, y: base.y + delta.y } : pointer;
  return solvePose(state.chain, state.basePositions, state.grabbedId, target);
}

function applyPose(state: DragState, pose: Pose, items: Item[]): void {
  for (const item of items) {
    const np = pose.positions[item.id];
    // Only write finite coordinates — a NaN slipping through the solver would
    // otherwise be persisted to the scene and wreck the token's position.
    if (np && Number.isFinite(np.x) && Number.isFinite(np.y)) {
      item.position = { x: np.x, y: np.y };
    }
    if (
      state.autoRotate &&
      item.id !== state.chain.rootId &&
      pose.rotations[item.id] !== undefined
    ) {
      // Prefer the per-node authored offset (captured at build); fall back to
      // the global default for a node that somehow never captured one.
      const off = state.chain.nodes[item.id]?.boneOffsetDeg ?? DEFAULT_ROTATION_OFFSET_DEG;
      item.rotation = radToObrDeg(pose.rotations[item.id], off);
    }
    // Note: we read/write position + rotation only, never `scale`, so a token's
    // negative-scale flip survives posing untouched.
  }
}

async function onPoseDragStart(_ctx: ToolContext, event: ToolEvent): Promise<void> {
  drag = null;
  starting = true;
  cancelledDuringStart = false;
  try {
    // GM-only: players never pose (safe default; the tool icon is GM-filtered
    // too, so a player never even sees it).
    if ((await OBR.player.getRole()) !== "GM") return;

    const grabbed = await resolveGrabbed(event);
    if (!grabbed) return;
    const { chain, grabbedId } = grabbed;
    const mode: "translate" | "solve" = grabbedId === chain.rootId ? "translate" : "solve";

    const ids = Object.keys(chain.nodes);
    const idSet = new Set(ids);
    const items = await OBR.scene.items.getItems((i) => idSet.has(i.id));
    const basePositions: Record<string, Vec2> = {};
    for (const it of items) basePositions[it.id] = { x: it.position.x, y: it.position.y };

    const [update, stop] = (await OBR.interaction.startItemInteraction(items)) as [
      InteractionUpdate,
      InteractionStop,
    ];

    // The drag ended/cancelled while we were setting up — tear the interaction
    // down now rather than leaving it live.
    if (cancelledDuringStart) {
      stop();
      return;
    }

    drag = {
      chain,
      mode,
      grabbedId,
      basePositions,
      startPointer: { x: event.pointerPosition.x, y: event.pointerPosition.y },
      ids,
      update,
      stop,
      autoRotate: chain.settings.autoRotate,
    };
  } finally {
    starting = false;
  }
}

function onPoseDragMove(_ctx: ToolContext, event: ToolEvent): void {
  if (!drag) return;
  const state = drag;
  const pose = computePose(state, event.pointerPosition);
  state.update((items) => applyPose(state, pose, items));
}

async function onPoseDragEnd(_ctx: ToolContext, event: ToolEvent): Promise<void> {
  // Drag ended before setup finished: nothing to commit, so treat it as a
  // cancel and let onPoseDragStart clean up the pending interaction.
  if (starting) {
    cancelledDuringStart = true;
    return;
  }
  if (!drag) return;
  const state = drag;
  drag = null;
  const pose = computePose(state, event.pointerPosition);
  // Persist final positions to the scene once, then release the interaction.
  await OBR.scene.items.updateItems(state.ids, (items) => applyPose(state, pose, items));
  state.stop();
}

function onPoseDragCancel(): void {
  if (starting) {
    cancelledDuringStart = true;
    return;
  }
  if (!drag) return;
  // Interaction updates are ephemeral; stopping reverts to scene state.
  drag.stop();
  drag = null;
}

export async function setupTool(): Promise<void> {
  await OBR.tool.create({
    id: TOOL_ID,
    icons: [{ icon: asset("icon.svg"), label: "IK Chains", filter: { roles: ["GM"] } }],
    defaultMode: MODE_POSE,
  });

  await OBR.tool.createMode({
    id: MODE_POSE,
    icons: [{ icon: asset("pose.svg"), label: "Pose IK chain" }],
    onToolDragStart: onPoseDragStart,
    onToolDragMove: onPoseDragMove,
    onToolDragEnd: onPoseDragEnd,
    onToolDragCancel: onPoseDragCancel,
  });
}
