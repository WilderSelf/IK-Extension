/**
 * SEGMENT-RIG INVARIANTS — the rigid-follow guarantees, randomised. Reconstructed
 * joints must be locked to the tokens (no wander) under any rigid move; capture
 * ↔ reconstruct ↔ seat must round-trip; and solveSegmentJoints must preserve
 * every segment length and pin the shoulder for every grabbed token.
 */
import { describe, it, expect } from "vitest";
import type { Vec2 } from "../types";
import {
  captureSegData,
  deriveMidpointJoints,
  jointAngles,
  reconstructJoints,
  seatTokens,
  solveSegmentJoints,
} from "./segment";
import { dist } from "./vec";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const DEG = 180 / Math.PI;
const finite = (ps: Vec2[]) => ps.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

// A random (possibly bent) arm of `n` token centres, plus per-token rotations.
function randomArm(r: () => number, n: number): { centres: Vec2[]; rot: number[] } {
  const centres: Vec2[] = [{ x: (r() - 0.5) * 100, y: (r() - 0.5) * 100 }];
  let ang = r() * Math.PI * 2;
  for (let i = 1; i < n; i++) {
    ang += (r() - 0.5) * 1.5;
    const l = 8 + r() * 30;
    centres.push({ x: centres[i - 1].x + Math.cos(ang) * l, y: centres[i - 1].y + Math.sin(ang) * l });
  }
  const rot = centres.map(() => (r() - 0.5) * 720);
  return { centres, rot };
}

describe("segment reconstruct/seat round-trips", () => {
  const r = rng(0x5EED);
  it("reconstruct reproduces the captured joints at rest (random arms + custom pivots)", () => {
    for (let c = 0; c < 300; c++) {
      const n = 2 + Math.floor(r() * 5);
      const { centres, rot } = randomArm(r, n);
      const joints = deriveMidpointJoints(centres);
      // Optionally drag a random joint off-axis.
      if (r() < 0.5) joints[Math.floor(r() * joints.length)] = { x: (r() - 0.5) * 200, y: (r() - 0.5) * 200 };
      const seg = captureSegData(centres, rot, joints);
      const back = reconstructJoints(centres, rot, seg);
      back.forEach((j, i) => {
        expect(j.x).toBeCloseTo(joints[i].x, 6);
        expect(j.y).toBeCloseTo(joints[i].y, 6);
      });
    }
  });

  it("seatTokens(reconstruct(...)) reproduces the centres", () => {
    for (let c = 0; c < 300; c++) {
      const n = 2 + Math.floor(r() * 5);
      const { centres, rot } = randomArm(r, n);
      const joints = deriveMidpointJoints(centres);
      if (r() < 0.5) joints[Math.floor(r() * joints.length)] = { x: (r() - 0.5) * 200, y: (r() - 0.5) * 200 };
      const seg = captureSegData(centres, rot, joints);
      const seated = seatTokens(reconstructJoints(centres, rot, seg), seg);
      seated.forEach((c2, i) => {
        expect(c2.x).toBeCloseTo(centres[i].x, 6);
        expect(c2.y).toBeCloseTo(centres[i].y, 6);
      });
    }
  });

  it("NO WANDER: joints ride an arbitrary rigid transform of the whole rig", () => {
    for (let c = 0; c < 300; c++) {
      const n = 2 + Math.floor(r() * 5);
      const { centres, rot } = randomArm(r, n);
      const joints = deriveMidpointJoints(centres);
      if (r() < 0.5) joints[Math.floor(r() * joints.length)] = { x: (r() - 0.5) * 100, y: (r() - 0.5) * 100 };
      const seg = captureSegData(centres, rot, joints);

      const phi = (r() - 0.5) * Math.PI * 2;
      const T = { x: (r() - 0.5) * 400, y: (r() - 0.5) * 400 };
      const cos = Math.cos(phi), sin = Math.sin(phi);
      const R = (p: Vec2): Vec2 => ({ x: p.x * cos - p.y * sin + T.x, y: p.x * sin + p.y * cos + T.y });
      const movedCentres = centres.map(R);
      const movedRot = rot.map((d) => d + phi * DEG);

      const got = reconstructJoints(movedCentres, movedRot, seg);
      joints.forEach((j, i) => {
        const want = R(j);
        expect(got[i].x).toBeCloseTo(want.x, 4);
        expect(got[i].y).toBeCloseTo(want.y, 4);
      });
    }
  });
});

describe("solveSegmentJoints invariants", () => {
  const r = rng(0xBEEF);
  it("pins the shoulder and preserves every segment length for every grabbed token", () => {
    for (let c = 0; c < 300; c++) {
      const n = 2 + Math.floor(r() * 5);
      const { centres, rot } = randomArm(r, n);
      const seg = captureSegData(centres, rot, deriveMidpointJoints(centres));
      const rest = reconstructJoints(centres, rot, seg);
      const grab = 1 + Math.floor(r() * (n - 1)); // 1..n-1
      const target = { x: (r() - 0.5) * 400, y: (r() - 0.5) * 400 };
      const joints = solveSegmentJoints(centres, rot, seg, grab, target);
      // Shoulder pinned to its rest position.
      expect(joints[0].x).toBeCloseTo(rest[0].x, 4);
      expect(joints[0].y).toBeCloseTo(rest[0].y, 4);
      // All segment lengths preserved.
      for (let i = 0; i + 1 < joints.length; i++) {
        expect(dist(joints[i], joints[i + 1])).toBeCloseTo(seg[i].len, 3);
      }
      expect(joints.length).toBe(n + 1);
      expect(finite(joints)).toBe(true);
    }
  });

  it("grabbing the root (index 0) is a no-op relative to reconstruction", () => {
    for (let c = 0; c < 60; c++) {
      const n = 2 + Math.floor(r() * 4);
      const { centres, rot } = randomArm(r, n);
      const seg = captureSegData(centres, rot, deriveMidpointJoints(centres));
      const j = solveSegmentJoints(centres, rot, seg, 0, { x: 999, y: 999 });
      const ref = reconstructJoints(centres, rot, seg);
      j.forEach((p, i) => {
        expect(p.x).toBeCloseTo(ref[i].x, 9);
        expect(p.y).toBeCloseTo(ref[i].y, 9);
      });
    }
  });

  it("drives the grabbed token's distal joint onto a reachable target (tip grab)", () => {
    for (let c = 0; c < 60; c++) {
      const n = 3 + Math.floor(r() * 3);
      const { centres, rot } = randomArm(r, n);
      const seg = captureSegData(centres, rot, deriveMidpointJoints(centres));
      // Reachable target: near the shoulder.
      const shoulder = reconstructJoints(centres, rot, seg)[0];
      const target = { x: shoulder.x + (r() - 0.5) * 10, y: shoulder.y + (r() - 0.5) * 10 };
      const joints = solveSegmentJoints(centres, rot, seg, n - 1, target);
      expect(dist(joints[joints.length - 1], target)).toBeLessThan(2);
    }
  });
});

describe("jointAngles + degenerate segment cases", () => {
  it("n=1 gives a degenerate zero-length segment for solve & reconstruct", () => {
    const c = [{ x: 5, y: 9 }];
    const seg = captureSegData(c, [30], deriveMidpointJoints(c));
    expect(reconstructJoints(c, [30], seg)).toEqual([{ x: 5, y: 9 }, { x: 5, y: 9 }]);
    expect(solveSegmentJoints(c, [30], seg, 1, { x: 1, y: 1 })).toEqual([{ x: 5, y: 9 }, { x: 5, y: 9 }]);
  });

  it("coincident centres (zero-length arm) stay finite", () => {
    const c = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
    const seg = captureSegData(c, [0, 0, 0], deriveMidpointJoints(c));
    const j = solveSegmentJoints(c, [0, 0, 0], seg, 2, { x: 10, y: 10 });
    expect(j.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });

  it("jointAngles length is joints-1", () => {
    const c = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 5 }];
    const seg = captureSegData(c, [0, 0, 0], deriveMidpointJoints(c));
    expect(jointAngles(reconstructJoints(c, [0, 0, 0], seg)).length).toBe(c.length); // n joints-1 = n+1-1 = n
  });
});
