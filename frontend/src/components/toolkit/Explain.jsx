import { useState } from "react";
import { explainComponent } from "../../api/client.js";
import { GlossaryProvider, GlossaryText } from "./glossary.jsx";

/** "Explain this component": what it is, what it does in this design, what else could be used, and common mistakes. */
export default function Explain({ architecture, requirements, componentId }) {
  const [state, setState] = useState({ open: false, loading: false, data: null, error: "" });

  async function toggle() {
    if (state.open) {
      setState((s) => ({ ...s, open: false }));
      return;
    }
    setState({ open: true, loading: true, data: null, error: "" });
    try {
      const data = await explainComponent(architecture, requirements, componentId);
      setState({ open: true, loading: false, data, error: "" });
    } catch (err) {
      setState({ open: true, loading: false, data: null, error: err.message });
    }
  }

  const { open, loading, data, error } = state;
  return (
    <div className="explain">
      <button type="button" className="secondary" aria-expanded={open} onClick={toggle}>
        {open ? "Hide explanation" : "Explain this component"}
      </button>
      {open && (
        <GlossaryProvider>
          <div className="explain-body" role="region" aria-label="Explanation" aria-live="polite">
            {loading && <p className="hint">Working it out…</p>}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            {data && (
              <>
                <p>
                  <GlossaryText>{data.what_it_is}</GlossaryText>
                </p>
                <p>
                  <strong>In this design.</strong> {data.role_here}
                </p>
                {data.receives_from.length > 0 && (
                  <p>
                    <strong>Receives from:</strong> {data.receives_from.join(", ")}
                  </p>
                )}
                {data.sends_to.length > 0 && (
                  <p>
                    <strong>Sends to:</strong> {data.sends_to.join(", ")}
                  </p>
                )}
                {data.alternatives.length > 0 && (
                  <>
                    <strong>Alternatives</strong>
                    <ul className="hint-list">
                      {data.alternatives.map((a) => (
                        <li key={a.name}>
                          <GlossaryText>{`${a.name}: choose it when ${a.choose_when}.`}</GlossaryText>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {data.pitfalls.length > 0 && (
                  <>
                    <strong>Common mistakes</strong>
                    <ul className="hint-list">
                      {data.pitfalls.map((p, i) => (
                        <li key={i}>
                          <GlossaryText>{p}</GlossaryText>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </div>
        </GlossaryProvider>
      )}
    </div>
  );
}
