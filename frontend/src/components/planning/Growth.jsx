import { useState } from "react";
import { growth } from "../../api/client.js";
import { useRemote } from "../../useRemote.js";
import LineChart from "./LineChart.jsx";
import { compact, money, number, percent } from "./format.js";

const MONTH_CHOICES = [12, 24, 36];

/**
 * Traffic growth month by month: when each tier (web servers, database, cache) passes its comfortable limit,
 * and what it costs to keep up compared with leaving the design as it is.
 */
export default function Growth({ architecture, shared }) {
  const [rate, setRate] = useState("10");
  const [months, setMonths] = useState(12);
  const growthRate = Number(rate);
  const valid = rate.trim() !== "" && Number.isFinite(growthRate) && growthRate >= 0 && growthRate <= 100;

  const key = JSON.stringify([
    architecture,
    shared.requirements,
    shared.capacity,
    shared.latency,
    shared.trafficScale,
    growthRate,
    months,
  ]);
  const { data, loading, error } = useRemote(() => growth(architecture, shared, growthRate, months), [key], {
    enabled: valid,
  });

  return (
    <div className={loading ? "analysis-stale" : undefined}>
      <div className="perf-form growth-inputs">
        <div className="field">
          <label htmlFor="growth-rate">Traffic growth per month (%)</label>
          <input
            id="growth-rate"
            type="number"
            min="0"
            max="100"
            step="any"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
          />
          <span className="hint">Compounding: 10% a month is about 3.1× a year.</span>
        </div>
        <div className="field">
          <label htmlFor="growth-months">Look ahead</label>
          <select id="growth-months" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
            {MONTH_CHOICES.map((m) => (
              <option key={m} value={m}>
                {m} months
              </option>
            ))}
          </select>
        </div>
      </div>
      {!valid && <p className="form-error">Growth must be between 0 and 100 percent a month.</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {data && valid && (
        <>
          <div className="cards tier-cards">
            {data.tiers.map((t) => (
              <div className="card" key={t.kind}>
                <span className="card-label">{t.name}</span>
                {t.first_scale_month === null ? (
                  <span className="card-value small">No scaling needed</span>
                ) : t.first_scale_month === 0 ? (
                  <span className="card-value small">Already over the limit</span>
                ) : (
                  <span className="card-value small">Scale by month {t.first_scale_month}</span>
                )}
                <span className="hint">
                  {t.instances} instance{t.instances === 1 ? "" : "s"} today
                  {t.first_scale_month === null ? `, fine for ${months} months` : ""}
                </span>
              </div>
            ))}
            <div className="card">
              <span className="card-label">Cost over {months} months</span>
              <span className="card-value small">{money(data.total_cost_if_scaled)}</span>
              <span className="hint">
                {money(data.total_cost_if_scaled - data.total_cost_unchanged)} more than leaving it as it is (
                {money(data.total_cost_unchanged)})
              </span>
            </div>
          </div>

          <h4>Utilization of each tier</h4>
          <LineChart
            summary={`Utilization of ${data.tiers.map((t) => t.name).join(", ")} over ${months} months of ${growthRate}% monthly growth.`}
            series={data.tiers.map((t) => ({
              name: t.name,
              points: data.months.map((m) => ({ x: m.month, y: m.tiers[t.kind].utilization_percentage })),
            }))}
            refLines={[
              { y: data.high_utilization_above, label: `${data.high_utilization_above}% high`, tone: "warn" },
            ]}
            xMax={months}
            yMax={150}
            formatY={(y) => `${Math.round(y)}%`}
            formatX={(x) => `month ${Math.round(x)}`}
            xLabel="Months from now"
            yLabel="Utilization"
          />

          <h4>Monthly cost if you scale to keep up</h4>
          <LineChart
            summary={`Monthly cost rises from ${money(data.months[0].monthly_cost_if_scaled)} to ${money(
              data.months[data.months.length - 1].monthly_cost_if_scaled
            )}.`}
            series={[
              {
                name: "Cost",
                step: true,
                points: data.months.map((m) => ({ x: m.month, y: m.monthly_cost_if_scaled })),
              },
            ]}
            xMax={months}
            formatY={money}
            formatX={(x) => `month ${Math.round(x)}`}
            xLabel="Months from now"
            yLabel="Cost per month"
          />

          <details className="how">
            <summary>Month by month</summary>
            <div className="table-scroll">
              <table className="plain-table">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th>Requests per second</th>
                    {data.tiers.map((t) => (
                      <th key={t.kind}>{t.name} (utilization / needed)</th>
                    ))}
                    <th>Cost if scaled</th>
                  </tr>
                </thead>
                <tbody>
                  {data.months
                    .filter((m) => m.month % (months > 12 ? 3 : 1) === 0 || m.month === months)
                    .map((m) => (
                      <tr key={m.month}>
                        <td>{m.month}</td>
                        <td>{compact(m.requests_per_second)}</td>
                        {data.tiers.map((t) => {
                          const cell = m.tiers[t.kind];
                          return (
                            <td
                              key={t.kind}
                              className={
                                cell.utilization_percentage > data.high_utilization_above
                                  ? "row-warn"
                                  : undefined
                              }
                            >
                              {percent(cell.utilization_percentage)} / {cell.instances_needed}
                            </td>
                          );
                        })}
                        <td>{money(m.monthly_cost_if_scaled)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </details>

          <details className="how">
            <summary>Assumptions ({data.assumptions.length + data.tiers.length})</summary>
            <ul className="hint-list">
              {data.tiers.map((t) => (
                <li key={t.kind}>
                  <strong>{t.name}:</strong> {t.assumption}
                </li>
              ))}
              {data.assumptions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
            <p className="hint">Starting traffic: {number(data.months[0].requests_per_second)} req/s.</p>
          </details>
        </>
      )}
    </div>
  );
}
