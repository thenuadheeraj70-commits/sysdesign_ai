import { useState } from "react";
import { runCostEstimate } from "../api/client.js";

// The five resource types the backend can price, in display order.
const RESOURCES = [
  { type: "compute", label: "Compute", unit: "instances" },
  { type: "database", label: "Database", unit: "instances" },
  { type: "load_balancer", label: "Load balancer", unit: "load balancers" },
  { type: "cache", label: "Cache", unit: "nodes" },
  { type: "storage", label: "Storage", unit: "GB" },
];

const DEFAULT_QUANTITIES = {
  compute: "4",
  database: "1",
  load_balancer: "1",
  cache: "2",
  storage: "500",
};

/** Returns a message describing the first problem, or "" if the inputs are valid. */
function validate(quantities, prices, budget) {
  for (const r of RESOURCES) {
    const q = quantities[r.type].trim();
    if (q === "" || !(Number(q) >= 0))
      return `${r.label} quantity must be 0 or more.`;
    const p = prices[r.type].trim();
    if (p !== "" && !(Number(p) >= 0))
      return `${r.label} price must be 0 or more (or leave it empty).`;
  }
  if (budget.trim() === "" || !(Number(budget) >= 0))
    return "Monthly budget must be 0 or more.";
  return "";
}

const money = (amount, currency) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);

export default function CostAnalysis({ onResult }) {
  const [quantities, setQuantities] = useState(DEFAULT_QUANTITIES);
  const [prices, setPrices] = useState({}); // empty = use the backend's default price
  const [budget, setBudget] = useState("700");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const priceValues = Object.fromEntries(RESOURCES.map((r) => [r.type, prices[r.type] ?? ""]));
  const problem = validate(quantities, priceValues, budget);

  async function handleEstimate() {
    if (problem || loading) return;
    setLoading(true);
    setError("");
    try {
      const data = await runCostEstimate({
          monthly_budget: Number(budget),
          components: RESOURCES.map((r) => ({
            id: r.type,
            name: r.label,
            resource_type: r.type,
            quantity: Number(quantities[r.type]),
            estimated_unit_monthly_price:
              priceValues[r.type].trim() === "" ? null : Number(priceValues[r.type]),
          })),
      });
      setResult(data);
      onResult?.(data);
    } catch (err) {
      setResult(null);
      onResult?.(null);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="panel perf cost" aria-labelledby="cost-title">
      <h2 id="cost-title">Cost Analysis</h2>
      <p className="perf-intro">
        Say how much of each resource you plan to use and what you can spend per
        month. Leave a price empty to use the default estimate.
      </p>

      <div className="cost-table">
        <span className="cost-head">Resource</span>
        <span className="cost-head">Quantity</span>
        <span className="cost-head">Price per unit per month (optional)</span>
        {RESOURCES.map((r) => (
          <div className="cost-row" key={r.type}>
            <label htmlFor={`qty-${r.type}`}>{r.label}</label>
            <div className="with-unit">
              <input
                id={`qty-${r.type}`}
                type="number"
                min="0"
                step="any"
                value={quantities[r.type]}
                onChange={(e) => setQuantities({ ...quantities, [r.type]: e.target.value })}
              />
              <span>{r.unit}</span>
            </div>
            <input
              id={`price-${r.type}`}
              aria-label={`${r.label} price per unit`}
              type="number"
              min="0"
              step="any"
              placeholder="Default price"
              value={priceValues[r.type]}
              onChange={(e) => setPrices({ ...prices, [r.type]: e.target.value })}
            />
          </div>
        ))}
      </div>

      <div className="field budget-field">
        <label htmlFor="budget">Monthly budget</label>
        <input
          id="budget"
          type="number"
          min="0"
          step="any"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
        />
      </div>

      <div className="perf-actions">
        <button onClick={handleEstimate} disabled={Boolean(problem) || loading}>
          {loading ? "Estimating…" : "Estimate Cost"}
        </button>
        {problem && <span className="form-error">{problem}</span>}
      </div>

      {error && (
        <div className="state error perf-error" role="alert">
          <h3>Couldn't estimate the cost</h3>
          <p>{error}</p>
        </div>
      )}

      {result && !error && <CostResults result={result} />}
    </section>
  );
}

function CostResults({ result }) {
  const { currency } = result;
  const byType = Object.fromEntries(result.breakdown.map((l) => [l.resource_type, l]));
  const over = result.budget_status === "Over budget";
  const diffText = over
    ? `${money(-result.budget_difference, currency)} over`
    : `${money(result.budget_difference, currency)} left`;

  return (
    <div className="sim-results" aria-live="polite">
      <p className="estimate-banner">{result.notice}</p>

      <div className="cost-cards">
        {RESOURCES.map((r) => {
          const line = byType[r.type];
          if (!line) return null;
          return (
            <div className="card" key={r.type}>
              <span className="card-label">{r.label} cost</span>
              <span className="card-value">{money(line.monthly_cost, currency)}</span>
              <span className="hint">
                {line.quantity.toLocaleString()} × {money(line.estimated_unit_monthly_price, currency)} per {line.unit}
                {line.price_source === "custom price" ? " (your price)" : ""}
              </span>
            </div>
          );
        })}
      </div>

      <div className="cards summary-cards">
        <div className="card">
          <span className="card-label">Total monthly cost</span>
          <span className="card-value">{money(result.total_monthly_cost, currency)}</span>
        </div>
        <div className="card">
          <span className="card-label">Your budget</span>
          <span className="card-value">{money(result.monthly_budget, currency)}</span>
        </div>
        <div className="card">
          <span className="card-label">Difference</span>
          <span className="card-value small">{diffText}</span>
        </div>
        <div className="card">
          <span className="card-label">Budget status</span>
          <span className={`badge ${over ? "high" : "low"}`}>{result.budget_status}</span>
        </div>
      </div>

      <div className="charts">
        <BreakdownChart breakdown={result.breakdown} currency={currency} />
        <BudgetChart
          total={result.total_monthly_cost}
          budget={result.monthly_budget}
          over={over}
          currency={currency}
        />
      </div>

      <details className="how">
        <summary>How this was calculated</summary>
        <ul>
          {result.explanation.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/** One horizontal bar per resource, scaled to the most expensive one. */
function BreakdownChart({ breakdown, currency }) {
  const max = Math.max(...breakdown.map((l) => l.monthly_cost), 1);
  return (
    <figure className="chart">
      <figcaption>Where the money goes</figcaption>
      {breakdown.map((l) => (
        <div className="hbar" key={l.id}>
          <span className="hbar-label">{l.name}</span>
          <div className="hbar-track">
            <div className="hbar-fill" style={{ width: `${(l.monthly_cost / max) * 100}%` }} />
          </div>
          <span className="hbar-value">
            {money(l.monthly_cost, currency)}
            <small> {l.share_of_total_percentage}%</small>
          </span>
        </div>
      ))}
    </figure>
  );
}

/** Total cost bar with a marker where the budget is. */
function BudgetChart({ total, budget, over, currency }) {
  const scale = Math.max(total, budget, 1);
  return (
    <figure className="chart">
      <figcaption>Total vs. budget</figcaption>
      <div
        className="budget-bar"
        role="img"
        aria-label={`Total ${money(total, currency)} against a budget of ${money(budget, currency)}`}
      >
        <div
          className={`budget-fill ${over ? "over" : "ok"}`}
          style={{ width: `${(total / scale) * 100}%` }}
        />
        <span className="budget-marker" style={{ left: `${(budget / scale) * 100}%` }} />
      </div>
      <div className="budget-legend">
        <span>
          <i className={`dot ${over ? "over" : "ok"}`} /> Total {money(total, currency)}
        </span>
        <span>
          <i className="dot marker" /> Budget {money(budget, currency)}
        </span>
      </div>
    </figure>
  );
}
