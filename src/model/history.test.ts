import { describe, expect, it } from "vitest";
import { canRedo, canUndo, initHistory, record, redo, undo } from "./history";

describe("history (undo/redo)", () => {
  it("starts empty with no undo/redo available", () => {
    const h = initHistory(0);
    expect(h.present).toBe(0);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  it("records changes and steps back and forward", () => {
    let h = initHistory(0);
    h = record(h, 1);
    h = record(h, 2);
    expect(h.present).toBe(2);
    expect(canUndo(h)).toBe(true);

    h = undo(h);
    expect(h.present).toBe(1);
    h = undo(h);
    expect(h.present).toBe(0);
    expect(canUndo(h)).toBe(false);

    h = redo(h);
    expect(h.present).toBe(1);
    h = redo(h);
    expect(h.present).toBe(2);
    expect(canRedo(h)).toBe(false);
  });

  it("recording after an undo forks the timeline (clears redo)", () => {
    let h = initHistory(0);
    h = record(h, 1);
    h = record(h, 2);
    h = undo(h); // present 1, future [2]
    expect(canRedo(h)).toBe(true);
    h = record(h, 9); // new branch
    expect(h.present).toBe(9);
    expect(canRedo(h)).toBe(false);
    h = undo(h);
    expect(h.present).toBe(1);
  });

  it("ignores a no-op record (present unchanged) using eq", () => {
    let h = initHistory({ v: 1 });
    const eq = (a: { v: number }, b: { v: number }) => a.v === b.v;
    const before = h;
    h = record(h, { v: 1 }, eq); // equal by value -> unchanged
    expect(h).toBe(before);
    expect(canUndo(h)).toBe(false);
    h = record(h, { v: 2 }, eq);
    expect(canUndo(h)).toBe(true);
  });

  it("trims the past to the limit", () => {
    let h = initHistory(0);
    for (let i = 1; i <= 10; i++) h = record(h, i, Object.is, 3);
    // present 10, past holds at most 3 prior states (7,8,9)
    expect(h.present).toBe(10);
    expect(h.past).toEqual([7, 8, 9]);
  });

  it("undo/redo are no-ops at the ends", () => {
    const h = initHistory(5);
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });
});
