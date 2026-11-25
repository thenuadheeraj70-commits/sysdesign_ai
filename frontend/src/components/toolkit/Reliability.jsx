import { estimateReliability } from "../../api/client.js";
import { useRemote } from "../../useRemote.js";
import { duration, pct } from "./files.js";
import { List, NumberField, ToolState } from "./fields.jsx";
import { GlossaryText, Term } from "./glossary.jsx";

/**
 * Estimated availability, recovery time and data-loss window, checked against targets you can set here.
 * Targets are saved with the requirements.
 */
export default function Reliability({
  architecture,
  requirements,
  onRequirementsChange,
  onApplyPatch,
  applying,
}) {
  const key = JSON.stringify([architecture, requirements]);
  const { data, loading, error } = useRemote(() => estimateReliability(architecture, requirements), [key]);
  const targets = requirements?.reliability ?? {};
  const setTarget = (name, value) => onRequirementsChange({ reliability: { ...targets, [name]: value } });

  return (
    <div className={loading ? "analysis-stale" : undefined}>
      <h4>Targets</h4>
      <div className="tool-fields">
        <NumberField
          id="rel-availability"
          label="Availability target (%)"
          value={targets.availability_percent ?? null}
          placeholder={requirements?.availability_target || "for example 99.9"}
          min={0}
          max={99.99999}
          onChange={(v) => setTarget("availability_percent", v)}
          hint="Empty: read from the requirements text."
        />
        <NumberField
          id="rel-rto"
          label="Recovery time, RTO (minutes)"
          value={targets.rto_minutes ?? null}
          placeholder="for example 15"
          min={0}
          onChange={(v) => setTarget("rto_minutes", v)}
          hint="How long you can be down after a failure."
        />
        <NumberField
          id="rel-rpo"
          label="Data loss window, RPO (minutes)"
          value={targets.rpo_minutes ?? null}
          placeholder="for example 5"
          min={0}
          onChange={(v) => setTarget("rpo_minutes", v)}
          hint="How much recent data you can afford to lose."
        />
      </div>

      {!data ? (
        <ToolState data={data} loading={loading} error={error} />
      ) : (
        <>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="cards">
            <div className="card">
              <span className="card-label">
                <Term>Availability</Term>
              </span>
              <span className="card-value">{pct(data.estimated_availability_percent)}</span>
              <span className="hint">
                about {duration(data.downtime_minutes_per_year)} down a year (
                {duration(data.downtime_minutes_per_month)} a month)
              </span>
            </div>
            <div className="card">
              <span className="card-label">
                <Term>RTO</Term> (recovery time)
              </span>
              <span className="card-value">{duration(data.estimated_rto_minutes)}</span>
              <span className="hint">{data.rto_reason}</span>
            </div>
            <div className="card">
              <span className="card-label">
                <Term>RPO</Term> (data loss)
              </span>
              <span className="card-value">{duration(data.estimated_rpo_minutes)}</span>
              <span className="hint">{data.rpo_reason}</span>
            </div>
          </div>

          <h4>Against your targets</h4>
          <List items={data.verdicts} />

          <h4>What to change</h4>
          {data.advice.map((a) => (
            <article key={a.title} className="tool-card">
              <h5>{a.title}</h5>
              <p>
                <GlossaryText>{a.detail}</GlossaryText>
              </p>
              {a.fix && onApplyPatch && (
                <button type="button" onClick={() => onApplyPatch(a.fix)} disabled={applying}>
                  {applying ? "Applying…" : a.fix.label}
                </button>
              )}
            </article>
          ))}

          <h4>Component by component</h4>
          <div className="table-scroll">
            <table className="plain-table">
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Availability</th>
                  <th>Counted in the total?</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {data.components.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td>{pct(c.availability_percent)}</td>
                    <td>{c.on_critical_path ? "yes" : "no"}</td>
                    <td>{c.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="how">
            <summary>Assumptions behind these numbers</summary>
            <List items={data.assumptions} />
          </details>
        </>
      )}
    </div>
  );
}
