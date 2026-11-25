import { describe, expect, it } from "vitest";
import { HISTORY_LIMIT, canRedo, canUndo, commit, redo, startHistory, undo } from "./history.js";

const arch = (n) => ({ project_name: `v${n}`, components: [], connections: [] });
const rename = (name) => (a) => ({ ...a, project_name: name });

describe("history", () => {
  it("starts with nothing to undo or redo", () => {
    const h = startHistory(arch(0));
    expect(h.present.project_name).toBe("v0");
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  it("commits a change and can undo and redo it", () => {
    let h = commit(startHistory(arch(0)), rename("v1"));
    expect(h.present.project_name).toBe("v1");
    expect(canUndo(h)).toBe(true);

    h = undo(h);
    expect(h.present.project_name).toBe("v0");
    expect(canRedo(h)).toBe(true);

    h = redo(h);
    expect(h.present.project_name).toBe("v1");
    expect(canRedo(h)).toBe(false);
  });

  it("undoes several steps in reverse order", () => {
    let h = startHistory(arch(0));
    for (const n of [1, 2, 3]) h = commit(h, rename(`v${n}`));
    expect([undo, undo, undo].map((step) => (h = step(h)).present.project_name)).toEqual(["v2", "v1", "v0"]);
    expect(canUndo(h)).toBe(false);
  });

  it("drops the redo branch when a new change is made after an undo", () => {
    let h = commit(commit(startHistory(arch(0)), rename("v1")), rename("v2"));
    h = undo(h);
    expect(canRedo(h)).toBe(true);
    h = commit(h, rename("other"));
    expect(h.present.project_name).toBe("other");
    expect(canRedo(h)).toBe(false);
  });

  it("ignores a change that returns the same object (nothing to undo afterwards)", () => {
    const h = startHistory(arch(0));
    expect(commit(h, (a) => a)).toBe(h);
  });

  it("ignores changes while there is no architecture yet", () => {
    const h = startHistory(null);
    expect(commit(h, () => arch(1))).toBe(h);
  });

  it("undo and redo with nothing to do return the same history", () => {
    const h = startHistory(arch(0));
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });

  it(`keeps at most ${HISTORY_LIMIT} undo steps`, () => {
    let h = startHistory(arch(0));
    for (let n = 1; n <= HISTORY_LIMIT + 10; n += 1) h = commit(h, rename(`v${n}`));
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    let steps = 0;
    while (canUndo(h)) {
      h = undo(h);
      steps += 1;
    }
    expect(steps).toBe(HISTORY_LIMIT);
    expect(h.present.project_name).toBe("v10"); // the oldest ten were forgotten
  });

  it("never mutates earlier states", () => {
    const first = arch(0);
    const h = commit(startHistory(first), rename("changed"));
    expect(first.project_name).toBe("v0");
    expect(h.past[0]).toBe(first);
  });
});
