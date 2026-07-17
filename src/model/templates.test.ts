import { describe, expect, it } from "vitest";
import type { ChainMap } from "../types";
import { addNode, createChain, setNodeConstraint, setNodeOverride, updateSettings } from "./chains";
import {
  deleteTemplate,
  instantiateTemplate,
  saveTemplate,
  toTemplate,
  type TemplateMap,
} from "./templates";

// body -> a1 -> a2 (branch A), body -> b1 (branch B)
function build(): ChainMap {
  let [m, id] = createChain({}, "body");
  m = addNode(m, id, "a1", "body", 10);
  m = addNode(m, id, "a2", "a1", 12);
  m = addNode(m, id, "b1", "body", 8);
  m = updateSettings(m, id, { autoRotate: false, rotationOffsetDeg: 30 });
  m = setNodeConstraint(m, id, "a2", { minDeg: -120, maxDeg: 0 });
  m = setNodeOverride(m, id, "b1", { locked: true });
  return m;
}

describe("chain templates", () => {
  it("captures topology, rest lengths, constraints, overrides and settings", () => {
    const m = build();
    const chain = Object.values(m)[0];
    const t = toTemplate(chain);

    // Root first; every node's parent index precedes it.
    expect(t.nodes[0].parent).toBeNull();
    t.nodes.forEach((n, i) => {
      if (n.parent !== null) expect(n.parent).toBeLessThan(i);
    });
    // 4 nodes, settings carried (without nodeOverrides).
    expect(t.nodes).toHaveLength(4);
    expect(t.settings.autoRotate).toBe(false);
    expect(t.settings.rotationOffsetDeg).toBe(30);
    expect("nodeOverrides" in t.settings).toBe(false);
    // The constrained / overridden nodes carry their data.
    const withConstraint = t.nodes.find((n) => n.constraint);
    expect(withConstraint?.constraint).toEqual({ minDeg: -120, maxDeg: 0 });
    const withOverride = t.nodes.find((n) => n.override);
    expect(withOverride?.override).toEqual({ locked: true });
  });

  it("round-trips onto new tokens, rebuilding the same shape", () => {
    const m = build();
    const t = toTemplate(Object.values(m)[0]);
    // Apply onto a fresh creature's tokens, in template order.
    const result = instantiateTemplate(t, ["r", "x1", "x2", "y1"], {});
    expect(result).not.toBeNull();
    const [map, chainId] = result!;
    const chain = map[chainId];

    expect(chain.rootId).toBe("r");
    expect(chain.nodes.x1.parentId).toBe("r");
    expect(chain.nodes.x2.parentId).toBe("x1");
    expect(chain.nodes.x2.restLength).toBe(12);
    expect(chain.nodes.y1.parentId).toBe("r");
    expect(chain.nodes.y1.restLength).toBe(8);
    // Constraint and override reattached to the corresponding new tokens.
    expect(chain.nodes.x2.constraint).toEqual({ minDeg: -120, maxDeg: 0 });
    expect(chain.settings.nodeOverrides?.y1).toEqual({ locked: true });
    expect(chain.settings.autoRotate).toBe(false);
    expect(chain.settings.rotationOffsetDeg).toBe(30);
  });

  it("adds the new chain alongside existing chains without clobbering them", () => {
    const m = build();
    const t = toTemplate(Object.values(m)[0]);
    const [map] = instantiateTemplate(t, ["r", "x1", "x2", "y1"], m)!;
    expect(Object.keys(map)).toHaveLength(2); // original + instantiated
  });

  it("rejects a mismatched or duplicate token list", () => {
    const t = toTemplate(Object.values(build())[0]);
    expect(instantiateTemplate(t, ["r", "x1", "x2"], {})).toBeNull(); // too few
    expect(instantiateTemplate(t, ["r", "x1", "x2", "x3", "x4"], {})).toBeNull(); // too many
    expect(instantiateTemplate(t, [], {})).toBeNull(); // empty
    expect(instantiateTemplate(t, ["r", "x1", "x2", "x1"], {})).toBeNull(); // duplicate
  });

  it("saveTemplate/deleteTemplate manage a preset map immutably", () => {
    const t = toTemplate(Object.values(build())[0]);
    const empty: TemplateMap = {};
    const one = saveTemplate(empty, "spider-leg", t);
    expect(Object.keys(one)).toEqual(["spider-leg"]);
    expect(empty).toEqual({}); // input not mutated
    const overwritten = saveTemplate(one, "spider-leg", t);
    expect(Object.keys(overwritten)).toEqual(["spider-leg"]);
    const gone = deleteTemplate(one, "spider-leg");
    expect(gone).toEqual({});
    expect(one["spider-leg"]).toBeDefined(); // input not mutated
  });
});
