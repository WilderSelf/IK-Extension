import type { Chain, ChainNode } from "../types";

/**
 * Build a parent -> children adjacency map in a single O(n) pass.
 *
 * Traversals that touch every node (orderedNodes, subtree) use this so they run
 * in O(n) instead of O(n^2): calling childrenOf per node re-scans the whole node
 * table each time, which turns a 1000-node chain into a million-entry sweep on
 * every drag frame and sidebar render.
 */
export function childrenMap(chain: Chain): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [id, node] of Object.entries(chain.nodes)) {
    if (node.parentId === null) continue;
    const arr = map.get(node.parentId);
    if (arr) arr.push(id);
    else map.set(node.parentId, [id]);
  }
  return map;
}

/**
 * Nodes in depth-first order from the root, each with its depth.
 *
 * Iterative (not recursive) so a deep linear chain cannot overflow the stack,
 * and guarded against cycles in case the persisted metadata is corrupted.
 */
export function orderedNodes(chain: Chain): { id: string; depth: number }[] {
  if (!(chain.rootId in chain.nodes)) return [];
  const kids = childrenMap(chain);
  const out: { id: string; depth: number }[] = [];
  const seen = new Set<string>();
  const stack: { id: string; depth: number }[] = [{ id: chain.rootId, depth: 0 }];
  while (stack.length) {
    const { id, depth } = stack.pop()!;
    if (seen.has(id) || !(id in chain.nodes)) continue;
    seen.add(id);
    out.push({ id, depth });
    const ch = kids.get(id);
    if (ch) {
      // Push in reverse so the first child is processed first (stable order).
      for (let i = ch.length - 1; i >= 0; i--) stack.push({ id: ch[i], depth: depth + 1 });
    }
  }
  return out;
}

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
  const kids = childrenMap(chain);
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [...(kids.get(nodeId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue; // cycle guard for corrupted metadata
    seen.add(id);
    out.push(id);
    const ch = kids.get(id);
    if (ch) for (const c of ch) stack.push(c);
  }
  return out;
}

/**
 * Deepest node that is an ancestor of (or equal to) both `a` and `b`. Returns
 * the chain root in the normal case, or null if the two aren't connected (should
 * not happen within one chain). Used to detect forks where two grabbed tips
 * share an intermediate joint.
 */
export function lowestCommonAncestor(chain: Chain, a: string, b: string): string | null {
  const inB = new Set(branchPath(chain, b));
  let lca: string | null = null;
  // branchPath(a) is ordered root -> a, so the last shared id is the deepest.
  for (const id of branchPath(chain, a)) {
    if (inB.has(id)) lca = id;
  }
  return lca;
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
