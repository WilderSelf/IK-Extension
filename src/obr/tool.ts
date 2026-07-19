import OBR, {
  type Item,
  type ToolContext,
  type ToolEvent,
} from "@owlbear-rodeo/sdk";
import { type Chain, type ChainMap, type Vec2, DEFAULT_ROTATION_OFFSET_DEG } from "../types";
import { type Grab, type Pose, poseRig } from "../ik/pose";
import { MODE_POSE, POSE_SHORTCUT, TOOL_ID, asset } from "./constants";
import { descendantChainIds, findChainForToken, getChains, saveChains, setJointPivot } from "./chainStore";
import { editPivotsEnabled, findNearestJoint, previewBones, refreshBones } from "./bones";
import { getPositions, getRotations, radToObrDeg } from "./scene";
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
/** Max distance (scene units) to grab a joint pivot in edit-pivots mode. */
const JOINT_GRAB_RADIUS = 150;

type InteractionUpdate = (draft: (items: Item[]) => void) => Item[];
type InteractionStop = () => void;

interface DragState {
  // The posed chain plus every chain that (transitively) follows one of its
  // nodes — the whole rig that moves together.
  involved: ChainMap;
  posedChainId: string;
  mode: "translate" | "solve";
  grabbedId: string;
  /** token id -> the involved chain that owns it (for per-chain auto-rotate). */
  tokenChainId: Record<string, string>;
  basePositions: Record<string, Vec2>;
  /** Pre-drag token rotations (deg) — a segment rig reconstructs joints from these. */
  baseRotations: Record<string, number>;
  startPointer: Vec2;
  ids: string[];
  update: InteractionUpdate;
  stop: InteractionStop;
}

let drag: DragState | null = null;

// An in-progress pivot drag (edit-pivots mode). The token centres are cached at
// start — they don't move while a joint is dragged — so live preview + the final
// save don't re-read the scene per pointer move.
interface PivotDrag {
  chainId: string;
  jointIndex: number;
  chains: ChainMap;
  positions: Record<string, Vec2>;
  rotations: Record<string, number>;
}
let pivotDrag: PivotDrag | null = null;

// True while onPoseDragStart is awaiting async setup. If the drag is ended or
// cancelled during that window, `cancelledDuringStart` tells setup to tear the
// interaction down immediately instead of leaking it for ~30s.
let starting = false;
let cancelledDuringStart = false;

async function resolveGrabbed(
  chains: ChainMap,
  event: ToolEvent,
): Promise<{ chain: Chain; grabbedId: string } | null> {
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
  let grab: Grab;
  if (state.mode === "translate") {
    grab = { mode: "translate", delta };
  } else {
    const base = state.basePositions[state.grabbedId];
    const target = base ? { x: base.x + delta.x, y: base.y + delta.y } : pointer;
    grab = { mode: "solve", grabbedId: state.grabbedId, target };
  }
  return poseRig(state.involved, state.posedChainId, state.basePositions, grab, undefined, state.baseRotations);
}

function applyPose(state: DragState, pose: Pose, items: Item[]): void {
  for (const item of items) {
    const np = pose.positions[item.id];
    // Only write finite coordinates — a NaN slipping through the solver would
    // otherwise be persisted to the scene and wreck the token's position.
    if (np && Number.isFinite(np.x) && Number.isFinite(np.y)) {
      item.position = { x: np.x, y: np.y };
    }
    // Auto-rotate is per the token's OWN chain: honor that chain's setting and
    // use the token's captured offset. Whether a token rotates (including a
    // chain's root, which turns to face its child unless it's a shared pivot) is
    // decided in poseRig — it only emits a rotation for tokens that should turn,
    // so a missing entry here means "leave this token's orientation alone".
    const chain = state.involved[state.tokenChainId[item.id]];
    if (
      chain?.settings.autoRotate &&
      pose.rotations[item.id] !== undefined
    ) {
      const node = chain.nodes[item.id];
      // A segment rig measures the offset against the SEGMENT direction, so use
      // its captured `seg.offsetDeg`; the default rig uses the incoming-bone offset.
      const off =
        chain.settings.segmentRig && node?.seg
          ? node.seg.offsetDeg
          : node?.boneOffsetDeg ?? DEFAULT_ROTATION_OFFSET_DEG;
      item.rotation = radToObrDeg(pose.rotations[item.id], off);
    }
    // Note: we read/write position + rotation only, never `scale`, so a token's
    // negative-scale flip survives posing untouched.
  }
}

/**
 * Edit-pivots mode: pick up the nearest segment-rig joint to the pointer. The
 * token centres are cached so the drag previews and saves without re-reading the
 * scene each move. No joint within reach → nothing happens (posing stays off).
 */
async function startPivotDrag(event: ToolEvent): Promise<void> {
  const chains = await getChains();
  const ids = [...new Set(Object.values(chains).flatMap((c) => Object.keys(c.nodes)))];
  if (ids.length === 0) return;
  const [positions, rotations] = await Promise.all([getPositions(ids), getRotations(ids)]);
  const hit = findNearestJoint(chains, positions, rotations, event.pointerPosition, JOINT_GRAB_RADIUS);
  if (!hit || cancelledDuringStart) return;
  pivotDrag = { chainId: hit.chainId, jointIndex: hit.jointIndex, chains, positions, rotations };
}

async function onPoseDragStart(_ctx: ToolContext, event: ToolEvent): Promise<void> {
  drag = null;
  pivotDrag = null;
  starting = true;
  cancelledDuringStart = false;
  try {
    // GM-only: players never pose (safe default; the tool icon is GM-filtered
    // too, so a player never even sees it).
    if ((await OBR.player.getRole()) !== "GM") return;

    // Pivot-edit mode redirects the drag from posing to moving a joint pivot.
    if (editPivotsEnabled()) {
      await startPivotDrag(event);
      return;
    }

    const chains = await getChains();
    const grabbed = await resolveGrabbed(chains, event);
    if (!grabbed) return;
    const { chain, grabbedId } = grabbed;
    const mode: "translate" | "solve" = grabbedId === chain.rootId ? "translate" : "solve";

    // The rig that moves together: the grabbed chain plus every chain that
    // (transitively) follows one of its nodes.
    const involvedIds = [chain.id, ...descendantChainIds(chains, chain.id)];
    const involved: ChainMap = {};
    const tokenChainId: Record<string, string> = {};
    const idSet = new Set<string>();
    for (const cid of involvedIds) {
      const c = chains[cid];
      involved[cid] = c;
      for (const tid of Object.keys(c.nodes)) {
        // First chain wins: the posed chain is processed first, so a token that
        // is also a child's shared pivot is attributed to the chain it's a
        // segment of (which auto-rotates it correctly).
        if (!(tid in tokenChainId)) tokenChainId[tid] = cid;
        idSet.add(tid);
      }
    }
    const ids = [...idSet];
    const items = await OBR.scene.items.getItems((i) => idSet.has(i.id));
    const basePositions: Record<string, Vec2> = {};
    const baseRotations: Record<string, number> = {};
    for (const it of items) {
      basePositions[it.id] = { x: it.position.x, y: it.position.y };
      baseRotations[it.id] = it.rotation;
    }

    // The posed chain's parent token (a body, or an ancestor chain's node) is NOT
    // part of the interaction, but its orientation is the reference for an anchor
    // limit. Fetch its transform once — it doesn't move during this drag — so
    // poseRig can read it. Skipped if the parent is its own root (a shared anchor).
    const parentId = chain.parentNodeId;
    if (parentId && parentId !== chain.rootId && !(parentId in baseRotations)) {
      const [pItem] = await OBR.scene.items.getItems([parentId]);
      if (pItem) {
        basePositions[pItem.id] = { x: pItem.position.x, y: pItem.position.y };
        baseRotations[pItem.id] = pItem.rotation;
      }
    }

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
      involved,
      posedChainId: chain.id,
      mode,
      grabbedId,
      tokenChainId,
      basePositions,
      baseRotations,
      startPointer: { x: event.pointerPosition.x, y: event.pointerPosition.y },
      ids,
      update,
      stop,
    };
  } finally {
    starting = false;
  }
}

function onPoseDragMove(_ctx: ToolContext, event: ToolEvent): void {
  if (pivotDrag) {
    // Live feedback: redraw the overlay with this joint following the pointer.
    previewBones(pivotDrag.chains, pivotDrag.positions, pivotDrag.rotations, {
      chainId: pivotDrag.chainId,
      jointIndex: pivotDrag.jointIndex,
      world: event.pointerPosition,
    }).catch(() => {});
    return;
  }
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
  if (pivotDrag) {
    const pd = pivotDrag;
    pivotDrag = null;
    // Persist the joint's new home (in its anchor frame) and recapture rest data.
    // Re-read chains so a concurrent edit isn't clobbered; positions were cached.
    const ids = Object.keys(pd.chains[pd.chainId]?.nodes ?? {});
    const [chains, rotations] = await Promise.all([getChains(), getRotations(ids)]);
    const next = setJointPivot(chains, pd.chainId, pd.jointIndex, event.pointerPosition, pd.positions, rotations);
    if (next !== chains) await saveChains(next);
    await refreshBones();
    return;
  }
  if (!drag) return;
  const state = drag;
  drag = null;
  const pose = computePose(state, event.pointerPosition);
  // Persist final positions to the scene once, then release the interaction.
  await OBR.scene.items.updateItems(state.ids, (items) => applyPose(state, pose, items));
  state.stop();
  // Redraw the skeleton overlay (if enabled) so bones/joints track the new pose.
  // The overlay lines can't attach to two moving tokens, so they rebuild on
  // release rather than following live mid-drag.
  refreshBones().catch(() => {});
}

function onPoseDragCancel(): void {
  if (starting) {
    cancelledDuringStart = true;
    return;
  }
  if (pivotDrag) {
    // Drop the preview and redraw the saved skeleton.
    pivotDrag = null;
    refreshBones().catch(() => {});
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
    // Tool-activation hotkey so you can jump straight to posing without hunting
    // the toolbar. "K" is deliberately clear of Owlbear's built-in tool keys
    // (W/F/D/M/Q/N) and of its fog/draw sub-mode keys; a bare letter is never a
    // browser shortcut (those need Ctrl/Cmd/Alt). Owlbear surfaces the key in
    // the tool's tooltip. If you ever hit a conflict, change this one letter.
    shortcut: POSE_SHORTCUT,
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
