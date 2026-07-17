import type { Chain, ChainNode } from "../types";

/** Direct children of a node (token ids whose parentId === nodeId). */
export function childrenOf(chain: Chain, nodeId: string): string[] {
  const out: string[] = [];
  for (const [id, node] of Object.entries(chain.nodes)) {
    if (node.parentId === nodeId) out.push(id);
  }
  return out;
}

/** Ordered path of token ids from the root down to `nodeId` (inclusive). */
export function branchPath(chain: Chain, nodeId: string): string[] {
  const path: string[] = [];
  let cur: string | null = nodeId;
  const guard = new Set<string>();
  while (cur) {
    if (guard.has(cur)) break; // cycle safety
    guard.add(cur);
    path.push(cur);
    const node: ChainNode | undefined = chain.nodes[cur];
    cur = node ? node.parentId : null;
  }
  return path.reverse();
}

/** All descendants of `nodeId` (excluding it), i.e. the nodes "beyond" it. */
export function subtree(chain: Chain, nodeId: string): string[] {
  const out: string[] = [];
  const stack = [...childrenOf(chain, nodeId)];
  while (stack.length) {
    const id = stack.pop()!;
    out.push(id);
    stack.push(...childrenOf(chain, id));
  }
  return out;
}

/** True if `ancestorId` is a strict ancestor of `nodeId`. */
export function isAncestor(chain: Chain, ancestorId: string, nodeId: string): boolean {
  let cur = chain.nodes[nodeId]?.parentId ?? null;
  const guard = new Set<string>();
  while (cur) {
    if (cur === ancestorId) return true;
    if (guard.has(cur)) break;
    guard.add(cur);
    cur = chain.nodes[cur]?.parentId ?? null;
  }
  return false;
}

/**
 * Given a set of selected token ids, return the ones that are the "shallowest
 * selected" on their path from the root — a selected node none of whose
 * ancestors are also selected. These become the IK targets; deeper selected
 * nodes are carried rigidly by their shallowest selected ancestor.
 *
 * The root is never returned here (root drags are handled as a rigid translate).
 */
export function shallowestSelectedPerBranch(chain: Chain, selectedIds: string[]): string[] {
  // The root is the pinned pivot; a selected root is handled separately as a
  // rigid translate and must never gate its descendants here.
  const selected = new Set(
    selectedIds.filter((id) => id in chain.nodes && id !== chain.rootId),
  );
  const result: string[] = [];
  for (const id of selected) {
    let ancestorSelected = false;
    let cur = chain.nodes[id]?.parentId ?? null;
    const guard = new Set<string>();
    while (cur) {
      if (selected.has(cur)) {
        ancestorSelected = true;
        break;
      }
      if (guard.has(cur)) break;
      guard.add(cur);
      cur = chain.nodes[cur]?.parentId ?? null;
    }
    if (!ancestorSelected) result.push(id);
  }
  return result;
}
