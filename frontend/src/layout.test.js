import { describe, expect, it } from "vitest";
import { autoLayout, newComponentId } from "./layout.js";

const comps = (...ids) => ids.map((id) => ({ id }));
const link = (source, target) => ({ source, target });

describe("autoLayout", () => {
  it("puts each component one column right of the one that feeds it", () => {
    const p = autoLayout(comps("lb", "api", "db"), [link("lb", "api"), link("api", "db")]);
    expect(p.lb.x).toBeLessThan(p.api.x);
    expect(p.api.x).toBeLessThan(p.db.x);
  });

  it("uses the longest path, so a component fed by two chains sits after both", () => {
    const p = autoLayout(comps("a", "b", "c", "d"), [
      link("a", "b"),
      link("b", "c"),
      link("a", "c"),
      link("c", "d"),
    ]);
    expect(p.c.x).toBeGreaterThan(p.b.x);
    expect(p.d.x).toBeGreaterThan(p.c.x);
  });

  it("stacks components of the same depth in one column without overlapping", () => {
    const p = autoLayout(comps("lb", "x", "y", "z"), [link("lb", "x"), link("lb", "y"), link("lb", "z")]);
    expect(new Set([p.x.x, p.y.x, p.z.x]).size).toBe(1);
    expect(new Set([p.x.y, p.y.y, p.z.y]).size).toBe(3);
  });

  it("vertically centres a short column against a tall one", () => {
    const p = autoLayout(comps("lb", "x", "y", "z"), [link("lb", "x"), link("lb", "y"), link("lb", "z")]);
    expect(p.lb.y).toBe(p.y.y); // the single load balancer lines up with the middle of the three
  });

  it("gives every component a position, even when there are no connections", () => {
    const p = autoLayout(comps("a", "b", "c"), []);
    expect(Object.keys(p).sort()).toEqual(["a", "b", "c"]);
  });

  it("does not hang or drop components when connections form a cycle", () => {
    const p = autoLayout(comps("a", "b", "c"), [link("a", "b"), link("b", "c"), link("c", "b")]);
    expect(Object.keys(p)).toHaveLength(3);
    for (const pos of Object.values(p)) {
      expect(Number.isFinite(pos.x) && Number.isFinite(pos.y)).toBe(true);
    }
  });

  it("ignores self links and links to unknown components", () => {
    const p = autoLayout(comps("a", "b"), [link("a", "a"), link("a", "ghost"), link("ghost", "b")]);
    expect(p.a.x).toBe(p.b.x);
  });

  it("handles an empty architecture", () => {
    expect(autoLayout([], [])).toEqual({});
  });
});

describe("newComponentId", () => {
  it("makes a readable id from the name", () => {
    expect(newComponentId("Order Queue", new Set())).toBe("order-queue");
    expect(newComponentId("  API / Gateway (v2)! ", new Set())).toBe("api-gateway-v2");
  });

  it("adds a number when the id is taken", () => {
    expect(newComponentId("Cache", new Set(["cache"]))).toBe("cache-2");
    expect(newComponentId("Cache", new Set(["cache", "cache-2"]))).toBe("cache-3");
  });

  it("falls back to a default for names with no letters or digits", () => {
    expect(newComponentId("!!!", new Set())).toBe("component");
    expect(newComponentId("日本語", new Set())).toBe("component");
  });
});
