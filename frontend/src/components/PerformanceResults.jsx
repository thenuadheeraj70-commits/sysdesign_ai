const fmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });

export default function PerformanceResults({ result }) {
  const status = result.estimated_status.toLowerCase();
  const utilization = result.utilization_percentage;

  return (
    <div className="sim-results" aria-live="polite">
      <div className="cards">
        <div className="card">
          <span className="card-label">Total capacity</span>
          <span className="card-value">
            {fmt(result.total_capacity)} <small>req/s</small>
          </span>
        </div>
        <div className="card">
          <span className="card-label">Utilization</span>
          <span className="card-value">{fmt(utilization)}%</span>
        </div>
        <div className="card">
          <span className="card-label">Status</span>
          <span className={`badge ${status}`}>{result.estimated_status}</span>
        </div>
        <div className="card">
          <span className="card-label">Bottleneck</span>
          <span className="card-value small">{result.bottleneck}</span>
        </div>
      </div>

      <UtilizationBar value={utilization} status={status} />

      <div className="recommendation">
        <strong>Recommendation</strong>
        <p>{result.recommendation}</p>
      </div>

      <details className="how">
        <summary>How this was calculated</summary>
        <ul>
          {result.explanation.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </details>
      <p className="hint">{result.disclaimer}</p>
    </div>
  );
}

/** Horizontal bar: 0-100% of capacity, with ticks at the 60% and 80% status thresholds. */
function UtilizationBar({ value, status }) {
  const fill = Math.min(value, 100);
  return (
    <div className="bar-wrap">
      <div className="bar" role="img" aria-label={`Utilization ${fmt(value)} percent of capacity`}>
        <div className={`bar-fill ${status}`} style={{ width: `${fill}%` }} />
        <span className="tick" style={{ left: "60%" }} />
        <span className="tick" style={{ left: "80%" }} />
      </div>
      <div className="bar-scale">
        <span style={{ left: "0%" }}>0%</span>
        <span style={{ left: "60%" }}>60%</span>
        <span style={{ left: "80%" }}>80%</span>
        <span style={{ left: "100%" }}>100%</span>
      </div>
      {value > 100 && (
        <p className="over">
          Traffic is {fmt(value)}% of capacity, which is more than the servers can handle.
        </p>
      )}
    </div>
  );
}
