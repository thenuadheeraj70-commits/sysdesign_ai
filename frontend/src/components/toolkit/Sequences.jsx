import { useState } from "react";
import { designSequences } from "../../api/client.js";
import { useRemote } from "../../useRemote.js";
import { TextActions, ToolState } from "./fields.jsx";
import SequenceDiagram from "./SequenceDiagram.jsx";

/** How a request moves through the components, for the main actions of the application. */
export default function Sequences({ architecture, requirements }) {
  const key = JSON.stringify([architecture, requirements]);
  const { data, loading, error } = useRemote(() => designSequences(architecture, requirements), [key]);
  const [picked, setPicked] = useState("");
  if (!data) return <ToolState data={data} loading={loading} error={error} />;

  const flow =
    data.flows.find((f) => f.id === picked) ?? data.flows.find((f) => f.available) ?? data.flows[0];

  return (
    <div className={loading ? "analysis-stale" : undefined}>
      <p className="hint">
        Pick an action to see how a request travels through <em>your</em> components. Flows that need a
        component the design does not have are marked unavailable, with the reason.
      </p>
      <div className="seg" role="group" aria-label="Flow">
        {data.flows.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`seg-btn${flow?.id === f.id ? " active" : ""}`}
            aria-pressed={flow?.id === f.id}
            onClick={() => setPicked(f.id)}
          >
            {f.title}
            {!f.available && <span className="hint-inline"> (n/a)</span>}
          </button>
        ))}
      </div>

      {flow && (
        <div className="tool-group">
          <h4>{flow.title}</h4>
          <p className="hint">{flow.description}</p>
          {flow.available ? (
            <>
              <SequenceDiagram participants={flow.participants} steps={flow.steps} title={flow.title} />
              <TextActions text={flow.mermaid} filename={`${flow.id}.mmd`} label="Mermaid" />
            </>
          ) : (
            <p className="callout">{flow.reason}</p>
          )}
        </div>
      )}
    </div>
  );
}
