import { designDataModel } from "../../api/client.js";
import { useRemote } from "../../useRemote.js";
import { List, TextActions, ToolState } from "./fields.jsx";

const KEY_LABEL = { pk: "primary key", fk: "foreign key", unique: "unique" };

/** Tables or collections for the design's database, how they relate, and the SQL and ER diagram text. */
export default function DataModel({ architecture, requirements }) {
  const key = JSON.stringify([architecture, requirements]);
  const { data, loading, error } = useRemote(() => designDataModel(architecture, requirements), [key]);
  if (!data) return <ToolState data={data} loading={loading} error={error} />;

  return (
    <div className={loading ? "analysis-stale" : undefined}>
      <p className="hint">
        Application type detected: <strong>{data.domain}</strong>. Database: <strong>{data.dialect}</strong>.
      </p>

      <div className="tool-cards">
        {data.entities.map((e) => (
          <article key={e.name} className="tool-card">
            <h4>
              {e.name} <span className="badge">{e.store}</span>
            </h4>
            <p className="hint">{e.description}</p>
            <table className="plain-table">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Type</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {e.fields.map((f) => (
                  <tr key={f.name}>
                    <td>
                      <code>{f.name}</code>
                    </td>
                    <td>{f.type}</td>
                    <td>
                      {[
                        f.key && KEY_LABEL[f.key],
                        f.references && `refers to ${f.references}`,
                        f.nullable && "optional",
                        f.note,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {e.indexes.length > 0 && <p className="hint">Indexes: {e.indexes.join("; ")}</p>}
            {e.note && <p className="hint">{e.note}</p>}
          </article>
        ))}
      </div>

      <h4>Relations</h4>
      <List
        items={data.relations.map(
          (r) => `${r.source} → ${r.target}: ${r.kind}${r.via ? ` (through ${r.via})` : ""}`
        )}
      />

      <h4>ER diagram (Mermaid)</h4>
      <p className="hint">Paste this into any Mermaid viewer, GitHub or documentation site to draw it.</p>
      <TextActions text={data.mermaid} filename="data-model.mmd" label="Mermaid" />
      <pre className="tool-code" tabIndex={0}>
        {data.mermaid}
      </pre>

      {data.sql ? (
        <>
          <h4>SQL ({data.dialect})</h4>
          <TextActions text={data.sql} filename="schema.sql" label="SQL" />
          <details className="how">
            <summary>Show the SQL</summary>
            <pre className="tool-code" tabIndex={0}>
              {data.sql}
            </pre>
          </details>
        </>
      ) : (
        <p className="hint">The design has no relational database, so no SQL is generated.</p>
      )}
      <List items={data.notes} />
    </div>
  );
}
