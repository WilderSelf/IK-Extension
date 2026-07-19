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
}

export interface ChainSettings {
  /** Rotate each token to face along its bone as the chain flexes. */
  autoRotate: boolean;
}

export interface Chain {
  id: string;
  /** Token item id of the pinned root. */
  rootId: string;
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
  return { autoRotate: true };
}
