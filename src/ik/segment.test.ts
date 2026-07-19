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

const v = (x: number, y: number): Vec2 => ({ x, y });

// A straight horizontal arm: three equal segments, centres 10 apart.
const arm = (): Vec2[] => [v(0, 0), v(10, 0), v(20, 0)];
const flat = (n: number): number[] => Array.from({ length: n }, () => 0);

describe("deriveMidpointJoints", () => {
  it("puts interior joints at midpoints and reflects the ends outward", () => {
    // centres 0,10,20 → mids 5,15 → ends -5 and 25.
    expect(deriveMidpointJoints(arm()).map((p) => p.x)).toEqual([-5, 5, 15, 25]);
  });

  it("returns a degenerate segment for a lone root", () => {
    expect(deriveMidpointJoints([v(3, 4)])).toEqual([v(3, 4), v(3, 4)]);
  });
});

describe("captureSegData", () => {
  it("captures equal lengths and centred seats for an even arm", () => {
    const seg = captureSegData(arm(), flat(3), deriveMidpointJoints(arm()));
    expect(seg.map((s) => s.len)).toEqual([10, 10, 10]);
    for (const s of seg) {
      expect(s.seatAlong).toBeCloseTo(0.5, 9);
      expect(s.seatPerp).toBeCloseTo(0, 9);
      expect(s.offsetDeg).toBeCloseTo(0, 9);
    }
  });
});

describe("reconstructJoints", () => {
  it("round-trips: reconstructing from captured seg reproduces the rest joints", () => {
    const centres = arm();
    const joints = deriveMidpointJoints(centres);
    const seg = captureSegData(centres, flat(3), joints);
    reconstructJoints(centres, flat(3), seg).forEach((j, i) => {
      expect(j.x).toBeCloseTo(joints[i].x, 9);
      expect(j.y).toBeCloseTo(joints[i].y, 9);
    });
  });

  it("seatTokens round-trips the centres from the captured joints", () => {
    const centres = arm();
    const seg = captureSegData(centres, flat(3), deriveMidpointJoints(centres));
    seatTokens(deriveMidpointJoints(centres), seg).forEach((c, i) => {
      expect(c.x).toBeCloseTo(centres[i].x, 9);
      expect(c.y).toBeCloseTo(centres[i].y, 9);
    });
  });

  it("NO WANDER: joints follow a rigid move of the whole rig exactly", () => {
    // Capture at rest, then rigidly rotate + translate every token (centres AND
    // rotations). The reconstructed joints must be the rest joints under the SAME
    // rigid transform — i.e. locked to the rig, not drifting.
    const centres = arm();
    const restJoints = deriveMidpointJoints(centres);
    const seg = captureSegData(centres, flat(3), restJoints);

    const phi = 0.7; // radians
    const T = v(37, -12);
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const R = (p: Vec2): Vec2 => v(p.x * c - p.y * s + T.x, p.x * s + p.y * c + T.y);
    const movedCentres = centres.map(R);
    const movedRot = flat(3).map((r) => r + (phi * 180) / Math.PI); // each token turned by phi

    const got = reconstructJoints(movedCentres, movedRot, seg);
    restJoints.forEach((j, i) => {
      const want = R(j);
      expect(got[i].x).toBeCloseTo(want.x, 6);
      expect(got[i].y).toBeCloseTo(want.y, 6);
    });
  });

  it("a custom (dragged) joint also follows a rigid move", () => {
    const centres = arm();
    const joints = deriveMidpointJoints(centres);
    joints[0] = v(-3, 4); // drag the shoulder off-axis
    const seg = captureSegData(centres, flat(3), joints);
    // At rest, reconstruction reproduces the custom joint…
    expect(reconstructJoints(centres, flat(3), seg)[0].x).toBeCloseTo(-3, 6);
    // …and it tracks a rigid move rather than snapping back to a midpoint.
    const moved = centres.map((p) => v(p.x + 100, p.y + 50));
    const got = reconstructJoints(moved, flat(3), seg)[0];
    expect(got.x).toBeCloseTo(-3 + 100, 6);
    expect(got.y).toBeCloseTo(4 + 50, 6);
  });
});

describe("solveSegmentJoints", () => {
  const seg = () => captureSegData(arm(), flat(3), deriveMidpointJoints(arm()));

  it("keeps the ROOT joint (shoulder) pinned when the tip is posed", () => {
    const rootJoint = deriveMidpointJoints(arm())[0];
    const joints = solveSegmentJoints(arm(), flat(3), seg(), 2, v(0, 25));
    expect(joints[0].x).toBeCloseTo(rootJoint.x, 6);
    expect(joints[0].y).toBeCloseTo(rootJoint.y, 6);
  });

  it("preserves every segment length (the arm never stretches)", () => {
    const s = seg();
    const joints = solveSegmentJoints(arm(), flat(3), s, 2, v(6, 18));
    for (let i = 0; i + 1 < joints.length; i++) {
      expect(dist(joints[i], joints[i + 1])).toBeCloseTo(s[i].len, 4);
    }
  });

  it("drives the grabbed token's distal joint onto a reachable target", () => {
    const target = v(6, 12);
    const joints = solveSegmentJoints(arm(), flat(3), seg(), 2, target); // grab tip
    expect(dist(joints[joints.length - 1], target)).toBeLessThan(0.5);
  });

  it("carries joints past a mid-grab rigidly (tip trails)", () => {
    const s = seg();
    const joints = solveSegmentJoints(arm(), flat(3), s, 1, v(5, 8));
    expect(dist(joints[2], joints[3])).toBeCloseTo(s[2].len, 4);
  });

  it("no-ops when the root is grabbed (caller translates instead)", () => {
    expect(solveSegmentJoints(arm(), flat(3), seg(), 0, v(99, 99)))
      .toEqual(reconstructJoints(arm(), flat(3), seg()));
  });
});

describe("jointAngles", () => {
  it("is zero along a straight +x arm", () => {
    for (const a of jointAngles(deriveMidpointJoints(arm()))) expect(a).toBeCloseTo(0, 9);
  });
});
