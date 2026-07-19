/**
 * Shared types for the IK Chains extension.
 *
 * Deliberately free of any Owlbear SDK imports so the pure solver (src/ik/*)
 * and chain model (src/model/*) can be unit-tested without a browser or the
 * OBR runtime.
 */

/** A 2D point in scene units. Matches the shape of OBR's Vector2. */
export interface Vec2 {
  x: number;
  y: number;
}

/**
 * How much a bone resists bending as the chain is posed, on a 5-point scale. A
 * *relative* setting: a stiffer joint keeps its angle so the reach demand is
 * absorbed by the looser joints around it (stiff base, floppy tip). `normal` is
 * the neutral midpoint and reproduces plain FABRIK exactly; toward `stiff` damps
 * the joint's turn, toward `loose` sheds bend more eagerly than its neighbours.
 * Resistance, not a lock — drag far enough and a stiff joint still gives.
 * `loose`/`normal`/`stiff` are the low/mid/high stops that earlier versions
 * stored, so old scene data stays valid. See `STIFFNESS_RETENTION`.
 */
export type Stiffness = "loose" | "soft" | "normal" | "firm" | "stiff";

/** The five stiffness stops, loosest → stiffest — the slider's 0…4 positions. */
export const STIFFNESS_ORDER: Stiffness[] = ["loose", "soft", "normal", "firm", "stiff"];

/** Human labels for each stop (tooltip / aria-valuetext); numberless by design. */
export const STIFFNESS_LABELS: Record<Stiffness, string> = {
  loose: "Loose",
  soft: "Soft",
  normal: "Normal",
  firm: "Firm",
  stiff: "Stiff",
};

/**
 * Per-bone relaxation *retention* fed to the solver, keyed by `Stiffness`. In
 * the forward pass a joint's turn toward its ideal angle is scaled by
 * `(1 - retention)`, so 0 = move fully (plain FABRIK), positive = damped
 * (stiff), negative = mild over-relaxation (loose sheds bend faster). All values
 * keep the relaxation factor `(1 - retention)` inside the stable (0, 2) range.
 * `normal` is exactly 0 so a chain of all-normal joints is byte-identical to the
 * unweighted solver. `soft`/`firm` fill the gaps between the original three
 * stops so the ramp reads smoothly (the normal→stiff step used to feel abrupt).
 */
export const STIFFNESS_RETENTION: Record<Stiffness, number> = {
  loose: -0.4,
  soft: -0.2,
  normal: 0,
  firm: 0.35,
  stiff: 0.7,
};

/**
 * A captured bend limit for one joint: the signed relative-bend interval (in
 * radians, wrapped to (-π, π]) the joint is allowed to occupy, measured the same
 * way the solver measures a bend — the outgoing bone's angle minus the incoming
 * bone's. Populated only by "capture from pose", never typed as a number.
 */
export interface BendLimit {
  min: number;
  max: number;
}

export interface ChainNode {
  /** Parent token id, or null for the root. */
  parentId: string | null;
  /** Fixed rest distance to the parent, captured at build time. 0 for the root. */
  restLength: number;
  /**
   * The token's authored rotation *relative to its incoming bone* (token
   * rotation minus the parent->node bone angle, in degrees), captured at build
   * time. With auto-rotate on, the token is re-rotated to
   * `boneAngleNow + boneOffsetDeg` as the chain flexes, so its art keeps the
   * orientation you gave it instead of snapping to a fixed default. Undefined on
   * the root (the root is never re-rotated).
   */
  boneOffsetDeg?: number;
  /**
   * How much this node's incoming bone resists bending. Overrides the chain's
   * `defaultStiffness`; undefined means "inherit the chain default". Meaningless
   * on the root (no incoming bone), so left unset there.
   */
  stiffness?: Stiffness;
  /**
   * Hard bend limit for this joint, captured by posing. Applies only where the
   * joint has a reference bone above it — the root and the first movable node
   * (no incoming bone to measure against) never carry one. Undefined = free.
   */
  limit?: BendLimit;
  /**
   * Optional display name shown in the popover (e.g. "Knee"). Cosmetic;
   * undefined falls back to the token's scene name. Does not rename the Owlbear
   * item.
   */
  name?: string;
  /**
   * Rigid-segment data for a segment rig (`ChainSettings.segmentRig`). Captured
   * from the rest pose when limb mode is turned on: `len` is the token's segment
   * length (joint→joint); `seatAlong`/`seatPerp` place its centre within the
   * segment's frame (along the segment, and perpendicular to it, as fractions of
   * the segment length) so a custom pivot doesn't drag the token off its art; and
   * `offsetDeg` is its authored rotation relative to the segment direction (the
   * segment-model analogue of `boneOffsetDeg`). Unset when not a segment rig.
   */
  seg?: { len: number; seatAlong: number; seatPerp: number; offsetDeg: number };
}

export interface ChainSettings {
  /** Rotate each token to face along its bone as the chain flexes. */
  autoRotate: boolean;
  /**
   * Fallback bend-resistance for every node that lacks its own `stiffness`.
   * Optional so chains persisted before this setting existed resolve to
   * `normal` (plain FABRIK) rather than needing a data migration.
   */
  defaultStiffness?: Stiffness;
  /**
   * When true, ignore `defaultStiffness` and ramp stiffness by position instead
   * — stiff at the base, easing to loose at the tip — for a natural tail/tentacle
   * fall-off. A node's own `stiffness` override still wins over the ramp.
   */
  ease?: boolean;
  /**
   * Limb mode: treat the tokens as rigid SEGMENTS spanning joints, so each pivots
   * at its joint (the shoulder/elbow/wrist) instead of its own centre. Off by
   * default — the centre-based rig is correct for ropes/tails/tentacles (a blob
   * at each point), so this is opt-in per chain. Turning it on captures each
   * node's `seg` data from the current pose.
   */
  segmentRig?: boolean;
}

/**
 * Distinct highlight colours auto-assigned to new chains (cycled, preferring an
 * unused one) so each chain reads differently on the canvas. The swatch picker
 * also offers a free-form custom colour.
 */
export const CHAIN_PALETTE: string[] = [
  "#ef4444", "#3b82f6", "#22c55e", "#f59e0b",
  "#a855f7", "#ec4899", "#06b6d4", "#f97316",
  "#84cc16", "#14b8a6", "#eab308", "#8b5cf6",
];

export interface Chain {
  id: string;
  /** Token item id of the pinned root. */
  rootId: string;
  /**
   * Optional display name shown in the popover (e.g. "Leg"). Cosmetic; undefined
   * falls back to the root token's scene name. Does not rename the Owlbear item.
   */
  name?: string;
  /**
   * Highlight colour (hex) for this chain — used for the on-canvas highlight when
   * the chain is picked in the popover, and shown as the header swatch. Assigned
   * from `CHAIN_PALETTE` at build time; undefined on chains built before colours
   * existed (they fall back to a neutral swatch until set).
   */
  color?: string;
  /**
   * All nodes, including the root, keyed by token item id. A chain is a single
   * LINEAR strand: every non-root node has exactly one parent and each node has
   * at most one child (no branching).
   */
  nodes: Record<string, ChainNode>;
  settings: ChainSettings;
  /**
   * Optional link: the token id of a node in ANOTHER chain that this chain
   * "follows". When that node moves (its owning chain is posed or translated),
   * this whole chain is carried rigidly by the node's transform, so a sub-rig
   * (e.g. a crab's pincher) rides along with its parent. The link is directional
   * — posing this chain never moves the parent. Undefined = independent.
   */
  parentNodeId?: string;
}

/** Map of chainId -> Chain, as stored in scene metadata. */
export type ChainMap = Record<string, Chain>;

export const METADATA_KEY = "rodeo.wilder.ik/chains";

/**
 * Fallback rotation offset (degrees) for a node that somehow lacks a captured
 * `boneOffsetDeg`. Tokens conventionally point "up", so 90 maps a bone angle to
 * an OBR rotation. In practice every built node captures its own offset, so this
 * is only a defensive default.
 */
export const DEFAULT_ROTATION_OFFSET_DEG = 90;

export function defaultSettings(): ChainSettings {
  return { autoRotate: true, defaultStiffness: "normal" };
}
