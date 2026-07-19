import { describe, it, expect } from "vitest";
import type { Vec2 } from "../types";
import {
  captureSegments,
  defaultJointParams,
  deriveJoints,
  jointAngles,
  jointParamFromWorld,
  reconstructJoints,
  seatTokens,
  segmentAngles,
  solveSegmentJoints,
} from "./segment";
import { dist } from "./vec";

const v = (x: number, y: number): Vec2 => ({ x, y });

// A straight horizontal arm: three equal segments, centres 10 apart.
const arm = (): Vec2[] => [v(0, 0), v(10, 0), v(20, 0)];

describe("deriveJoints", () => {
  it("puts interior joints at midpoints and reflects the ends outward", () => {
    // centres 0,10,20 → mids 5,15 → ends -5 and 25.
    expect(deriveJoints(arm()).map((p) => p.x)).toEqual([-5, 5, 15, 25]);
  });

  it("returns a degenerate segment for a lone root", () => {
    expect(deriveJoints([v(3, 4)])).toEqual([v(3, 4), v(3, 4)]);
  });
});

describe("captureSegments", () => {
  it("captures equal lengths and centred seats for an even arm", () => {
    const seg = captureSegments(arm());
    expect(seg.map((s) => s.len)).toEqual([10, 10, 10]);
    for (const s of seg) {
      expect(s.seatAlong).toBeCloseTo(0.5, 9);
      expect(s.seatPerp).toBeCloseTo(0, 9);
    }
  });

  it("round-trips: seatTokens(captured joints) reproduces the centres", () => {
    const centres = arm();
    const seg = captureSegments(centres);
    const seated = seatTokens(deriveJoints(centres), seg);
    seated.forEach((c, i) => {
      expect(c.x).toBeCloseTo(centres[i].x, 9);
      expect(c.y).toBeCloseTo(centres[i].y, 9);
    });
  });
});

describe("adjustable joint pivots", () => {
  it("default params reconstruct the auto-derived joints", () => {
    const centres = arm();
    expect(reconstructJoints(centres, defaultJointParams(3))).toEqual(deriveJoints(centres));
  });

  it("a dragged joint round-trips through its param and back to that position", () => {
    const centres = arm();
    // Drag the shoulder (joint 0) to an arbitrary spot off the bone axis.
    const target = v(-3, 4);
    const param = jointParamFromWorld(centres, 0, target);
    const params = defaultJointParams(3);
    params[0] = param;
    const joints = reconstructJoints(centres, params);
    expect(joints[0].x).toBeCloseTo(target.x, 9);
    expect(joints[0].y).toBeCloseTo(target.y, 9);
    // Untouched joints keep their auto positions.
    expect(joints[1].x).toBeCloseTo(5, 9);
  });

  it("a custom pivot follows the tokens: same params → moved centres → moved joint", () => {
    const centres = arm();
    const params = defaultJointParams(3);
    params[0] = jointParamFromWorld(centres, 0, v(-3, 4)); // shoulder offset by (-3,4) from... relative
    const before = reconstructJoints(centres, params)[0];
    // Translate the whole arm by (100, 50); the custom joint should translate too.
    const moved = centres.map((c) => v(c.x + 100, c.y + 50));
    const after = reconstructJoints(moved, params)[0];
    expect(after.x).toBeCloseTo(before.x + 100, 6);
    expect(after.y).toBeCloseTo(before.y + 50, 6);
  });

  it("seats correctly with a perpendicular custom pivot (round-trip holds)", () => {
    // Give a joint a perpendicular offset, then confirm capture→seat reproduces centres.
    const centres = arm();
    const params = defaultJointParams(3);
    params[1] = { along: 0.5, perp: 0.3 }; // elbow pushed off-axis
    const seg = captureSegments(centres, params);
    const seated = seatTokens(reconstructJoints(centres, params), seg);
    seated.forEach((c, i) => {
      expect(c.x).toBeCloseTo(centres[i].x, 9);
      expect(c.y).toBeCloseTo(centres[i].y, 9);
    });
  });
});

describe("solveSegmentJoints", () => {
  it("keeps the ROOT joint (shoulder) pinned when the tip is posed", () => {
    const centres = arm();
    const seg = captureSegments(centres);
    const rootJoint = deriveJoints(centres)[0];
    const joints = solveSegmentJoints(centres, seg, 2, v(0, 25));
    // The shoulder must not move — that was the whole bug (it used to drift).
    expect(joints[0].x).toBeCloseTo(rootJoint.x, 6);
    expect(joints[0].y).toBeCloseTo(rootJoint.y, 6);
  });

  it("preserves every segment length (the arm never stretches)", () => {
    const centres = arm();
    const seg = captureSegments(centres);
    const joints = solveSegmentJoints(centres, seg, 2, v(6, 18));
    for (let i = 0; i + 1 < joints.length; i++) {
      expect(dist(joints[i], joints[i + 1])).toBeCloseTo(seg[i].len, 4);
    }
  });

  it("drives the grabbed token's distal joint onto a reachable target", () => {
    const centres = arm();
    const seg = captureSegments(centres);
    const target = v(6, 12);
    const joints = solveSegmentJoints(centres, seg, 2, target); // grab tip → effector = last joint
    expect(dist(joints[joints.length - 1], target)).toBeLessThan(0.5);
  });

  it("re-seated segments sit correctly within their (shared) joints", () => {
    const centres = arm();
    const seg = captureSegments(centres);
    const joints = solveSegmentJoints(centres, seg, 2, v(4, 16));
    const seated = seatTokens(joints, seg);
    // Segment i spans joints[i]→joints[i+1]; segment i+1 spans joints[i+1]→…, so
    // they share joints[i+1] by construction (continuity). Each seated centre sits
    // in its segment's frame at the captured (along, perp).
    for (let i = 0; i < seated.length; i++) {
      const a = joints[i];
      const b = joints[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const expected = {
        x: a.x + dx * seg[i].seatAlong - dy * seg[i].seatPerp,
        y: a.y + dy * seg[i].seatAlong + dx * seg[i].seatPerp,
      };
      expect(seated[i].x).toBeCloseTo(expected.x, 9);
      expect(seated[i].y).toBeCloseTo(expected.y, 9);
    }
  });

  it("carries joints past a mid-grab rigidly (tip trails)", () => {
    const centres = arm();
    const seg = captureSegments(centres);
    // Grab the middle token (index 1): its distal joint reaches; the last joint
    // past the effector is carried, so the final segment keeps its length.
    const joints = solveSegmentJoints(centres, seg, 1, v(5, 8));
    expect(dist(joints[2], joints[3])).toBeCloseTo(seg[2].len, 4);
  });

  it("no-ops when the root is grabbed (caller translates instead)", () => {
    const centres = arm();
    const seg = captureSegments(centres);
    expect(solveSegmentJoints(centres, seg, 0, v(99, 99))).toEqual(deriveJoints(centres));
  });
});

describe("segmentAngles / jointAngles", () => {
  it("is zero along a straight +x arm", () => {
    for (const a of segmentAngles(arm())) expect(a).toBeCloseTo(0, 9);
  });

  it("matches jointAngles on the derived joints", () => {
    const centres = arm();
    expect(segmentAngles(centres)).toEqual(jointAngles(deriveJoints(centres)));
  });
});
