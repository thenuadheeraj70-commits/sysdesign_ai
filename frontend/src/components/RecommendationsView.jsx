import { useState } from "react";

const SEVERITIES = ["critical", "high", "medium", "low"];
const label = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Plain-language list of what applying a fix will change. */
function describeFix(fix, nameById) {
  const lines = [];
  for (const c of fix.add_components ?? []) lines.push(`Add ${c.name} (${c.type})`);
  if (fix.add_connections?.length) {
    lines.push(`Add ${fix.add_connections.length} connection${fix.add_connections.length === 1 ? "" : "s"}`);
  }
  for (const id of fix.remove_components ?? []) lines.push(`Remove ${nameById[id] ?? id}`);
  for (const u of fix.update_components ?? []) {
    const changes = Object.entries(u.configuration)
      .map(([k, v]) => `${k} = ${v}`)
      .join(", ");
    lines.push(`${nameById[u.id] ?? u.id}: set ${changes}`);
  }
  return lines;
}

const money = (n) => `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const percent = (n) => `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;

/** Before-and-after rows for a previewed fix. "good" = an improvement, "worse" = a regression. */
function previewRows({ before, after }) {
  const tone = (a, b) => (Math.abs(a - b) < 0.05 ? "same" : a < b ? "good" : "worse"); // lower is better
  return [
    {
      label: "Monthly cost",
      from: money(before.total_monthly_cost),
      to: money(after.total_monthly_cost),
      tone: tone(after.total_monthly_cost, before.total_monthly_cost),
    },
    {
      label: "Utilization",
      from: percent(before.utilization_percentage),
      to: percent(after.utilization_percentage),
      tone: tone(after.utilization_percentage, before.utilization_percentage),
    },
    { label: "Web servers", from: before.number_of_servers, to: after.number_of_servers, tone: "same" },
    {
      label: "Open issues",
      from: before.issue_count,
      to: after.issue_count,
      tone: tone(after.issue_count, before.issue_count),
    },
  ];
}

function FixBox({ fix, nameById, onApplyFix, onPreviewFix, applying }) {
  const [preview, setPreview] = useState({ status: "idle" });

  async function showPreview() {
    setPreview({ status: "loading" });
    try {
      setPreview({ status: "ready", data: await onPreviewFix(fix) });
    } catch (err) {
      setPreview({ status: "error", message: err.message });
    }
  }

  return (
    <div className="rec-fix">
      <h4>Suggested change</h4>
      <p>{fix.label}</p>
      <ul>
        {describeFix(fix, nameById).map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>

      {preview.status === "ready" && (
        <table className="fix-preview">
          <caption>Estimated effect</caption>
          <tbody>
            {previewRows(preview.data).map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{row.from}</td>
                <td aria-hidden="true">→</td>
                <td className={`tone-${row.tone}`}>{row.to}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {preview.status === "error" && (
        <p className="form-error" role="alert">
          {preview.message}
        </p>
      )}

      <div className="fix-actions">
        <button type="button" onClick={() => onApplyFix(fix)} disabled={applying}>
          {applying ? "Applying…" : "Apply fix"}
        </button>
        {onPreviewFix && (
          <button
            type="button"
            className="secondary"
            onClick={showPreview}
            disabled={preview.status === "loading"}
          >
            {preview.status === "loading"
              ? "Calculating…"
              : preview.status === "ready"
                ? "Refresh preview"
                : "Preview impact"}
          </button>
        )}
        <span className="hint-inline">You can undo this from the diagram toolbar.</span>
      </div>
    </div>
  );
}

export default function RecommendationsView({
  data,
  nameById,
  onApplyFix,
  onPreviewFix,
  applying,
  fixError,
}) {
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

      {fixError && (
        <p className="form-error" role="alert">
          {fixError}
        </p>
      )}

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

              {r.fix && onApplyFix && (
                <FixBox
                  key={`${r.id}:${r.fix.label}`}
                  fix={r.fix}
                  nameById={nameById}
                  onApplyFix={onApplyFix}
                  onPreviewFix={onPreviewFix}
                  applying={applying}
                />
              )}

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
