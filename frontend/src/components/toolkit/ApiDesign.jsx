import { designApi } from "../../api/client.js";
import { useRemote } from "../../useRemote.js";
import { List, TextActions, ToolState } from "./fields.jsx";

/** REST endpoints for the design, grouped by the service that would run them, plus the OpenAPI skeleton. */
export default function ApiDesign({ architecture, requirements }) {
  const key = JSON.stringify([architecture, requirements]);
  const { data, loading, error } = useRemote(() => designApi(architecture, requirements), [key]);
  if (!data) return <ToolState data={data} loading={loading} error={error} />;

  const openapi = JSON.stringify(data.openapi, null, 2);
  return (
    <div className={loading ? "analysis-stale" : undefined}>
      <p className="hint">
        Application type detected: <strong>{data.domain}</strong>. Base path <code>{data.base_path}</code>.
      </p>
      <List items={data.conventions} />

      {data.groups.map((g) => (
        <section key={g.name} className="tool-group">
          <h4>{g.name}</h4>
          <p className="hint">{g.description}</p>
          <div className="table-scroll">
            <table className="plain-table">
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Path</th>
                  <th>What it does</th>
                  <th>Who</th>
                  <th>Served by</th>
                </tr>
              </thead>
              <tbody>
                {g.endpoints.map((e) => (
                  <tr key={`${e.method} ${e.path}`}>
                    <td>
                      <span className={`method method-${e.method.toLowerCase()}`}>{e.method}</span>
                    </td>
                    <td>
                      <code>{e.path}</code>
                    </td>
                    <td>
                      {e.summary}
                      {(e.idempotent || e.paginated || e.note) && (
                        <div className="hint">
                          {[e.idempotent && "safe to repeat", e.paginated && "paginated", e.note]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      )}
                    </td>
                    <td>{e.auth}</td>
                    <td>{e.service || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <h4>OpenAPI skeleton</h4>
      <TextActions text={openapi} filename="openapi.json" type="application/json" label="OpenAPI" />
      <details className="how">
        <summary>Show the OpenAPI document</summary>
        <pre className="tool-code" tabIndex={0}>
          {openapi}
        </pre>
      </details>
      <List items={data.notes} />
    </div>
  );
}
