/**
 * Variants: a project holds one or more designs (the original and alternatives such as "Cheap" or "Staging").
 * Each has its own architecture with its own undo history, diagram positions and traffic share. These are pure
 * helpers over the list of variants kept in the app's state.
 *
 * A variant looks like:
 *   { id, name, history, positions, initialPositions, trafficScale }
 * where `history` is the undo/redo history from history.js (its `present` is the architecture).
 */
import { startHistory } from "./history.js";

export const MAX_VARIANTS = 6;
export const FIRST_ID = "v1";

export const newVariant = (id, name, architecture = null, extra = {}) => ({
  id,
  name,
  history: startHistory(architecture),
  positions: null, // where components sit now (view only)
  initialPositions: null, // where the diagram should start from when it is shown
  trafficScale: 1, // share of the project's traffic this design serves (dev and staging serve less)
  ...extra,
});

/** A fresh variant id. Random rather than counted, so two variants added at once can never collide. */
export const randomVariantId = () => `v${Math.random().toString(36).slice(2, 8)}`;

/** The name, made unique among the variants ("Cheap", "Cheap 2", ...). */
export function uniqueName(name, variants) {
  const taken = new Set(variants.map((v) => v.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  let n = 2;
  while (taken.has(`${name} ${n}`.toLowerCase())) n += 1;
  return `${name} ${n}`;
}

/** A new list with `change(variant)` applied to the one with this id. */
export const updateVariant = (variants, id, change) => variants.map((v) => (v.id === id ? change(v) : v));

/** The variants a saved project holds. Older projects have only one design and no variants. */
export function fromProject(project) {
  if (project.variants?.length) {
    const variants = project.variants.map((v) =>
      newVariant(v.id, v.name, v.architecture, {
        positions: v.positions ?? null,
        initialPositions: v.positions ?? null,
        trafficScale: v.traffic_scale ?? 1,
      })
    );
    const activeId = variants.some((v) => v.id === project.active_variant_id)
      ? project.active_variant_id
      : variants[0].id;
    return { variants, activeId };
  }
  const only = newVariant(FIRST_ID, "Original", project.architecture, {
    positions: project.positions ?? null,
    initialPositions: project.positions ?? null,
  });
  return { variants: [only], activeId: only.id };
}

/** What gets saved: every variant, in the shape the API expects. */
export const toSaved = (variants) =>
  variants
    .filter((v) => v.history.present)
    .map((v) => ({
      id: v.id,
      name: v.name,
      architecture: v.history.present,
      positions: v.positions,
      traffic_scale: v.trafficScale,
    }));

/** What counts as "the design" when checking for unsaved changes (not positions, not undo history). */
export const designOf = (variants) =>
  variants.map((v) => ({
    id: v.id,
    name: v.name,
    architecture: v.history.present,
    traffic_scale: v.trafficScale,
  }));

/** Have any component positions changed from what was saved? Only variants that saved positions are compared. */
export function movedSinceSave(variants, saved) {
  return saved.some((s) => {
    if (!s.positions) return false;
    const now = variants.find((v) => v.id === s.id);
    return Boolean(now) && JSON.stringify(now.positions) !== JSON.stringify(s.positions);
  });
}

/** The variants as the compare tool wants them. */
export const forCompare = (variants) =>
  variants
    .filter((v) => v.history.present)
    .map((v) => ({
      id: v.id,
      name: v.name,
      architecture: v.history.present,
      traffic_scale: v.trafficScale,
    }));
