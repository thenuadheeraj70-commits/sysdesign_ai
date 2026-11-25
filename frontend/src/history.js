/**
 * Undo/redo history for the architecture. Pure functions over { past, present, future }, so the
 * rules can be tested without rendering anything. Each function returns a new history, or the
 * same object when nothing changes.
 */
export const HISTORY_LIMIT = 30;

/** A history whose current value is `present` and which has nothing to undo or redo. */
export const startHistory = (present = null) => ({ past: [], present, future: [] });

/** Apply `change(present)`; the old value becomes undoable. A change that returns the same object is ignored. */
export function commit(history, change) {
  if (!history.present) return history;
  const next = change(history.present);
  if (next === history.present) return history;
  return {
    past: [...history.past.slice(-(HISTORY_LIMIT - 1)), history.present],
    present: next,
    future: [],
  };
}

export function undo(history) {
  if (history.past.length === 0) return history;
  return {
    past: history.past.slice(0, -1),
    present: history.past[history.past.length - 1],
    future: [history.present, ...history.future],
  };
}

export function redo(history) {
  if (history.future.length === 0) return history;
  return {
    past: [...history.past, history.present],
    present: history.future[0],
    future: history.future.slice(1),
  };
}

export const canUndo = (history) => history.past.length > 0;
export const canRedo = (history) => history.future.length > 0;
