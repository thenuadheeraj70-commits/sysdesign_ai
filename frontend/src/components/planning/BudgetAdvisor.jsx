import { useState } from "react";
import { budgetAdvisor } from "../../api/client.js";
import { useRemote } from "../../useRemote.js";
import { money, percent } from "./format.js";

const RISK_LABEL = { low: "Low risk", medium: "Medium risk", high: "High risk" };

/**
 * "Fit this design into $X": the cheapest changes that bring the estimate under a budget, safest first. Each step
 * shows what it saves and how it changes utilization, and you can apply the plan up to any step.
 */
export default function BudgetAdvisor({ architecture, shared, onApplyPatch, applying }) {
  const fromRequirements = shared.requirements?.monthly_budget;
  const [text, setText] = useState(fromRequirements != null ? String(fromRequirements) : "");
  const budget = Number(text);
  const valid = text.trim() !== "" && Number.isFinite(budget) && budget >= 0;

  const key = JSON.stringify([
    architecture,
    shared.requirements,
    shared.capacity,
    shared.latency,
    shared.trafficScale,
    budget,
  ]);
  const { data, loading, error } = useRemote(() => budgetAdvisor(architecture, shared, budget), [key], {
    enabled: valid,
  });

  return (
    <div className={loading ? "analysis-stale" : undefined}>
      <div className="perf-form growth-inputs">
        <div className="field">
          <label htmlFor="advisor-budget">Monthly budget (USD)</label>
          <input
            id="advisor-budget"
            type="number"
            min="0"
            step="any"
            value={text}
            placeholder="e.g. 500"
            onChange={(e) => setText(e.target.value)}
          />
          <span className="hint">
            {fromRequirements != null
              ? "Starts from the budget in your requirements."
              : "Enter what you can spend."}
          </span>
        </div>
      </div>
      {!valid && text.trim() !== "" && <p className="form-error">The budget must be 0 or more.</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {data && valid && (
        <>
          <div className="cards">
            <div className="card">
              <span className="card-label">Estimated cost now</span>
              <span className="card-value">{money(data.current_total)}</span>
            </div>
            <div className="card">
              <span className="card-label">Your budget</span>
              <span className="card-value">{money(data.budget)}</span>
            </div>
            <div className="card">
              <span className="card-label">{data.over_by > 0 ? "Over budget by" : "Headroom"}</span>
              <span className="card-value">
                {money(data.over_by > 0 ? data.over_by : data.budget - data.current_total)}
              </span>
            </div>
            <div className="card">
              <span className="card-label">After every step</span>
              <span className="card-value">{money(data.final_total)}</span>
              <span className={`badge ${data.reachable ? "low" : "high"}`}>
                {data.reachable ? "Fits the budget" : "Still over"}
              </span>
            </div>
          </div>

          {data.steps.length === 0 ? (
            <p className="hint">{data.notes[0]}</p>
          ) : (
            <ol className="advisor-steps">
              {data.steps.map((step, index) => (
                <li key={index} className={`advisor-step risk-${step.risk}`}>
                  <div className="advisor-head">
                    <span
                      className={`sev-badge ${step.risk === "low" ? "low" : step.risk === "medium" ? "medium" : "high"}`}
                    >
                      {RISK_LABEL[step.risk]}
                    </span>
                    <strong>{step.label}</strong>
                  </div>
                  <p>
                    Saves <strong>{money(step.saving)}</strong> a month. Estimated cost after this step:{" "}
                    <strong>{money(step.total_after)}</strong>. Web utilization:{" "}
                    {percent(step.utilization_after)}.
                  </p>
                  <p className="hint">{step.risk_note}</p>
                  <button
                    type="button"
                    className={index === data.steps.length - 1 ? undefined : "secondary"}
                    disabled={applying}
                    onClick={() => onApplyPatch(step.cumulative_patch)}
                  >
                    {index === 0 ? "Apply this step" : `Apply steps 1 to ${index + 1}`}
                    {index === data.steps.length - 1 && data.steps.length > 1 ? " (everything)" : ""}
                  </button>
                </li>
              ))}
            </ol>
          )}
          <ul className="hint-list">
            {(data.steps.length === 0 ? data.notes.slice(1) : data.notes).map((n, i) => (
              <li key={i}>{n}</li>
            ))}
            <li>
              Steps go from safest to riskiest: right-size the web servers, trim workers and caches to one
              copy, tighten the web tier further, drop optional services (monitoring, CDN, search), and only
              then run the web tier close to its limit.
            </li>
          </ul>
        </>
      )}
    </div>
  );
}
