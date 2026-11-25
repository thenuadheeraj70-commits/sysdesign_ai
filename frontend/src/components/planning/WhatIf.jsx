import { useState } from "react";
import { whatIf } from "../../api/client.js";
import { useRemote } from "../../useRemote.js";
import LineChart from "./LineChart.jsx";
import { compact, money, number, percent } from "./format.js";

const POINTS = 60;
const STOPS = [
  { label: "Today", position: 0 },
  { label: "2×", position: Math.log10(2) },
  { label: "5×", position: Math.log10(5) },
  { label: "10×", position: 1 },
];

/**
 * "What if traffic changed?" A slider moves traffic from a tenth of today's peak to ten times it, and the
 * utilization, servers needed and cost follow. The curve and the point where capacity runs out are drawn.
 *
 * The backend supplies the model's numbers once (capacity, server price, thresholds); the slider then applies the
 * same simple formulas locally so it responds instantly.
 */
export default function WhatIf({ architecture, shared }) {
  const key = JSON.stringify([
    architecture,
    shared.requirements,
    shared.capacity,
    shared.latency,
    shared.trafficScale,
  ]);
  const { data, loading, error } = useRemote(() => whatIf(architecture, shared), [key]);
  const [position, setPosition] = useState(0); // -1 .. 1, traffic = today's peak x 10^position
  const [typed, setTyped] = useState(null); // what is being typed in the exact box, until it loses focus

  if (error) {
    return (
      <p className="form-error" role="alert">
        {error}
      </p>
    );
  }
  if (!data) return <p className="hint">{loading ? "Calculating…" : ""}</p>;

  const base = Math.max(data.base_requests_per_second, 1e-9);
  const rpsFor = (p) => base * 10 ** p;
  const rps = rpsFor(position);
  const capacityTotal = data.capacity_requests_per_second;

  const at = (traffic) => {
    const utilization = (traffic / capacityTotal) * 100;
    const needed = Math.max(
      1,
      Math.ceil(traffic / ((data.capacity_per_server * data.target_utilization) / 100))
    );
    return {
      utilization,
      status:
        utilization < data.low_utilization_below
          ? "Low"
          : utilization <= data.high_utilization_above
            ? "Moderate"
            : "High",
      needed,
      cost: data.base_monthly_cost + Math.max(0, needed - data.number_of_servers) * data.server_monthly_price,
    };
  };

  const now = at(rps);
  const maxTraffic = base * 10;
  const grid = Array.from({ length: POINTS + 1 }, (_, i) => (maxTraffic * i) / POINTS);
  const usersPerRps = (() => {
    const p = data.points.find((q) => q.requests_per_second > 0);
    return p ? p.users_equivalent / p.requests_per_second : 0;
  })();

  const capacityMultiple = capacityTotal / base;
  const summary = `Utilization rises from 0% at no traffic to ${percent(at(maxTraffic).utilization)} at ${number(
    maxTraffic
  )} requests per second. Capacity runs out at ${number(capacityTotal)} requests per second.`;

  return (
    <div className={loading ? "analysis-stale" : undefined}>
      <div className="whatif-controls">
        <label htmlFor="whatif-slider">
          Traffic: <strong>{number(rps)} req/s</strong>{" "}
          <span className="hint-inline">
            ({number(10 ** position)}× today's peak
            {usersPerRps > 0 && `, about ${compact(rps * usersPerRps)} users`})
          </span>
        </label>
        <input
          id="whatif-slider"
          type="range"
          min="-1"
          max="1"
          step="0.01"
          value={position}
          onChange={(e) => setPosition(Number(e.target.value))}
          aria-valuetext={`${number(rps)} requests per second`}
        />
        <div className="whatif-stops">
          {STOPS.map((s) => (
            <button key={s.label} type="button" className="secondary" onClick={() => setPosition(s.position)}>
              {s.label}
            </button>
          ))}
          <label className="inline-number">
            Exact req/s
            <input
              type="number"
              min="0"
              step="any"
              value={typed ?? Math.round(rps * 100) / 100}
              onBlur={() => setTyped(null)}
              onChange={(e) => {
                setTyped(e.target.value);
                const value = Number(e.target.value);
                if (Number.isFinite(value) && value > 0) {
                  setPosition(Math.min(1, Math.max(-1, Math.log10(value / base))));
                }
              }}
            />
          </label>
        </div>
      </div>

      <div className="cards">
        <div className="card">
          <span className="card-label">Utilization</span>
          <span className="card-value">{percent(now.utilization)}</span>
          <span className={`badge ${now.status.toLowerCase()}`}>{now.status}</span>
        </div>
        <div className="card">
          <span className="card-label">Web servers needed</span>
          <span className="card-value">{now.needed}</span>
          <span className="hint">you have {data.number_of_servers}</span>
        </div>
        <div className="card">
          <span className="card-label">Monthly cost if scaled</span>
          <span className="card-value">{money(now.cost)}</span>
          <span className="hint">today {money(data.base_monthly_cost)}</span>
        </div>
        <div className="card">
          <span className="card-label">Capacity runs out at</span>
          <span className="card-value small">{number(capacityTotal)} req/s</span>
          <span className="hint">{number(capacityMultiple)}× today's peak</span>
        </div>
      </div>

      <h4>Utilization as traffic grows</h4>
      <LineChart
        summary={summary}
        series={[{ name: "Utilization", points: grid.map((x) => ({ x, y: at(x).utilization })) }]}
        refLines={[
          { y: data.high_utilization_above, label: `${data.high_utilization_above}% high`, tone: "warn" },
          { y: 100, label: "100% capacity", tone: "limit" },
        ]}
        vLines={[{ x: capacityTotal, label: "capacity runs out" }]}
        marker={{ x: rps, y: now.utilization }}
        xMax={maxTraffic}
        yMax={150}
        formatX={compact}
        formatY={(y) => `${Math.round(y)}%`}
        xLabel="Requests per second"
        yLabel="Utilization"
      />

      <h4>Monthly cost if you add servers to keep up</h4>
      <LineChart
        summary="Monthly cost stays flat while existing servers have room, then steps up as servers are added."
        series={[{ name: "Cost", step: true, points: grid.map((x) => ({ x, y: at(x).cost })) }]}
        marker={{ x: rps, y: now.cost }}
        xMax={maxTraffic}
        formatX={compact}
        formatY={money}
        xLabel="Requests per second"
        yLabel="Cost per month"
      />

      <details className="how">
        <summary>The numbers behind the charts</summary>
        <div className="table-scroll">
          <table className="plain-table">
            <thead>
              <tr>
                <th>Requests per second</th>
                <th>About this many users</th>
                <th>Utilization</th>
                <th>Servers needed</th>
                <th>Cost if scaled</th>
              </tr>
            </thead>
            <tbody>
              {data.points.map((p) => (
                <tr
                  key={p.requests_per_second}
                  className={p.utilization_percentage > data.high_utilization_above ? "row-warn" : undefined}
                >
                  <td>{number(p.requests_per_second)}</td>
                  <td>{compact(p.users_equivalent)}</td>
                  <td>{percent(p.utilization_percentage)}</td>
                  <td>{p.servers_needed}</td>
                  <td>{money(p.monthly_cost_if_scaled)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="hint-list">
          {data.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
