import { useState } from "react";
import { runSimulation } from "../api/client.js";

const FIELDS = [
  { key: "incoming_requests_per_second", label: "Requests per second", hint: "Incoming traffic", step: "any" },
  { key: "number_of_servers", label: "Number of servers", hint: "Whole number, at least 1", step: 1 },
  { key: "capacity_per_server", label: "Capacity per server", hint: "Requests per second one server handles", step: "any" },
  { key: "average_latency", label: "Average latency (ms)", hint: "Typical response time", step: "any" },
];

const DEFAULTS = {
  incoming_requests_per_second: "5000",
  number_of_servers: "4",
  capacity_per_server: "1500",
  average_latency: "100",
};

/** Returns a message describing the first problem, or "" if the inputs are valid. */
function validate(values) {
  const num = (k) => (values[k].trim() === "" ? NaN : Number(values[k]));
  if (!(num("incoming_requests_per_second") >= 0))
    return "Requests per second must be 0 or more.";
  const servers = num("number_of_servers");
  if (!Number.isInteger(servers) || servers < 1)
    return "Number of servers must be a whole number, at least 1.";
  if (!(num("capacity_per_server") > 0))
    return "Capacity per server must be greater than 0.";
  if (!(num("average_latency") >= 0))
    return "Average latency must be 0 or more.";
  return "";
}

const fmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });

export default function PerformanceAnalysis({ onResult }) {
  const [values, setValues] = useState(DEFAULTS);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const problem = validate(values);

  async function handleRun() {
    if (problem || loading) return;
    setLoading(true);
    setError("");
    try {
      const data = await runSimulation({
        incoming_requests_per_second: Number(values.incoming_requests_per_second),
        number_of_servers: Number(values.number_of_servers),
        capacity_per_server: Number(values.capacity_per_server),
        average_latency: Number(values.average_latency),
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
    <section className="panel perf" aria-labelledby="perf-title">
      <h2 id="perf-title">Performance Analysis</h2>
      <p className="perf-intro">
        Enter your expected traffic and server setup to estimate how loaded the
        system will be. This is a simple model, not a real benchmark.
      </p>

      <div className="perf-form">
        {FIELDS.map((f) => (
          <div className="field" key={f.key}>
            <label htmlFor={f.key}>{f.label}</label>
            <input
              id={f.key}
              type="number"
              min="0"
              step={f.step}
              inputMode="decimal"
              value={values[f.key]}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
            <span className="hint">{f.hint}</span>
          </div>
        ))}
      </div>

      <div className="perf-actions">
        <button onClick={handleRun} disabled={Boolean(problem) || loading}>
          {loading ? "Running…" : "Run Simulation"}
        </button>
        {problem && <span className="form-error">{problem}</span>}
      </div>

      {error && (
        <div className="state error perf-error" role="alert">
          <h3>Couldn't run the simulation</h3>
          <p>{error}</p>
        </div>
      )}

      {result && !error && <SimulationResults result={result} />}
    </section>
  );
}

function SimulationResults({ result }) {
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
      <div
        className="bar"
        role="img"
        aria-label={`Utilization ${fmt(value)} percent of capacity`}
      >
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
