import { useState } from "react";

export default function ConnectionPanel({ connection, sourceName, targetName, onChange, onDelete, onClose }) {
  const [label, setLabel] = useState(connection.label ?? "");

  return (
    <aside className="panel-side">
      <div className="side-head">
        <strong>Edit connection</strong>
        <button type="button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <p>
        {sourceName} → {targetName}
      </p>
      <label>
        Label
        <input
          value={label}
          maxLength={300}
          placeholder="e.g. HTTPS, reads/writes"
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>
      <div className="side-actions">
        <button type="button" onClick={() => onChange({ label: label.trim() })}>
          Save
        </button>
        <button type="button" className="danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </aside>
  );
}
