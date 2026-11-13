import { useState } from "react";
import { analyzeArchitecture } from "../api/client.js";

const SEVERITIES = ["critical", "high", "medium", "low"];
const label = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Builds the request body from whatever results are available. */
function buildPayload(architecture, performance, cost) {
  if (!architecture) return null;
  return {
    architecture,
    performance: performance
      ? { utilization_percentage: performance.utilization_percentage }
      : null,
    cost: cost
      ? { total_monthly_cost: cost.total_monthly_cost, monthly_budget: cost.monthly_budget }
      : null,
  };
}

export default function Recommendations({ architecture, performance, cost }) {
  const [analysis, setAnalysis] = useState(null); // { data, snapshot }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const payload = buildPayload(architecture, performance, cost);
  const snapshot = payload ? JSON.stringify(payload) : "";
  const stale = analysis && analysis.snapshot !== snapshot;

  async function handleAnalyze() {
    if (!payload || loading) return;
    setLoading(true);
    setError("");
    try {
      const data = await analyzeArchitecture(payload);
      setAnalysis({ data, snapshot });
    } catch (err) {
      setAnalysis(null);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const nameById = Object.fromEntries(
    (architecture?.components ?? []).map((c) => [c.id, c.name])
  );

  return (
    <section className="panel perf recs" aria-labelledby="recs-title">
      <h2 id="recs-title">AI Recommendations</h2>
      <p className="perf-intro">
        Checks your architecture for possible problems and suggests fixes. These
        are suggestions to review, not confirmed issues. Your architecture is
        analyzed as it is and is never regenerated.
      </p>

      <div className="recs-inputs">
        <span className="recs-label">Based on</span>
        <span className={`chip ${architecture ? "on" : ""}`}>
          Architecture {architecture ? "✓" : "(generate one first)"}
        </span>
        <span className={`chip ${performance ? "on" : ""}`}>
          Performance {performance ? "✓" : "(not run)"}
        </span>
        <span className={`chip ${cost ? "on" : ""}`}>
          Cost {cost ? "✓" : "(not run)"}
        </span>
      </div>

      <div className="perf-actions">
        <button onClick={handleAnalyze} disabled={!architecture || loading}>
          {loading ? "Analyzing…" : analysis ? "Analyze Again" : "Analyze Architecture"}
        </button>
        <span className="hint-inline">
          Run the performance and cost analyses first for a more complete check.
        </span>
      </div>

      {error && (
        <div className="state error perf-error" role="alert">
          <h3>Couldn't analyze the architecture</h3>
          <p>{error}</p>
        </div>
      )}

      {analysis && !error && (
        <div className="sim-results" aria-live="polite">
          {stale && (
            <p className="estimate-banner">
              The architecture, performance, or cost results have changed since this
              analysis. Select Analyze Again to update it.
            </p>
          )}
          <Results data={analysis.data} nameById={nameById} />
        </div>
      )}
    </section>
  );
}

function Results({ data, nameById }) {
  const counts = SEVERITIES.map((s) => ({
    severity: s,
    n: data.recommendations.filter((r) => r.severity === s).length,
  })).filter((c) => c.n > 0);

  return (
    <>
      <div className="recs-summary">
        <p>{data.summary}</p>
        {counts.length > 0 && (
          <div className="recs-counts">
            {counts.map((c) => (
              <span key={c.severity} className={`sev-badge ${c.severity}`}>
                {c.n} {c.severity}
              </span>
            ))}
          </div>
        )}
      </div>

      {data.recommendations.length > 0 && (
        <ul className="rec-list">
          {data.recommendations.map((r) => (
            <li key={r.id} className={`rec-card ${r.severity}`}>
              <div className="rec-top">
                <span className={`sev-badge ${r.severity}`}>{label(r.severity)}</span>
                <span className="rec-confidence">Confidence: {r.confidence}</span>
              </div>

              <h3>{r.issue}</h3>

              <div className="rec-section">
                <h4>Why this was flagged</h4>
                <p>{r.explanation}</p>
              </div>

              <div className="rec-solution">
                <h4>Recommended solution</h4>
                <p>{r.recommendation}</p>
              </div>

              {r.affected_components.length > 0 && (
                <div className="rec-affected">
                  <span>Affects</span>
                  {r.affected_components.map((id) => (
                    <span className="chip on" key={id}>
                      {nameById[id] ?? id}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <details className="how">
        <summary>What this analysis can't see</summary>
        <ul>
          {data.limitations.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
        <p className="hint">{data.notice}</p>
      </details>
    </>
  );
}
