const money = (amount, currency) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);

export default function CostResults({ result }) {
  const { currency } = result;
  const over = result.budget_status === "Over budget";
  const diffText = over
    ? `${money(-result.budget_difference, currency)} over`
    : `${money(result.budget_difference, currency)} left`;

  return (
    <div className="sim-results" aria-live="polite">
      <p className="estimate-banner">{result.notice}</p>

      <div className="cost-cards">
        {result.breakdown.map((line) => (
          <div className="card" key={line.id}>
            <span className="card-label">{line.name}</span>
            <span className="card-value">{money(line.monthly_cost, currency)}</span>
            <span className="hint">
              {line.quantity.toLocaleString()} × {money(line.estimated_unit_monthly_price, currency)} per{" "}
              {line.unit}
              {line.discount_percent > 0 && ` (${line.discount_percent}% discount)`}
            </span>
          </div>
        ))}
      </div>

      <div className="cards summary-cards">
        <div className="card">
          <span className="card-label">Total monthly cost</span>
          <span className="card-value">{money(result.total_monthly_cost, currency)}</span>
          {result.discount_savings > 0 && (
            <span className="hint">Discounts save {money(result.discount_savings, currency)} a month</span>
          )}
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
