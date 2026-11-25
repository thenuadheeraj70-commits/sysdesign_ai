import { getDecisions } from "../../api/client.js";
import { useRemote } from "../../useRemote.js";
import { List, TextActions, ToolState } from "./fields.jsx";
import { GlossaryText } from "./glossary.jsx";

/** One architecture decision record per major choice in the design, downloadable as Markdown. */
export default function Decisions({ architecture, requirements }) {
  const key = JSON.stringify([architecture, requirements]);
  const { data, loading, error } = useRemote(() => getDecisions(architecture, requirements), [key]);
  if (!data) return <ToolState data={data} loading={loading} error={error} />;

  return (
    <div className={loading ? "analysis-stale" : undefined}>
      <p className="hint">
        A short written record of why each choice was made and what it costs, ready to keep with the code. The
        reasons come from your requirements and what the design contains: edit them to match your own
        thinking.
      </p>
      <TextActions
        text={data.markdown}
        filename="architecture-decisions.md"
        type="text/markdown"
        label="all as Markdown"
      />

      {data.records.map((r) => (
        <article key={r.id} className="tool-card">
          <h4>
            {r.id}: {r.title} <span className="badge">{r.status}</span>
          </h4>
          <p>
            <strong>Context.</strong> <GlossaryText>{r.context}</GlossaryText>
          </p>
          <p>
            <strong>Decision.</strong> <GlossaryText>{r.decision}</GlossaryText>
          </p>
          {r.alternatives.length > 0 && (
            <div className="table-scroll">
              <table className="plain-table">
                <thead>
                  <tr>
                    <th>Alternative</th>
                    <th>For</th>
                    <th>Against</th>
                  </tr>
                </thead>
                <tbody>
                  {r.alternatives.map((a) => (
                    <tr key={a.name}>
                      <td>{a.name}</td>
                      <td>
                        <List items={a.pros} />
                      </td>
                      <td>
                        <List items={a.cons} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p>
            <strong>Consequences.</strong>
          </p>
          <List items={r.consequences} />
        </article>
      ))}
      {data.records.length === 0 && (
        <p className="hint">The design has no components to record decisions about.</p>
      )}
    </div>
  );
}
