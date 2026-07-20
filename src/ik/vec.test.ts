/** vec.ts unit + property tests: angle wrapping range, rotation inverses, dir fallbacks. */
import { describe, it, expect } from "vitest";
import { add, angle, dir, dist, len, rotateAround, scale, sub, wrapAngle } from "./vec";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("wrapAngle", () => {
  it("maps any angle into (-π, π]", () => {
    const r = rng(1);
    for (let i = 0; i < 5000; i++) {
      const a = (r() - 0.5) * 200; // huge range, both signs
      const w = wrapAngle(a);
      expect(w).toBeGreaterThan(-Math.PI - 1e-9);
      expect(w).toBeLessThanOrEqual(Math.PI + 1e-9);
      // Same direction: cos/sin agree with the original angle.
      expect(Math.cos(w)).toBeCloseTo(Math.cos(a), 9);
      expect(Math.sin(w)).toBeCloseTo(Math.sin(a), 9);
    }
  });

  it("is idempotent", () => {
    const r = rng(2);
    for (let i = 0; i < 1000; i++) {
      const a = (r() - 0.5) * 50;
      expect(wrapAngle(wrapAngle(a))).toBeCloseTo(wrapAngle(a), 12);
    }
  });

  it("handles the exact ±π boundaries within range", () => {
    expect(wrapAngle(Math.PI)).toBeGreaterThan(-Math.PI - 1e-9);
    expect(wrapAngle(Math.PI)).toBeLessThanOrEqual(Math.PI + 1e-9);
    expect(wrapAngle(-Math.PI)).toBeGreaterThan(-Math.PI - 1e-9);
    expect(wrapAngle(-Math.PI)).toBeLessThanOrEqual(Math.PI + 1e-9);
  });
});

describe("rotateAround", () => {
  const r = rng(3);
  it("rotating by 0 is the identity", () => {
    for (let i = 0; i < 200; i++) {
      const p = { x: (r() - 0.5) * 100, y: (r() - 0.5) * 100 };
      const piv = { x: (r() - 0.5) * 100, y: (r() - 0.5) * 100 };
      const out = rotateAround(p, piv, 0);
      expect(out.x).toBeCloseTo(p.x, 9);
      expect(out.y).toBeCloseTo(p.y, 9);
    }
  });

  it("rotating by θ then −θ returns to start", () => {
    for (let i = 0; i < 200; i++) {
      const p = { x: (r() - 0.5) * 100, y: (r() - 0.5) * 100 };
      const piv = { x: (r() - 0.5) * 100, y: (r() - 0.5) * 100 };
      const t = (r() - 0.5) * 10;
      const back = rotateAround(rotateAround(p, piv, t), piv, -t);
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });

  it("preserves distance from the pivot", () => {
    for (let i = 0; i < 200; i++) {
      const p = { x: (r() - 0.5) * 100, y: (r() - 0.5) * 100 };
      const piv = { x: (r() - 0.5) * 100, y: (r() - 0.5) * 100 };
      const t = (r() - 0.5) * 10;
      expect(dist(rotateAround(p, piv, t), piv)).toBeCloseTo(dist(p, piv), 6);
    }
  });

  it("the pivot itself is a fixed point", () => {
    const piv = { x: 3, y: -7 };
    expect(rotateAround(piv, piv, 1.23)).toEqual({ x: 3, y: -7 });
  });
});

describe("dir / angle", () => {
  it("falls back to (1,0) for coincident points", () => {
    expect(dir({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 1, y: 0 });
    // Sub-threshold separation also falls back.
    expect(dir({ x: 0, y: 0 }, { x: 1e-12, y: 0 })).toEqual({ x: 1, y: 0 });
  });

  it("returns a unit vector for separated points", () => {
    const r = rng(4);
    for (let i = 0; i < 500; i++) {
      const a = { x: (r() - 0.5) * 100, y: (r() - 0.5) * 100 };
      const b = { x: (r() - 0.5) * 100, y: (r() - 0.5) * 100 };
      if (dist(a, b) < 1e-6) continue;
      expect(len(dir(a, b))).toBeCloseTo(1, 9);
      // dir points along angle(a,b).
      const d = dir(a, b);
      expect(Math.atan2(d.y, d.x)).toBeCloseTo(angle(a, b), 9);
    }
  });

  it("angle is antisymmetric up to π", () => {
    const a = { x: 1, y: 2 };
    const b = { x: 4, y: 8 };
    expect(wrapAngle(angle(a, b) - (angle(b, a) + Math.PI))).toBeCloseTo(0, 9);
  });
});

describe("add / sub / scale / len / dist basics", () => {
  it("sub then add is identity", () => {
    const a = { x: 3, y: 4 }, b = { x: -1, y: 9 };
    expect(add(sub(a, b), b)).toEqual(a);
  });
  it("scale by 0 is the origin, by 1 is identity, by -1 negates", () => {
    const a = { x: 3, y: -4 };
    const z = scale(a, 0); // (3*0, -4*0) — component values are ±0, both === 0
    expect(z.x === 0 && z.y === 0).toBe(true);
    expect(scale(a, 1)).toEqual(a);
    expect(scale(a, -1)).toEqual({ x: -3, y: 4 });
  });
  it("len is the 3-4-5 hypotenuse; dist is symmetric", () => {
    expect(len({ x: 3, y: 4 })).toBeCloseTo(5, 12);
    expect(dist({ x: 1, y: 1 }, { x: 4, y: 5 })).toBeCloseTo(dist({ x: 4, y: 5 }, { x: 1, y: 1 }), 12);
  });
});
