import { describe, expect, it } from "vitest";
import { anglePoint, arcPoints, bendAngleDeg, wrapDeg180 } from "./anglepicker";

describe("angle picker geometry", () => {
  it("wrapDeg180 folds into (-180, 180]", () => {
    expect(wrapDeg180(0)).toBe(0);
    expect(wrapDeg180(190)).toBe(-170);
    expect(wrapDeg180(-190)).toBe(170);
    expect(wrapDeg180(360)).toBe(0);
    expect(wrapDeg180(540)).toBe(180); // +180 stays +180, not -180
  });

  it("bendAngleDeg measures the pointer relative to the reference bone", () => {
    const pivot = { x: 0, y: 0 };
    // Reference pointing along +x (0 rad). A pointer due +y is +90deg.
    expect(bendAngleDeg(pivot, 0, { x: 0, y: 10 })).toBeCloseTo(90, 5);
    expect(bendAngleDeg(pivot, 0, { x: 10, y: 0 })).toBeCloseTo(0, 5);
    expect(bendAngleDeg(pivot, 0, { x: 0, y: -10 })).toBeCloseTo(-90, 5);
    // Rotate the reference to +y (pi/2): a pointer along +x now reads -90deg.
    expect(bendAngleDeg(pivot, Math.PI / 2, { x: 10, y: 0 })).toBeCloseTo(-90, 5);
  });

  it("anglePoint lands on the circle at the given offset", () => {
    const p = anglePoint({ x: 0, y: 0 }, 0, 90, 10);
    expect(p.x).toBeCloseTo(0, 5);
    expect(p.y).toBeCloseTo(10, 5);
  });

  it("arcPoints spans the allowed range endpoints and is order-agnostic", () => {
    const pivot = { x: 0, y: 0 };
    const a = arcPoints(pivot, 0, -90, 0, 10);
    // First point at -90deg (due -y), last at 0deg (due +x).
    expect(a[0].y).toBeCloseTo(-10, 5);
    expect(a[a.length - 1].x).toBeCloseTo(10, 5);
    // Reversed bounds trace the same interval.
    const b = arcPoints(pivot, 0, 0, -90, 10);
    expect(b[0].y).toBeCloseTo(-10, 5);
    expect(b[b.length - 1].x).toBeCloseTo(10, 5);
    // Every point sits on the radius-10 circle.
    for (const q of a) expect(Math.hypot(q.x, q.y)).toBeCloseTo(10, 5);
  });
});
