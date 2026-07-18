/**
 * On-canvas bend-limit picker. In the IK tool's "Limit bend" mode, clicking a
 * joint draws a circle around its parent (the pivot) with a filled wedge marking
 * the allowed bend range and two draggable handles at the extents. Dragging a
 * handle sets that end of the range; the value is persisted to the joint's
 * `constraint` on release.
 *
 * The angle frame matches the solver exactly (see ../ik/anglepicker): 0deg is
 * along the grandparent->parent reference bone, measured with the same `atan2`,
 * so the filled wedge is precisely the set of directions `fabrik` will allow.
 */
import OBR, {
  buildLine,
  buildPath,
  buildShape,
  Command,
  type Item,
  type PathCommand,
  type ToolContext,
  type ToolEvent,
} from "@owlbear-rodeo/sdk";
import type { Chain, Vec2 } from "../types";
import { PICKER_TAG } from "./constants";
import { findChainForToken, getChains, saveChains, setNodeConstraint } from "./chainStore";
import { getPositions } from "./scene";
import { anglePoint, arcPoints, bendAngleDeg } from "../ik/anglepicker";

const COLOR = "#f2b134"; // border + handles (amber, matches connectors)
const ALLOW = "#7bd88f"; // allowed-wedge fill (green)
const BONE = "#ffffff";
const DEFAULT_MIN = -90;
const DEFAULT_MAX = 90;
const HANDLE_DIAMETER = 22;

interface Active {
  chainId: string;
  nodeId: string; // the constrained node N (its incoming bone is limited)
  pivot: Vec2; // parent P — the joint the bone pivots around
  refRad: number; // reference bone angle, grandparent G -> parent P
  radius: number; // |P -> N|, so N sits on the circle
  bonePoint: Vec2; // N's position (end of the current bone)
  minDeg: number;
  maxDeg: number;
}

let active: Active | null = null;
let dragging: "min" | "max" | null = null;

/** Build the editable state for node `nodeId`, or null if it can't be limited. */
async function resolve(chain: Chain, nodeId: string): Promise<Active | null> {
  const node = chain.nodes[nodeId];
  if (!node || !node.parentId) return null; // root or detached
  const parent = chain.nodes[node.parentId];
  if (!parent || !parent.parentId) return null; // parent is the root: no reference bone
  const grandId = parent.parentId;
  const pos = await getPositions([nodeId, node.parentId, grandId]);
  const n = pos[nodeId];
  const p = pos[node.parentId];
  const g = pos[grandId];
  if (!n || !p || !g) return null;
  const c = node.constraint ?? { minDeg: DEFAULT_MIN, maxDeg: DEFAULT_MAX };
  return {
    chainId: chain.id,
    nodeId,
    pivot: p,
    refRad: Math.atan2(p.y - g.y, p.x - g.x),
    radius: Math.hypot(n.x - p.x, n.y - p.y) || 100,
    bonePoint: n,
    minDeg: c.minDeg,
    maxDeg: c.maxDeg,
  };
}

function dot(at: Vec2, diameter: number, fillOpacity: number): Item {
  return buildShape()
    .shapeType("CIRCLE")
    .width(diameter)
    .height(diameter)
    .position(at)
    .fillColor(COLOR)
    .fillOpacity(fillOpacity)
    .strokeColor(COLOR)
    .strokeWidth(2)
    .strokeOpacity(1)
    .layer("DRAWING")
    .locked(true)
    .disableHit(true)
    .metadata({ [PICKER_TAG]: true })
    .build();
}

function buildOverlay(a: Active): Item[] {
  const items: Item[] = [];

  // Whole-range ring: the blocked arc is shown by this border alone (no fill).
  items.push(
    buildShape()
      .shapeType("CIRCLE")
      .width(a.radius * 2)
      .height(a.radius * 2)
      .position(a.pivot)
      .fillOpacity(0)
      .strokeColor(COLOR)
      .strokeWidth(3)
      .strokeOpacity(0.5)
      .layer("DRAWING")
      .locked(true)
      .disableHit(true)
      .metadata({ [PICKER_TAG]: true })
      .build(),
  );

  // Allowed wedge: a filled sector from the pivot spanning [min, max].
  const commands: PathCommand[] = [[Command.MOVE, a.pivot.x, a.pivot.y]];
  for (const q of arcPoints(a.pivot, a.refRad, a.minDeg, a.maxDeg, a.radius)) {
    commands.push([Command.LINE, q.x, q.y]);
  }
  commands.push([Command.CLOSE]);
  items.push(
    buildPath()
      .commands(commands)
      .fillRule("nonzero")
      .fillColor(ALLOW)
      .fillOpacity(0.25)
      .strokeColor(ALLOW)
      .strokeWidth(2)
      .strokeOpacity(0.7)
      .layer("DRAWING")
      .locked(true)
      .disableHit(true)
      .metadata({ [PICKER_TAG]: true })
      .build(),
  );

  // Current bone P -> N, for reference.
  items.push(
    buildLine()
      .startPosition(a.pivot)
      .endPosition(a.bonePoint)
      .strokeColor(BONE)
      .strokeWidth(3)
      .strokeOpacity(0.85)
      .layer("DRAWING")
      .locked(true)
      .disableHit(true)
      .metadata({ [PICKER_TAG]: true })
      .build(),
  );

  // Min / max handles.
  items.push(dot(anglePoint(a.pivot, a.refRad, a.minDeg, a.radius), HANDLE_DIAMETER, 0.9));
  items.push(dot(anglePoint(a.pivot, a.refRad, a.maxDeg, a.radius), HANDLE_DIAMETER, 0.9));
  return items;
}

// Serialize redraws so rapid drag-moves don't interleave delete/add passes.
let redrawing = false;
let redrawPending = false;

async function redraw(): Promise<void> {
  if (redrawing) {
    redrawPending = true;
    return;
  }
  redrawing = true;
  try {
    // Overlay items are shared scene items; let the GM own them (like connectors).
    if ((await OBR.player.getRole()) !== "GM") return;
    await clearItems();
    if (active) await OBR.scene.items.addItems(buildOverlay(active));
  } finally {
    redrawing = false;
    if (redrawPending) {
      redrawPending = false;
      void redraw();
    }
  }
}

async function clearItems(): Promise<void> {
  const existing = await OBR.scene.items.getItems((i: Item) => i.metadata[PICKER_TAG] === true);
  if (existing.length) await OBR.scene.items.deleteItems(existing.map((i) => i.id));
}

async function pickNode(event: ToolEvent): Promise<boolean> {
  const targetId = event.target?.id;
  if (!targetId) return false;
  const chains = await getChains();
  const chain = findChainForToken(chains, targetId);
  if (!chain) return false;
  const a = await resolve(chain, targetId);
  if (!a) {
    await OBR.notification.show(
      "Pick a joint at least two bones out from the root to limit its bend.",
      "WARNING",
    );
    return false;
  }
  active = a;
  await redraw();
  return true;
}

// ---- Mode handlers ---------------------------------------------------------

export async function onConstrainClick(_ctx: ToolContext, event: ToolEvent): Promise<void> {
  await pickNode(event);
}

export async function onConstrainDragStart(_ctx: ToolContext, event: ToolEvent): Promise<void> {
  dragging = null;
  if (!active) {
    await pickNode(event);
    return;
  }
  const minP = anglePoint(active.pivot, active.refRad, active.minDeg, active.radius);
  const maxP = anglePoint(active.pivot, active.refRad, active.maxDeg, active.radius);
  const hit = Math.max(active.radius * 0.35, 40);
  const dMin = Math.hypot(event.pointerPosition.x - minP.x, event.pointerPosition.y - minP.y);
  const dMax = Math.hypot(event.pointerPosition.x - maxP.x, event.pointerPosition.y - maxP.y);
  if (dMin <= hit && dMin <= dMax) dragging = "min";
  else if (dMax <= hit) dragging = "max";
  else await pickNode(event); // started away from a handle: try selecting another joint
}

export function onConstrainDragMove(_ctx: ToolContext, event: ToolEvent): void {
  if (!active || !dragging) return;
  const deg = bendAngleDeg(active.pivot, active.refRad, event.pointerPosition);
  if (dragging === "min") active.minDeg = deg;
  else active.maxDeg = deg;
  void redraw();
}

export async function onConstrainDragEnd(_ctx: ToolContext, _event: ToolEvent): Promise<void> {
  const a = active;
  const which = dragging;
  dragging = null;
  if (!a || !which) return;
  if ((await OBR.player.getRole()) !== "GM") return;
  const chains = await getChains();
  if (chains[a.chainId]?.nodes[a.nodeId]) {
    const next = setNodeConstraint(chains, a.chainId, a.nodeId, {
      minDeg: Math.round(a.minDeg),
      maxDeg: Math.round(a.maxDeg),
    });
    await saveChains(next);
  }
  await redraw();
}

export function onConstrainDragCancel(): void {
  dragging = null;
  void redraw();
}

export async function onConstrainDeactivate(): Promise<void> {
  active = null;
  dragging = null;
  await clearItems();
}
