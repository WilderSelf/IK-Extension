import { describe, it, expect } from "vitest";
import type { ChainMap, Vec2 } from "../types";
import {
  buildChain,
  createChain,
  deleteChain,
  findChainForToken,
  orderedNodes,
  pruneMissing,
  removeToken,
  updateSettings,
} from "./chains";

const pos = (o: Record<string, [number, number]>): Record<string, Vec2> =>
  Object.fromEntries(Object.entries(o).map(([k, [x, y]]) => [k, { x, y }]));

const POS = pos({ R: [0, 0], A: [10, 0], B: [20, 0] });
const ROT = { R: 0, A: 0, B: 0 };
const threeChain = (): ChainMap => buildChain({}, ["R", "A", "B"], POS, ROT)![0];

describe("createChain", () => {
  it("creates a lone root with default settings", () => {
    const [map, id] = createChain({}, "root");
    expect(map[id].rootId).toBe("root");
    expect(orderedNodes(map[id])).toEqual(["root"]);
    expect(map[id].settings.autoRotate).toBe(true);
  });
});

describe("buildChain", () => {
  it("builds a linear strand with captured rest lengths and bone offsets", () => {
    const built = buildChain({}, ["R", "A", "B"], POS, ROT);
    expect(built).not.toBeNull();
    const chain = Object.values(built![0])[0];
    expect(orderedNodes(chain)).toEqual(["R", "A", "B"]);
    expect(chain.nodes.A.restLength).toBeCloseTo(10, 6);
    expect(chain.nodes.B.restLength).toBeCloseTo(10, 6);
    // Horizontal bone (angle 0) with token rotation 0 → boneOffsetDeg 0.
    expect(chain.nodes.A.boneOffsetDeg).toBeCloseTo(0, 6);
  });

  it("rejects fewer than two tokens or duplicate ids", () => {
    expect(buildChain({}, ["R"], POS, ROT)).toBeNull();
    expect(buildChain({}, ["R", "R"], POS, ROT)).toBeNull();
  });
});

describe("removeToken", () => {
  it("truncates the strand at an interior node", () => {
    const next = removeToken(threeChain(), "A"); // drops A and B
    expect(orderedNodes(Object.values(next)[0])).toEqual(["R"]);
  });

  it("deletes the whole chain when the root is removed", () => {
    expect(removeToken(threeChain(), "R")).toEqual({});
  });

  it("does not mutate the input", () => {
    const map = threeChain();
    const snapshot = JSON.stringify(map);
    removeToken(map, "A");
    expect(JSON.stringify(map)).toEqual(snapshot);
  });
});

describe("pruneMissing", () => {
  it("drops the trailing part past a missing token", () => {
    const next = pruneMissing(threeChain(), new Set(["R", "A"])); // B gone
    expect(orderedNodes(Object.values(next)[0])).toEqual(["R", "A"]);
  });

  it("drops the whole chain when the root token is gone", () => {
    expect(pruneMissing(threeChain(), new Set(["A", "B"]))).toEqual({});
  });

  it("cuts at the first hole even if a later node survives", () => {
    const next = pruneMissing(threeChain(), new Set(["R", "B"])); // A gone
    expect(orderedNodes(Object.values(next)[0])).toEqual(["R"]);
  });
});

describe("updateSettings", () => {
  it("merges a settings patch without mutating the input", () => {
    const [map, id] = createChain({}, "root");
    const snapshot = JSON.stringify(map);
    const next = updateSettings(map, id, { autoRotate: false });
    expect(next[id].settings.autoRotate).toBe(false);
    expect(JSON.stringify(map)).toEqual(snapshot);
  });
});

describe("findChainForToken / deleteChain", () => {
  it("finds and deletes by id", () => {
    const [map, id] = createChain({}, "root");
    expect(findChainForToken(map, "root")?.id).toBe(id);
    expect(deleteChain(map, id)).toEqual({});
  });
});
