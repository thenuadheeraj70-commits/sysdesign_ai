import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { autoLayout } from "../layout.js";
import { useCatalog } from "../catalog.jsx";

/**
 * Editable diagram. Drag nodes to move them, drag from one node's handle to another
 * to connect them, click a node or a line to edit it, press Delete to remove the
 * selection. Node positions are view-only; the architecture itself lives in the parent.
 */
export default function ArchitectureDiagram(props) {
  return (
    <ReactFlowProvider>
      <Diagram {...props} />
    </ReactFlowProvider>
  );
}

function Diagram({
  architecture,
  selectedId,
  selectedEdge,
  onSelect,
  onSelectEdge,
  onConnect,
  onDeleteSelection,
  onAdd,
  undo,
  redo,
  initialPositions,
  onPositions,
}) {
  const rf = useReactFlow();
  const { components, connections } = architecture;

  const auto = useMemo(() => autoLayout(components, connections), [components, connections]);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);

  // Rebuild nodes from the architecture, keeping positions the user dragged to.
  useEffect(() => {
    setNodes((previous) =>
      components.map((c) => {
        const old = previous.find((n) => n.id === c.id);
        return {
          ...(old ?? {}),
          id: c.id,
          position: old?.position ?? initialPositions?.[c.id] ?? auto[c.id],
          data: {
            label: (
              <div className="flow-node">
                <div className="flow-node-name">{c.name}</div>
                <div className="flow-node-meta">
                  {c.type} · {c.provider}
                </div>
              </div>
            ),
          },
          selected: c.id === selectedId,
        };
      })
    );
  }, [components, auto, selectedId, setNodes, initialPositions]);

  // Report where everything is (after dragging settles) so the parent can save and compare it.
  useEffect(() => {
    if (!onPositions || nodes.length === 0) return undefined;
    const timer = setTimeout(() => {
      const map = {};
      for (const n of nodes) map[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
      onPositions(map);
    }, 300);
    return () => clearTimeout(timer);
  }, [nodes, onPositions]);

  const edges = useMemo(
    () =>
      connections.map((c) => ({
        id: `${c.source}->${c.target}`,
        source: c.source,
        target: c.target,
        label: c.label || undefined,
        markerEnd: { type: MarkerType.ArrowClosed },
        selected: selectedEdge?.source === c.source && selectedEdge?.target === c.target,
      })),
    [connections, selectedEdge]
  );

  const relayout = useCallback(() => {
    setNodes((ns) => ns.map((n) => ({ ...n, position: auto[n.id] ?? n.position })));
    setTimeout(() => rf.fitView({ duration: 250, padding: 0.15 }), 50);
  }, [auto, rf, setNodes]);

  return (
    <div className="diagram-wrap">
      <Toolbar components={components} onAdd={onAdd} onRelayout={relayout} undo={undo} redo={redo} />
      {components.length === 0 ? (
        <div className="diagram diagram-empty">No components. Use "Add component" to start.</div>
      ) : (
        <div className="diagram">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            fitView
            nodesDraggable
            deleteKeyCode={["Backspace", "Delete"]}
            onNodeClick={(_, n) => onSelect(n.id)}
            onEdgeClick={(_, e) => onSelectEdge({ source: e.source, target: e.target })}
            onPaneClick={() => {
              onSelect(null);
              onSelectEdge(null);
            }}
            onConnect={(p) => onConnect(p.source, p.target)}
            // One event for everything a Delete key press removes (components and their connections),
            // so it is one undo step.
            onDelete={({ nodes: gone, edges: lines }) =>
              onDeleteSelection(
                gone.map((n) => n.id),
                lines.map((e) => ({ source: e.source, target: e.target }))
              )
            }
          >
            <Background />
            <Controls />
            <MiniMap />
          </ReactFlow>
        </div>
      )}
      <p className="hint">
        Drag from one component's edge to another to connect them. Click a component or a line to edit it;
        press Delete to remove it.
      </p>
    </div>
  );
}

function Toolbar({ components, onAdd, onRelayout, undo, redo }) {
  const { types, providers } = useCatalog();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState("compute");
  const [provider, setProvider] = useState(components[0]?.provider ?? "aws");

  function submit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    onAdd({ name: name.trim(), type, provider });
    setName("");
    setOpen(false);
  }

  return (
    <div className="diagram-toolbar">
      <div className="toolbar-row">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Cancel" : "Add component"}
        </button>
        <button type="button" className="secondary" onClick={onRelayout} disabled={components.length === 0}>
          Auto-layout
        </button>
        <button type="button" className="secondary" onClick={undo.run} disabled={!undo.enabled}>
          Undo
        </button>
        <button type="button" className="secondary" onClick={redo.run} disabled={!redo.enabled}>
          Redo
        </button>
      </div>
      {open && (
        <form className="add-form" onSubmit={submit}>
          <label>
            Name
            <input
              value={name}
              maxLength={200}
              autoFocus
              placeholder="e.g. Search Service"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Type
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {types.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            Provider
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              {providers.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={!name.trim()}>
            Add
          </button>
        </form>
      )}
    </div>
  );
}
