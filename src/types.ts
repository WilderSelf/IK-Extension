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

export interface ChainNode {
  /** Parent token id, or null for the root. */
  parentId: string | null;
  /** Fixed rest distance to the parent, captured at build time. 0 for root. */
  restLength: number;
}

export interface ChainSettings {
  /** Rotate each token to face along its bone as the chain flexes. */
  autoRotate: boolean;
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

export function defaultSettings(): ChainSettings {
  return {
    autoRotate: true,
    showConnectors: false,
    playerPosable: false,
    nodeOverrides: {},
  };
}
