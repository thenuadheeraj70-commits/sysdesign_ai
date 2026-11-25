/**
 * Left-to-right layered layout: a component sits one column to the right of the
 * deepest component that feeds it (clients/entry points on the left, data stores
 * on the right). Connections that form a cycle do not break the layout.
 */
const COLUMN_WIDTH = 270;
const ROW_HEIGHT = 110;
const MARGIN = 30;

export function autoLayout(components, connections) {
  const ids = components.map((c) => c.id);
  const out = new Map(ids.map((id) => [id, []]));
  const waiting = new Map(ids.map((id) => [id, 0]));

  for (const { source, target } of connections) {
    if (source !== target && out.has(source) && out.has(target)) {
      out.get(source).push(target);
      waiting.set(target, waiting.get(target) + 1);
    }
  }

  const depth = new Map(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => waiting.get(id) === 0);
  while (queue.length) {
    const id = queue.shift();
    for (const next of out.get(id)) {
      depth.set(next, Math.max(depth.get(next), depth.get(id) + 1));
      waiting.set(next, waiting.get(next) - 1);
      if (waiting.get(next) === 0) queue.push(next);
    }
  }

  const columns = new Map();
  for (const id of ids) {
    const d = depth.get(id);
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d).push(id);
  }
  const tallest = Math.max(1, ...[...columns.values()].map((col) => col.length));

  const positions = {};
  for (const [d, col] of columns) {
    const offset = ((tallest - col.length) * ROW_HEIGHT) / 2; // centre short columns
    col.forEach((id, row) => {
      positions[id] = { x: MARGIN + d * COLUMN_WIDTH, y: MARGIN + offset + row * ROW_HEIGHT };
    });
  }
  return positions;
}

/** A unique, readable id for a new component, e.g. "order-queue", "order-queue-2". */
export function newComponentId(name, taken) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "component";
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

export const COMPONENT_TYPES = [
  "load_balancer",
  "api_gateway",
  "compute",
  "container",
  "serverless",
  "database",
  "cache",
  "storage",
  "cdn",
  "queue",
  "search",
  "auth",
  "security",
  "monitoring",
  "network",
];
export const PROVIDERS = ["aws", "gcp", "azure", "generic"];
