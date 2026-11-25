import { useEffect, useState } from "react";
import { getSharedDesign, sharedDiagramUrl } from "../../api/client.js";

const money = (n) =>
  `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The read-only page behind a share link. No login, no editing: the design, its diagram and its analysis. */
export default function SharedView({ token }) {
  const [state, setState] = useState({ loading: true, error: "", data: null });

  useEffect(() => {
    let alive = true;
    getSharedDesign(token)
      .then((data) => alive && setState({ loading: false, error: "", data }))
      .catch((err) => alive && setState({ loading: false, error: err.message, data: null }));
    return () => {
      alive = false;
    };
  }, [token]);

  if (state.loading) {
    return (
      <div className="app shared">
        <p className="hint">Loading…</p>
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="app shared">
        <h1>Shared design</h1>
        <p className="form-error" role="alert">
          {state.error}
        </p>
        <p>
          <a href={window.location.pathname}>Go to SysDesign AI</a>
        </p>
      </div>
    );
  }

  const { document: doc } = state.data;
  return (
    <div className="app shared">
      <header className="shared-head">
        <p className="badge">Read-only</p>
        <h1>{doc.title}</h1>
        {doc.description && <p className="lead">{doc.description}</p>}
        <p className="hint">
          Shared from SysDesign AI. Last saved {state.data.updated_at}. Figures are estimates.{" "}
          <button type="button" className="secondary" onClick={() => window.print()}>
            Print or save as PDF
          </button>{" "}
          <a href={window.location.pathname}>Open SysDesign AI</a>
        </p>
      </header>

      <section className="panel">
        <h2>Diagram</h2>
        <div className="seq-scroll">
          <img src={sharedDiagramUrl(token)} alt={`Architecture diagram of ${doc.title}`} />
        </div>
      </section>

      {doc.requirements.length > 0 && (
        <section className="panel">
          <h2>Requirements</h2>
          <table className="plain-table">
            <tbody>
              {doc.requirements.map((r, i) => (
                <tr key={i}>
                  <th scope="row">{r.label}</th>
                  <td>{r.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="panel">
        <h2>Components</h2>
        <div className="table-scroll">
          <table className="plain-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Provider</th>
                <th>Settings</th>
              </tr>
            </thead>
            <tbody>
              {doc.components.map((c, i) => (
                <tr key={i}>
                  <td>{c.name}</td>
                  <td>{c.type}</td>
                  <td>{c.provider}</td>
                  <td>{c.settings}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>Performance</h2>
        <table className="plain-table">
          <tbody>
            {doc.performance.map((p, i) => (
              <tr key={i}>
                <th scope="row">{p.label}</th>
                <td>{p.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Cost</h2>
        <div className="table-scroll">
          <table className="plain-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Quantity</th>
                <th>Unit price</th>
                <th>Monthly</th>
              </tr>
            </thead>
            <tbody>
              {doc.cost.lines.map((l, i) => (
                <tr key={i}>
                  <td>{l.name}</td>
                  <td>
                    {l.quantity} {l.unit}
                  </td>
                  <td>{money(l.unit_price)}</td>
                  <td>{money(l.monthly_cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          <strong>Total {money(doc.cost.total)} per month.</strong>
          {doc.cost.budget ? ` Budget ${money(doc.cost.budget)}: ${doc.cost.status}.` : ""}
        </p>
        <p className="hint">{doc.cost.notice}</p>
      </section>

      {doc.recommendations.length > 0 && (
        <section className="panel">
          <h2>Recommendations</h2>
          <ul className="hint-list">
            {doc.recommendations.map((r, i) => (
              <li key={i}>
                <span className={`badge ${r.severity === "critical" ? "high" : r.severity}`}>
                  {r.severity}
                </span>{" "}
                {r.issue}: {r.recommendation}
              </li>
            ))}
          </ul>
        </section>
      )}

      {doc.assumptions.length > 0 && (
        <section className="panel">
          <h2>Assumptions</h2>
          <ul className="hint-list">
            {doc.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
