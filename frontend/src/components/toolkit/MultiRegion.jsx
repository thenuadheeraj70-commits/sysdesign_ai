import { useState } from "react";
import { planMultiRegion } from "../../api/client.js";
import { useRemote } from "../../useRemote.js";
import { List, NumberField } from "./fields.jsx";
import { Term } from "./glossary.jsx";

const MAX_SECONDARY = 4;
const MAX_USER_ROWS = 12;

/**
 * Plan running in more than one region: choose where, see how latency changes for your users, what is copied
 * between regions and how a failover would go, and add the result as a new variant to compare.
 */
export default function MultiRegion({ architecture, requirements, onAddVariant, canAddVariant }) {
  const [primary, setPrimary] = useState("us-east-1");
  const [secondary, setSecondary] = useState([]);
  const [mode, setMode] = useState("active-passive");
  const [users, setUsers] = useState([]);
  const [added, setAdded] = useState(false);

  const options = {
    primary_region: primary,
    secondary_regions: secondary.filter((r) => r !== primary),
    mode,
    user_regions: users.filter((u) => u.region && Number.isFinite(u.percent)),
  };
  const key = JSON.stringify([architecture, requirements, options]);
  const { data, loading, error } = useRemote(
    () => planMultiRegion(architecture, requirements, options),
    [key]
  );

  const regions = data?.regions ?? [];
  const label = (code) => {
    const r = regions.find((x) => x.code === code);
    return r ? `${r.name} (${code})` : code;
  };

  const toggle = (code) =>
    setSecondary((s) =>
      s.includes(code) ? s.filter((c) => c !== code) : s.length < MAX_SECONDARY ? [...s, code] : s
    );
  const setUser = (i, patch) => setUsers((u) => u.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const totalPercent = users.reduce((sum, u) => sum + (Number(u.percent) || 0), 0);

  return (
    <div className={loading ? "analysis-stale" : undefined}>
      <p className="hint">
        Run the design in more than one <Term>Region</Term> to be closer to users and to survive the loss of a
        whole region.
      </p>

      <div className="tool-fields">
        <label className="tool-field" htmlFor="mr-primary">
          <span>Primary region</span>
          <select id="mr-primary" value={primary} onChange={(e) => setPrimary(e.target.value)}>
            {(regions.length ? regions : [{ code: primary, name: primary }]).map((r) => (
              <option key={r.code} value={r.code}>
                {r.name} ({r.code})
              </option>
            ))}
          </select>
        </label>
        <fieldset className="tool-field">
          <legend>Mode</legend>
          <label className="check">
            <input
              type="radio"
              name="mr-mode"
              checked={mode === "active-passive"}
              onChange={() => setMode("active-passive")}
            />
            <Term>Active-passive</Term>: standby region at half size
          </label>
          <label className="check">
            <input
              type="radio"
              name="mr-mode"
              checked={mode === "active-active"}
              onChange={() => setMode("active-active")}
            />
            <Term>Active-active</Term>: every region serves users
          </label>
        </fieldset>
      </div>

      <fieldset className="tool-field">
        <legend>Other regions (up to {MAX_SECONDARY})</legend>
        <div className="region-grid">
          {regions
            .filter((r) => r.code !== primary)
            .map((r) => (
              <label key={r.code} className="check">
                <input
                  type="checkbox"
                  checked={secondary.includes(r.code)}
                  disabled={!secondary.includes(r.code) && secondary.length >= MAX_SECONDARY}
                  onChange={() => toggle(r.code)}
                />
                {r.name} <span className="hint-inline">{r.code}</span>
              </label>
            ))}
        </div>
      </fieldset>

      <h4>Where your users are (optional)</h4>
      {users.map((u, i) => (
        <div key={i} className="user-row">
          <label>
            <span className="sr-only">Region of users, row {i + 1}</span>
            <select value={u.region} onChange={(e) => setUser(i, { region: e.target.value })}>
              {(regions.length ? regions : [{ code: u.region, name: u.region }]).map((r) => (
                <option key={r.code} value={r.code}>
                  {r.name} ({r.code})
                </option>
              ))}
            </select>
          </label>
          <NumberField
            id={`mr-user-${i}`}
            label="% of users"
            value={u.percent}
            min={0}
            max={100}
            onChange={(v) => setUser(i, { percent: v ?? 0 })}
          />
          <button
            type="button"
            className="secondary"
            onClick={() => setUsers((r) => r.filter((_, j) => j !== i))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="secondary"
        disabled={users.length >= MAX_USER_ROWS || regions.length === 0}
        onClick={() => setUsers((r) => [...r, { region: regions[0]?.code ?? primary, percent: 0 }])}
      >
        Add where users are
      </button>
      {users.length > 0 && totalPercent !== 100 && (
        <p className="hint">
          The shares add up to {Math.round(totalPercent * 10) / 10}%; they are scaled to 100%.
        </p>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p className="hint">{loading ? "Working it out…" : ""}</p>}

      {data && (
        <>
          {data.average_latency_before_ms !== null && (
            <div className="cards">
              <div className="card">
                <span className="card-label">
                  Average <Term>Round-trip time</Term>, primary only
                </span>
                <span className="card-value">{data.average_latency_before_ms} ms</span>
              </div>
              <div className="card">
                <span className="card-label">With these regions</span>
                <span className="card-value">{data.average_latency_after_ms} ms</span>
                {mode === "active-passive" && (
                  <span className="hint">no change: the standby does not serve users</span>
                )}
              </div>
            </div>
          )}

          {data.latency_rows.length > 0 && (
            <div className="table-scroll">
              <table className="plain-table">
                <caption className="sr-only">Latency for each group of users</caption>
                <thead>
                  <tr>
                    <th>Users in</th>
                    <th>Share</th>
                    <th>Served from</th>
                    <th>Primary only</th>
                    <th>Best</th>
                  </tr>
                </thead>
                <tbody>
                  {data.latency_rows.map((r, i) => (
                    <tr key={i}>
                      <td>{label(r.user_region)}</td>
                      <td>{r.percent}%</td>
                      <td>{label(r.nearest_region)}</td>
                      <td>{r.primary_latency_ms} ms</td>
                      <td>{r.best_latency_ms} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.links.length > 0 && (
            <>
              <h4>What is copied between regions</h4>
              <div className="table-scroll">
                <table className="plain-table">
                  <thead>
                    <tr>
                      <th>What</th>
                      <th>From → to</th>
                      <th>How</th>
                      <th>
                        <Term>Replication lag</Term>
                      </th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.links.map((l, i) => (
                      <tr key={i}>
                        <td>{l.what}</td>
                        <td>
                          {l.source_region} → {l.target_region}
                        </td>
                        <td>{l.mode}</td>
                        <td>
                          {l.mode === "not replicated"
                            ? "—"
                            : l.lag_seconds >= 60
                              ? `${Math.round(l.lag_seconds / 60)} min`
                              : `${l.lag_seconds} s`}
                        </td>
                        <td>{l.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <h4>
            If a region fails (<Term>Failover</Term>)
          </h4>
          <ol className="hint-list">
            {data.failover.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>

          <h4>Multi-region variant</h4>
          <List items={data.changes} />
          {data.architecture && (
            <div className="tool-actions">
              <button
                type="button"
                disabled={!canAddVariant || added}
                onClick={() => {
                  onAddVariant(
                    `Multi-region (${[primary, ...options.secondary_regions].join(", ")})`,
                    data.architecture
                  );
                  setAdded(true);
                  setTimeout(() => setAdded(false), 1500);
                }}
              >
                {added ? "Added" : "Add as a new variant"}
              </button>
              {!canAddVariant && (
                <span className="hint">Remove a variant first: the limit has been reached.</span>
              )}
            </div>
          )}
          <details className="how">
            <summary>About these estimates</summary>
            <List items={data.notes} />
          </details>
        </>
      )}
    </div>
  );
}
