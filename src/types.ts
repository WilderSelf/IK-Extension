/**
 * Shared types for the IK Chains extension.
 *
 * These are intentionally free of any Owlbear SDK imports so the pure solver
 * (src/ik/*) can be unit-tested without a browser or the OBR runtime.
 */

/** A 2D point in scene units. Matches the shape of OBR's Vector2. */
export interface Vec2 {
  x: number;
  y: number;
}

/** Per-node override flags (currently permission related). */
export interface NodeOverride {
  /** Whether non-GM players may grab/pose this node. Defaults to chain setting. */
  playerMovable?: boolean;
  /** Whether this node is pinned and cannot be grabbed at all. */
  locked?: boolean;
}

/**
 * Optional per-joint angle limit. Constrains the bend of a node's incoming bone
 * (parent -> this node) relative to its parent's incoming bone (grandparent ->
 * parent), in degrees. `minDeg <= maxDeg`, both within [-180, 180]; the two
 * signs are the two bend directions (which is which depends on token layout, so
 * tune by eye). A range like -160..0 gives a knee that only bends one way.
 *
 * Requires a grandparent as the reference bone, so it has no effect on the first
 * node off the root (or off a locked sub-base pin during a solve).
 */
export interface JointConstraint {
  minDeg: number;
  maxDeg: number;
}

export interface ChainNode {
  /** Parent token id, or null for the root. */
  parentId: string | null;
  /** Fixed rest distance to the parent, captured at build time. 0 for root. */
  restLength: number;
  /** Optional bend limit for this node's bone relative to its parent's bone. */
  constraint?: JointConstraint;
}

export interface ChainSettings {
  /** Rotate each token to face along its bone as the chain flexes. */
  autoRotate: boolean;
  /**
   * Degrees added when converting a bone angle to an OBR rotation. Tokens
   * conventionally point "up", so the default is 90. Tune per art if a token's
   * "forward" is not up.
   */
  rotationOffsetDeg: number;
  /** Draw connector lines between linked tokens. */
  showConnectors: boolean;
  /** Whether non-GM players may pose this chain at all. */
  playerPosable: boolean;
  /** Per-node overrides keyed by token id. */
  nodeOverrides?: Record<string, NodeOverride>;
}

export interface Chain {
  id: string;
  /** Token item id of the pinned root. */
  rootId: string;
  /** All nodes, including the root, keyed by token item id. */
  nodes: Record<string, ChainNode>;
  settings: ChainSettings;
}

/** Map of chainId -> Chain, as stored in scene metadata. */
export type ChainMap = Record<string, Chain>;

export const METADATA_KEY = "rodeo.wilder.ik/chains";
/** Lightweight membership marker stamped onto each token's item metadata. */
export const ITEM_MARKER_KEY = "rodeo.wilder.ik/member";

export const DEFAULT_ROTATION_OFFSET_DEG = 90;

export function defaultSettings(): ChainSettings {
  return {
    autoRotate: true,
    rotationOffsetDeg: DEFAULT_ROTATION_OFFSET_DEG,
    showConnectors: false,
    playerPosable: false,
    nodeOverrides: {},
  };
}
