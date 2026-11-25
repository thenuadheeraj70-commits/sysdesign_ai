import { describe, expect, it } from "vitest";
import {
  FIRST_ID,
  MAX_VARIANTS,
  designOf,
  forCompare,
  fromProject,
  movedSinceSave,
  newVariant,
  randomVariantId,
  toSaved,
  uniqueName,
  updateVariant,
} from "./variants.js";

const arch = (name = "A") => ({
  project_name: name,
  description: "",
  components: [{ id: "api", name: "API", type: "compute", provider: "aws", configuration: {} }],
  connections: [],
  assumptions: [],
});

describe("variants", () => {
  it("starts with an open history, full traffic and no positions", () => {
    const v = newVariant("v1", "Original", arch());
    expect(v).toMatchObject({ id: "v1", name: "Original", trafficScale: 1, positions: null });
    expect(v.history.present.project_name).toBe("A");
    expect(newVariant("x", "Empty").history.present).toBeNull();
  });

  it("makes ids that do not collide", () => {
    const ids = new Set(Array.from({ length: 200 }, randomVariantId));
    expect(ids.size).toBe(200);
    expect([...ids].every((id) => /^v[a-z0-9]+$/.test(id))).toBe(true);
  });

  it("makes names unique without caring about case", () => {
    const list = [newVariant("1", "Cheap"), newVariant("2", "cheap 2")];
    expect(uniqueName("Balanced", list)).toBe("Balanced");
    expect(uniqueName("CHEAP", list)).toBe("CHEAP 3");
  });

  it("updates only the variant asked for", () => {
    const list = [newVariant("1", "A"), newVariant("2", "B")];
    const next = updateVariant(list, "2", (v) => ({ ...v, name: "Renamed" }));
    expect(next.map((v) => v.name)).toEqual(["A", "Renamed"]);
    expect(next[0]).toBe(list[0]); // untouched variants are the same objects
  });

  it("opens an older project as one Original variant with its positions", () => {
    const { variants, activeId } = fromProject({ architecture: arch(), positions: { api: { x: 1, y: 2 } } });
    expect(variants).toHaveLength(1);
    expect(variants[0]).toMatchObject({ id: FIRST_ID, name: "Original", positions: { api: { x: 1, y: 2 } } });
    expect(activeId).toBe(FIRST_ID);
  });

  it("opens a project with variants, restoring the open one and each traffic share", () => {
    const project = {
      architecture: arch(),
      active_variant_id: "b",
      variants: [
        { id: "a", name: "One", architecture: arch("1"), positions: null, traffic_scale: 1 },
        {
          id: "b",
          name: "Two",
          architecture: arch("2"),
          positions: { api: { x: 5, y: 5 } },
          traffic_scale: 0.25,
        },
      ],
    };
    const { variants, activeId } = fromProject(project);
    expect(activeId).toBe("b");
    expect(variants[1]).toMatchObject({ trafficScale: 0.25, initialPositions: { api: { x: 5, y: 5 } } });
  });

  it("falls back to the first variant when the saved open one is gone", () => {
    const project = {
      architecture: arch(),
      active_variant_id: "missing",
      variants: [{ id: "a", name: "One", architecture: arch() }],
    };
    expect(fromProject(project).activeId).toBe("a");
  });

  it("saves every variant that has a design, in the API shape", () => {
    const list = [
      newVariant("a", "A", arch()),
      newVariant("b", "Empty"),
      newVariant("c", "C", arch("C"), { trafficScale: 0.5 }),
    ];
    const saved = toSaved(list);
    expect(saved.map((s) => s.id)).toEqual(["a", "c"]);
    expect(saved[1]).toMatchObject({ traffic_scale: 0.5, architecture: { project_name: "C" } });
    expect(forCompare(list).map((v) => v.id)).toEqual(["a", "c"]);
  });

  it("ignores positions and history when deciding whether the design changed", () => {
    const a = newVariant("a", "A", arch());
    const moved = { ...a, positions: { api: { x: 9, y: 9 } } };
    expect(JSON.stringify(designOf([a]))).toBe(JSON.stringify(designOf([moved])));
    expect(JSON.stringify(designOf([a]))).not.toBe(JSON.stringify(designOf([{ ...a, name: "B" }])));
  });

  it("notices moved components, but only where positions were saved", () => {
    const list = [newVariant("a", "A", arch(), { positions: { api: { x: 1, y: 1 } } })];
    expect(movedSinceSave(list, [{ id: "a", positions: { api: { x: 1, y: 1 } } }])).toBe(false);
    expect(movedSinceSave(list, [{ id: "a", positions: { api: { x: 2, y: 2 } } }])).toBe(true);
    expect(movedSinceSave(list, [{ id: "a", positions: null }])).toBe(false); // an older save has none
    expect(movedSinceSave(list, [{ id: "gone", positions: { api: { x: 2, y: 2 } } }])).toBe(false);
  });

  it("allows six variants", () => {
    expect(MAX_VARIANTS).toBe(6);
  });
});
