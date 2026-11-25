import { compareVariants } from "../../api/client.js";
import { useRemote } from "../../useRemote.js";
import { money, number, percent } from "./format.js";

const SEVERITIES = ["critical", "high", "medium", "low"];

/**
 * One table for all variants: cost, utilization, issues and resilience side by side, ranked, with a
 * recommendation. Updates on its own when a variant or the requirements change.
 */
export default function CompareVariants({ variants, shared, activeId, onSwitch, onAddStandard, adding }) {
  const key = JSON.stringify([variants, shared.requirements, shared.capacity, shared.latency]);
  const { data, loading, error } = useRemote(() => compareVariants(variants, shared), [key], {
    enabled: variants.length > 0,
  });

  if (variants.length < 2) {
    return (
      <div className="planning-empty">
        <p>
          Add a second variant to compare designs. Use <strong>Add variant</strong> above the diagram, or
          create the three standard ones at once.
        </p>
        <button type="button" onClick={onAddStandard} disabled={adding}>
          {adding ? "Creating…" : "Create Cheap, Balanced and Highly available variants"}
        </button>
      </div>
    );
  }

  const rows = data?.variants ?? [];
  const anyScaled = variants.some((v) => v.traffic_scale !== 1);
  const anyBudget = rows.some((r) => r.budget_status);
  const anyDiscount = rows.some((r) => r.discount_savings > 0);

  const metrics = [
    anyScaled && { label: "Traffic served", cell: (r) => `${number(r.requests_per_second)} req/s` },
    { label: "Components", cell: (r) => r.component_count },
    { label: "Web servers", cell: (r) => r.number_of_servers },
    {
      label: "Utilization",
      cell: (r) => (
        <>
          {percent(r.utilization_percentage)}{" "}
          <span className={`badge ${r.status.toLowerCase()}`}>{r.status}</span>
        </>
      ),
    },
    {
      label: "Monthly cost",
      className: (r) => (r.cost_rank === 1 ? "best" : ""),
      cell: (r) => (
        <>
          <strong>{money(r.monthly_cost)}</strong>
          {r.cost_rank === 1 && <small className="rank-note">cheapest</small>}
        </>
      ),
    },
    anyBudget && {
      label: "Budget",
      cell: (r) =>
        r.budget_status ? (
          <span className={`badge ${r.budget_status === "Over budget" ? "high" : "low"}`}>
            {r.budget_status}
          </span>
        ) : (
          "—"
        ),
    },
    anyDiscount && {
      label: "Discounts save",
      cell: (r) => (r.discount_savings > 0 ? money(r.discount_savings) : "—"),
    },
    {
      label: "Open issues",
      cell: (r) =>
        SEVERITIES.some((s) => r.issues[s] > 0) ? (
          <span className="issue-chips">
            {SEVERITIES.filter((s) => r.issues[s] > 0).map((s) => (
              <span key={s} className={`sev-badge ${s}`}>
                {r.issues[s]} {s}
              </span>
            ))}
          </span>
        ) : (
          "None"
        ),
    },
    { label: "Single points of failure", cell: (r) => r.single_points_of_failure },
    {
      label: "Resilience (0 to 100)",
      className: (r) => (r.resilience_rank === 1 ? "best" : ""),
      cell: (r) => (
        <>
          <span className="score-bar" aria-hidden="true">
            <i style={{ width: `${r.resilience_score}%` }} />
          </span>
          <strong>{r.resilience_score}</strong>
          {r.resilience_rank === 1 && <small className="rank-note">most resilient</small>}
        </>
      ),
    },
    { label: "Rank by cost / resilience", cell: (r) => `${r.cost_rank} / ${r.resilience_rank}` },
  ].filter(Boolean);

  return (
    <div className={loading ? "analysis-stale" : undefined}>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {data && (
        <>
          {data.recommendation && (
            <p className="recommendation compare-recommendation">
              <strong>Suggestion.</strong> {data.recommendation}
            </p>
          )}
          <div className="table-scroll">
            <table className="compare-table">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">Measure</span>
                  </th>
                  {rows.map((r) => (
                    <th key={r.id} scope="col" className={r.id === activeId ? "active-column" : undefined}>
                      <div className="variant-heading">
                        <span>{r.name}</span>
                        {r.id === data.recommended_id && <span className="tag">Recommended</span>}
                        {r.id === activeId ? (
                          <span className="tag muted">Open</span>
                        ) : (
                          <button type="button" className="secondary" onClick={() => onSwitch(r.id)}>
                            Open
                          </button>
                        )}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {metrics.map((m) => (
                  <tr key={m.label}>
                    <th scope="row">{m.label}</th>
                    {rows.map((r) =>
                      r.error ? (
                        <td key={r.id} className="cell-error">
                          —
                        </td>
                      ) : (
                        <td
                          key={r.id}
                          className={`${m.className?.(r) ?? ""} ${r.id === activeId ? "active-column" : ""}`}
                        >
                          {m.cell(r)}
                        </td>
                      )
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows
            .filter((r) => r.error)
            .map((r) => (
              <p key={r.id} className="form-error">
                {r.name} could not be analyzed: {r.error}
              </p>
            ))}
          <ul className="hint-list">
            {data.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
            <li>
              Resilience starts at 100 and loses 30 per critical issue, 15 per high, 7 per medium and 2 per
              low issue found by the rule-based checks. It is a rough guide, not a measurement.
            </li>
          </ul>
        </>
      )}
      {!data && loading && <p className="hint">Comparing…</p>}
    </div>
  );
}
