import { useState } from "react";
import { useCatalog } from "../catalog.jsx";
import Explain from "./toolkit/Explain.jsx";

/** Text typed in a value box -> true/false, a number, JSON, or plain text. */
function parseValue(text) {
  const t = text.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t !== "" && !Number.isNaN(Number(t))) return Number(t);
  if (/^[[{]/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      /* keep as text */
    }
  }
  return text;
}

const showValue = (v) => (typeof v === "string" ? v : JSON.stringify(v));

const withCurrent = (list, current) => (list.includes(current) ? list : [current, ...list]);

export default function ComponentPanel({
  component,
  onChange,
  onDelete,
  onClose,
  architecture,
  requirements,
}) {
  const { types, providers } = useCatalog();
  const [name, setName] = useState(component.name);
  const [type, setType] = useState(component.type);
  const [provider, setProvider] = useState(component.provider);
  const [rows, setRows] = useState(
    Object.entries(component.configuration ?? {}).map(([k, v]) => ({ k, v: showValue(v) }))
  );

  const keys = rows.map((r) => r.k.trim()).filter(Boolean);
  const duplicate = keys.length !== new Set(keys).size;

  function setRow(i, patch) {
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  function apply() {
    if (duplicate) return;
    const configuration = {};
    for (const r of rows) {
      if (r.k.trim()) configuration[r.k.trim()] = parseValue(r.v);
    }
    onChange({
      name: name.trim() || component.name,
      type: type.trim() || component.type,
      provider: provider.trim() || component.provider,
      configuration,
    });
  }

  return (
    <aside className="panel-side">
      <div className="side-head">
        <strong>Edit component</strong>
        <button type="button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <label>
        Name
        <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Type
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {withCurrent(types, component.type).map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label>
        Provider
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          {withCurrent(providers, component.provider).map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="config-editor">
        <legend>Settings</legend>
        {rows.length === 0 && <p className="hint">No settings. Add one such as instances = 3.</p>}
        {rows.map((r, i) => (
          <div className="config-row" key={i}>
            <input
              aria-label="Setting name"
              placeholder="name"
              value={r.k}
              onChange={(e) => setRow(i, { k: e.target.value })}
            />
            <input
              aria-label="Setting value"
              placeholder="value"
              value={r.v}
              onChange={(e) => setRow(i, { v: e.target.value })}
            />
            <button
              type="button"
              aria-label="Remove setting"
              onClick={() => setRows(rows.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </div>
        ))}
        {duplicate && <p className="form-error">Setting names must be unique.</p>}
        <button type="button" className="secondary" onClick={() => setRows([...rows, { k: "", v: "" }])}>
          Add setting
        </button>
      </fieldset>

      {architecture && (
        <Explain architecture={architecture} requirements={requirements} componentId={component.id} />
      )}

      <p className="hint">ID: {component.id}</p>
      <div className="side-actions">
        <button type="button" onClick={apply} disabled={duplicate}>
          Save
        </button>
        <button type="button" className="danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </aside>
  );
}
