import { useMemo } from "react";
import { ReactFlow, Background, Controls, MiniMap, MarkerType } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

export default function ArchitectureDiagram({ architecture, selectedId, onSelect }) {
  const nodes = useMemo(() => {
    const cols = 3;
    return architecture.components.map((c, i) => ({
      id: c.id,
      position: { x: (i % cols) * 250 + 30, y: Math.floor(i / cols) * 120 + 30 },
      data: { label: <div className="flow-node"><div className="flow-node-name">{c.name}</div><div className="flow-node-meta">{c.type} · {c.provider}</div></div> },
      selected: c.id === selectedId,
    }));
  }, [architecture, selectedId]);
  const edges = useMemo(() => architecture.connections.map((c, i) => ({
    id: `e-${i}-${c.source}-${c.target}`,
    source: c.source, target: c.target,
    label: c.label || undefined,
    markerEnd: { type: MarkerType.ArrowClosed },
  })), [architecture]);
  if (!architecture.components.length) return <div className="diagram diagram-empty">No components.</div>;
  return <div className="diagram">
    <ReactFlow nodes={nodes} edges={edges} fitView onNodeClick={(_, n) => onSelect?.(n.id)} nodesDraggable>
      <Background />
      <Controls />
      <MiniMap />
    </ReactFlow>
  </div>;
}
