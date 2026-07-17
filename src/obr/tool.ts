import OBR, {
  type Item,
  type ToolContext,
  type ToolEvent,
} from "@owlbear-rodeo/sdk";
import { type Chain, type ChainMap, type Vec2, DEFAULT_ROTATION_OFFSET_DEG } from "../types";
import {
  type Pose,
  rigidTranslate,
  solvePose,
} from "../ik/pose";
import { shallowestSelectedPerBranch } from "../ik/tree";
import {
  MODE_BUILD,
  MODE_POSE,
  TOOL_ID,
} from "./constants";
import { findChainForToken, getChains, saveChains, createChain, addNode } from "./chainStore";
import { getPositions, isToken, radToObrDeg } from "./scene";
import { refreshConnectors } from "./connectors";
import { dist } from "../ik/vec";

/** Max distance (scene units) to associate a pointer with a chained token. */
const GRAB_RADIUS = 300;

type InteractionUpdate = (draft: (items: Item[]) => void) => Item[];
type InteractionStop = () => void;

interface DragState {
  chain: Chain;
  mode: "translate" | "solve";
  targetIds: string[];
  basePositions: Record<string, Vec2>;
  startPointer: Vec2;
  ids: string[];
  update: InteractionUpdate;
  stop: InteractionStop;
  autoRotate: boolean;
  rotationOffsetDeg: number;
}

let drag: DragState | null = null;

// True while onPoseDragStart is awaiting async setup. If the drag is ended or
// cancelled during that window, `cancelledDuringStart` tells setup to tear the
// interaction down immediately instead of leaking it.
let starting = false;
let cancelledDuringStart = false;

// ---- Build-mode state ------------------------------------------------------

// In-memory working copy of the chain map for the current build session. It is
// updated synchronously on each click so rapid clicks don't read stale scene
// metadata (OBR set/getMetadata is async with propagation latency).
let buildWorking: ChainMap | null = null;
let buildChainId: string | null = null;
let buildLastNodeId: string | null = null;

// ---- Permissions -----------------------------------------------------------

function canMoveNode(chain: Chain, role: "GM" | "PLAYER", id: string): boolean {
  if (role === "GM") return true;
  const ov = chain.settings.nodeOverrides?.[id];
  if (ov?.locked) return false;
  if (ov?.playerMovable === false) return false;
  // The root/anchor is off-limits to players unless explicitly enabled.
  if (id === chain.rootId && ov?.playerMovable !== true) return false;
  return chain.settings.playerPosable;
}

function canPose(chain: Chain, role: "GM" | "PLAYER", grabbedId: string): boolean {
  if (role === "GM") return true;
  if (!chain.settings.playerPosable) return false;
  return canMoveNode(chain, role, grabbedId);
}

// ---- Pose mode -------------------------------------------------------------

async function resolveGrabbed(
  event: ToolEvent,
): Promise<{ chain: Chain; grabbedId: string } | null> {
  const chains = await getChains();
  const targetId = event.target?.id;
  if (targetId) {
    const chain = findChainForToken(chains, targetId);
    if (chain) return { chain, grabbedId: targetId };
  }
  // Fallback: nearest chained token to the pointer, within GRAB_RADIUS.
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
  const targets: Record<string, Vec2> = {};
  for (const id of state.targetIds) {
    const b = state.basePositions[id];
    if (b) targets[id] = { x: b.x + delta.x, y: b.y + delta.y };
  }
  return solvePose(state.chain, state.basePositions, targets);
}

function applyPose(state: DragState, pose: Pose, items: Item[]): void {
  for (const item of items) {
    const np = pose.positions[item.id];
    if (np) item.position = { x: np.x, y: np.y };
    if (
      state.autoRotate &&
      item.id !== state.chain.rootId &&
      pose.rotations[item.id] !== undefined
    ) {
      item.rotation = radToObrDeg(pose.rotations[item.id], state.rotationOffsetDeg);
    }
  }
}

async function onPoseDragStart(_ctx: ToolContext, event: ToolEvent): Promise<void> {
  drag = null;
  starting = true;
  cancelledDuringStart = false;
  try {
    const grabbed = await resolveGrabbed(event);
    if (!grabbed) return;
    const { chain, grabbedId } = grabbed;

    const role = await OBR.player.getRole();
    if (!canPose(chain, role, grabbedId)) return;

    let mode: "translate" | "solve";
    let targetIds: string[] = [];
    if (grabbedId === chain.rootId) {
      mode = "translate";
    } else {
      mode = "solve";
      const selection = (await OBR.player.getSelection()) ?? [];
      const inChain = selection.filter((id) => id in chain.nodes);
      targetIds =
        inChain.length > 1 && inChain.includes(grabbedId)
          ? shallowestSelectedPerBranch(chain, inChain)
          : [grabbedId];
      targetIds = targetIds.filter((id) => canMoveNode(chain, role, id));
      if (targetIds.length === 0) return;
    }

    const ids = Object.keys(chain.nodes);
    const idSet = new Set(ids);
    const items = await OBR.scene.items.getItems((i) => idSet.has(i.id));
    const basePositions: Record<string, Vec2> = {};
    for (const it of items) basePositions[it.id] = { x: it.position.x, y: it.position.y };

    const [update, stop] = (await OBR.interaction.startItemInteraction(items)) as [
      InteractionUpdate,
      InteractionStop,
    ];

    // The drag was ended/cancelled while we were setting up — tear the
    // interaction down now rather than leaving it live for 30s.
    if (cancelledDuringStart) {
      stop();
      return;
    }

    drag = {
      chain,
      mode,
      targetIds,
      basePositions,
      startPointer: { x: event.pointerPosition.x, y: event.pointerPosition.y },
      ids,
      update,
      stop,
      autoRotate: chain.settings.autoRotate,
      rotationOffsetDeg: chain.settings.rotationOffsetDeg ?? DEFAULT_ROTATION_OFFSET_DEG,
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
  // Drag ended before setup finished: there's nothing to commit, so treat it
  // as a cancel and let onPoseDragStart clean up the pending interaction.
  if (starting) {
    cancelledDuringStart = true;
    return;
  }
  if (!drag) return;
  const state = drag;
  drag = null;
  const pose = computePose(state, event.pointerPosition);
  // Persist final positions to the scene, then release the interaction.
  await OBR.scene.items.updateItems(state.ids, (items) => applyPose(state, pose, items));
  state.stop();
  // Update the connector overlay to match the new pose (no-op if disabled).
  refreshConnectors().catch(() => {});
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

// ---- Build mode ------------------------------------------------------------

async function onBuildClick(_ctx: ToolContext, event: ToolEvent): Promise<void> {
  const item = event.target;
  if (!item || !isToken(item)) return;
  const tokenId = item.id;

  // Seed the working copy from the scene on the first click of a session, then
  // keep operating on it in memory to avoid read-after-write races.
  const chains = buildWorking ?? (await getChains());
  const existing = findChainForToken(chains, tokenId);

  // Clicking a token already in a chain re-anchors the build cursor there,
  // so the next clicks branch off it.
  if (existing) {
    buildWorking = chains;
    buildChainId = existing.id;
    buildLastNodeId = tokenId;
    await OBR.notification.show(`IK: continuing from this node`, "SUCCESS");
    return;
  }

  // No active chain (or the active one is gone): start a new chain here.
  if (!buildChainId || !chains[buildChainId]) {
    const [next, id] = createChain(chains, tokenId);
    buildWorking = next;
    buildChainId = id;
    buildLastNodeId = tokenId;
    await saveChains(next);
    await OBR.notification.show(`IK: set root token`, "SUCCESS");
    return;
  }

  // Link this token to the current build cursor.
  const parentId = buildLastNodeId ?? chains[buildChainId].rootId;
  const positions = await getPositions([tokenId, parentId]);
  const restLength =
    positions[tokenId] && positions[parentId]
      ? dist(positions[parentId], positions[tokenId])
      : 0;
  const next = addNode(chains, buildChainId, tokenId, parentId, restLength);
  buildWorking = next;
  buildLastNodeId = tokenId;
  await saveChains(next);
  await OBR.notification.show(`IK: linked token to chain`, "SUCCESS");
}

function onBuildDeactivate(): void {
  // Reset the build session so the next one re-seeds from the scene.
  buildWorking = null;
  buildChainId = null;
  buildLastNodeId = null;
}

// ---- Registration ----------------------------------------------------------

export async function setupTool(): Promise<void> {
  await OBR.tool.create({
    id: TOOL_ID,
    icons: [{ icon: "/icon.svg", label: "IK Chains" }],
    defaultMode: MODE_POSE,
  });

  await OBR.tool.createMode({
    id: MODE_POSE,
    icons: [{ icon: "/pose.svg", label: "Pose chain" }],
    onToolDragStart: onPoseDragStart,
    onToolDragMove: onPoseDragMove,
    onToolDragEnd: onPoseDragEnd,
    onToolDragCancel: onPoseDragCancel,
  });

  await OBR.tool.createMode({
    id: MODE_BUILD,
    icons: [{ icon: "/build.svg", label: "Build chain" }],
    onToolClick: onBuildClick,
    onDeactivate: onBuildDeactivate,
  });
}
