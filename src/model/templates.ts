/**
 * Chain templates / presets. A template captures a chain's *shape* — its
 * topology, rest lengths, per-joint constraints, and settings — detached from
 * the specific token ids it was built on, so the same rig can be re-applied to
 * another set of tokens (copy-paste a rig between creatures).
 *
 * Pure: no Owlbear SDK imports, fully unit-testable. `chainStore.ts` re-exports
 * these alongside its scene-metadata persistence.
 */
import type {
  Chain,
  ChainMap,
  ChainSettings,
  JointConstraint,
  NodeOverride,
} from "../types";
import { orderedNodes } from "../ik/tree";
import {
  addNode,
  createChain,
  setNodeConstraint,
  setNodeOverride,
  updateSettings,
} from "./chains";

/** One node of a template. `parent` indexes into the template's `nodes` array. */
export interface TemplateNode {
  /** Index of this node's parent in `nodes`; null for the root (always index 0). */
  parent: number | null;
  restLength: number;
  constraint?: JointConstraint;
  override?: NodeOverride;
}

export interface ChainTemplate {
  /** Nodes in depth-first order, root first — so a parent always precedes its children. */
  nodes: TemplateNode[];
  /** Chain-level settings. Per-node overrides live on each `TemplateNode` instead. */
  settings: Omit<ChainSettings, "nodeOverrides">;
}

/** Named templates, as stored in scene metadata. */
export type TemplateMap = Record<string, ChainTemplate>;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Capture a chain as a reusable, token-agnostic template. */
export function toTemplate(chain: Chain): ChainTemplate {
  const order = orderedNodes(chain); // root first, DFS; every node's parent precedes it
  const indexOf = new Map(order.map((n, i) => [n.id, i]));
  const overrides = chain.settings.nodeOverrides ?? {};

  const nodes: TemplateNode[] = order.map(({ id }) => {
    const node = chain.nodes[id];
    const parentId = node.parentId;
    const tn: TemplateNode = {
      parent: parentId === null ? null : indexOf.get(parentId) ?? null,
      restLength: node.restLength,
    };
    if (node.constraint) tn.constraint = clone(node.constraint);
    const ov = overrides[id];
    if (ov && Object.keys(ov).length > 0) tn.override = clone(ov);
    return tn;
  });

  const { nodeOverrides: _drop, ...settings } = chain.settings;
  return { nodes, settings: clone(settings) };
}

/**
 * Instantiate a template onto `tokenIds`, adding the new chain to `into`.
 * `tokenIds[i]` becomes the token for template node `i`, so `tokenIds[0]` is the
 * root. Returns `[map, chainId]`, or `null` if the token list doesn't match the
 * template (wrong count, empty, or duplicate ids).
 */
export function instantiateTemplate(
  template: ChainTemplate,
  tokenIds: string[],
  into: ChainMap = {},
): [ChainMap, string] | null {
  if (
    tokenIds.length === 0 ||
    tokenIds.length !== template.nodes.length ||
    new Set(tokenIds).size !== tokenIds.length
  ) {
    return null;
  }

  let [map, chainId] = createChain(into, tokenIds[0]);
  map = updateSettings(map, chainId, template.settings);

  // Parents precede children in template order, so a single forward pass links safely.
  for (let i = 1; i < template.nodes.length; i++) {
    const tn = template.nodes[i];
    const parentIdx = tn.parent ?? 0;
    map = addNode(map, chainId, tokenIds[i], tokenIds[parentIdx], tn.restLength);
  }

  // Per-node constraints and overrides (including the root's own override).
  template.nodes.forEach((tn, i) => {
    if (tn.constraint) map = setNodeConstraint(map, chainId, tokenIds[i], tn.constraint);
    if (tn.override && Object.keys(tn.override).length > 0) {
      map = setNodeOverride(map, chainId, tokenIds[i], tn.override);
    }
  });

  return [map, chainId];
}

/** Store a named template (overwrites any existing one with the same name). */
export function saveTemplate(
  map: TemplateMap,
  name: string,
  template: ChainTemplate,
): TemplateMap {
  return { ...clone(map), [name]: clone(template) };
}

/** Remove a named template. */
export function deleteTemplate(map: TemplateMap, name: string): TemplateMap {
  const next = clone(map);
  delete next[name];
  return next;
}
