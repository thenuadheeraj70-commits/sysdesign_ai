import { useState } from "react";
import { generateArchitecture } from "./api/client.js";
import ArchitectureDiagram from "./components/ArchitectureDiagram.jsx";
import ComponentPanel from "./components/ComponentPanel.jsx";
import PerformanceAnalysis from "./components/PerformanceAnalysis.jsx";
import CostAnalysis from "./components/CostAnalysis.jsx";
import Recommendations from "./components/Recommendations.jsx";
import InfrastructureCode from "./components/InfrastructureCode.jsx";

const MAX_LENGTH = 5000; // matches ArchitectureRequest.prompt max_length

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [performance, setPerformance] = useState(null); // latest simulation result, if any
  const [cost, setCost] = useState(null); // latest cost estimate, if any
  const [resultKey, setResultKey] = useState(0); // remounts the diagram for each new result

  const canSubmit = prompt.trim().length > 0 && !loading;

  async function handleGenerate() {
    if (!canSubmit) return;
    setLoading(true);
    setError("");
    try {
      setResult(await generateArchitecture(prompt.trim()));
      setSelectedId(null);
      setResultKey((k) => k + 1);
    } catch (err) {
      setResult(null);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Local-only edits to the generated architecture (not sent to the backend).
  function updateComponent(id, patch) {
    setResult((r) => ({
      ...r,
      components: r.components.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));
  }

  function deleteComponent(id) {
    setResult((r) => ({
      ...r,
      components: r.components.filter((c) => c.id !== id),
      connections: r.connections.filter((x) => x.source !== id && x.target !== id),
    }));
    setSelectedId(null);
  }

  return (
    <div className="app">
      <header className="header">
        <h1>SysDesign AI</h1>
        <p>
          Describe what you want to build and get a proposed system
          architecture: components, how they connect, and the assumptions
          behind them.
        </p>
      </header>

      <main className="layout">
        <section className="panel input-panel">
          <label htmlFor="requirements">Requirements</label>
          <textarea
            id="requirements"
            value={prompt}
            maxLength={MAX_LENGTH}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Build an e-commerce application for 100,000 users with payments, search, and order tracking."
          />
          <div className="input-footer">
            <span className="counter">
              {prompt.length} / {MAX_LENGTH}
            </span>
            <button onClick={handleGenerate} disabled={!canSubmit}>
              {loading ? "Generating…" : "Generate Architecture"}
            </button>
          </div>
        </section>

        <section className="panel results-panel" aria-live="polite">
          <Results
            result={result}
            loading={loading}
            error={error}
            resultKey={resultKey}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onUpdate={updateComponent}
            onDelete={deleteComponent}
          />
        </section>
      </main>

      <PerformanceAnalysis onResult={setPerformance} />

      <CostAnalysis onResult={setCost} />

      <Recommendations architecture={result} performance={performance} cost={cost} />

      <InfrastructureCode key={resultKey} architecture={result} />
    </div>
  );
}

function Results({
  result,
  loading,
  error,
  resultKey,
  selectedId,
  onSelect,
  onUpdate,
  onDelete,
}) {
  if (loading) {
    return (
      <div className="state">
        <div className="spinner" />
        <p>Designing your architecture. This can take a few seconds.</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="state error">
        <h2>Couldn't generate an architecture</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="state">
        <h2>Your architecture will appear here</h2>
        <p>Enter your requirements and select Generate Architecture.</p>
      </div>
    );
  }

  const selected = result.components.find((c) => c.id === selectedId);

  const nameById = Object.fromEntries(
    result.components.map((c) => [c.id, c.name])
  );

  return (
    <div className="result">
      <h2>{result.project_name}</h2>
      {result.description && <p className="lead">{result.description}</p>}

      <h3>Diagram</h3>
      <div className="diagram-area">
        <ArchitectureDiagram
          key={resultKey}
          architecture={result}
          selectedId={selectedId}
          onSelect={onSelect}
        />
        {selected && (
          <ComponentPanel
            key={selected.id}
            component={selected}
            onChange={(patch) => onUpdate(selected.id, patch)}
            onDelete={() => onDelete(selected.id)}
            onClose={() => onSelect(null)}
          />
        )}
      </div>
      {!selected && result.components.length > 0 && (
        <p className="hint">Select a component in the diagram to view or edit it.</p>
      )}

      <h3>Components ({result.components.length})</h3>
      <ul className="components">
        {result.components.map((c) => (
          <li key={c.id} className="component">
            <div className="component-head">
              <strong>{c.name}</strong>
              <span className="tag">{c.type}</span>
              <span className="tag muted">{c.provider}</span>
            </div>
            {Object.keys(c.configuration).length > 0 && (
              <dl className="config">
                {Object.entries(c.configuration).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>
                      {typeof value === "object"
                        ? JSON.stringify(value)
                        : String(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        ))}
      </ul>

      {result.connections.length > 0 && (
        <>
          <h3>Connections ({result.connections.length})</h3>
          <ul className="connections">
            {result.connections.map((conn, i) => (
              <li key={i}>
                <span>{nameById[conn.source] ?? conn.source}</span>
                <span className="arrow" aria-label="connects to">
                  →
                </span>
                <span>{nameById[conn.target] ?? conn.target}</span>
                {conn.label && <em>{conn.label}</em>}
              </li>
            ))}
          </ul>
        </>
      )}

      {result.assumptions.length > 0 && (
        <>
          <h3>Assumptions</h3>
          <ul className="assumptions">
            {result.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
