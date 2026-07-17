/**
 * A tiny undo/redo history — a past/present/future zipper. Pure and generic, so
 * it's fully unit-testable; the sidebar drives it over chain-map snapshots.
 */
export interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

export const DEFAULT_LIMIT = 50;

export function initHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

/**
 * Record a new present. Clears the redo stack (a new edit forks the timeline)
 * and trims the past to `limit` entries. If `next` equals the current present
 * (per `eq`, default `Object.is`) the history is returned unchanged — so echoing
 * our own writes back in doesn't create a bogus entry.
 */
export function record<T>(
  h: History<T>,
  next: T,
  eq: (a: T, b: T) => boolean = Object.is,
  limit: number = DEFAULT_LIMIT,
): History<T> {
  if (eq(next, h.present)) return h;
  const past = [...h.past, h.present];
  while (past.length > limit) past.shift();
  return { past, present: next, future: [] };
}

export const canUndo = <T>(h: History<T>): boolean => h.past.length > 0;
export const canRedo = <T>(h: History<T>): boolean => h.future.length > 0;

/** Step back one entry (no-op if there's nothing to undo). */
export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  const past = [...h.past];
  const present = past.pop()!;
  return { past, present, future: [h.present, ...h.future] };
}

/** Step forward one entry (no-op if there's nothing to redo). */
export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  const [present, ...future] = h.future;
  return { past: [...h.past, h.present], present, future };
}
