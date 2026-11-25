import { useState } from "react";

const MAX_ASSUMPTIONS = 50;

/** Edit the project name, description and assumptions of the current design. */
export default function DetailsEditor({ architecture, onSave, onCancel }) {
  const [name, setName] = useState(architecture.project_name);
  const [description, setDescription] = useState(architecture.description ?? "");
  const [assumptions, setAssumptions] = useState(architecture.assumptions ?? []);

  const setAssumption = (i, value) => setAssumptions(assumptions.map((a, j) => (j === i ? value : a)));

  function submit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    onSave({
      project_name: name.trim(),
      description: description.trim(),
      assumptions: assumptions.map((a) => a.trim()).filter(Boolean),
    });
  }

  return (
    <form className="details-editor" onSubmit={submit}>
      <div className="field">
        <label htmlFor="d-name">Project name</label>
        <input id="d-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        {!name.trim() && <span className="form-error">A project name is required.</span>}
      </div>
      <div className="field">
        <label htmlFor="d-desc">Description</label>
        <textarea id="d-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>

      <fieldset className="config-editor">
        <legend>Assumptions</legend>
        {assumptions.length === 0 && <p className="hint">No assumptions yet.</p>}
        {assumptions.map((a, i) => (
          <div className="assumption-row" key={i}>
            <input
              aria-label={`Assumption ${i + 1}`}
              value={a}
              onChange={(e) => setAssumption(i, e.target.value)}
            />
            <button
              type="button"
              aria-label={`Remove assumption ${i + 1}`}
              onClick={() => setAssumptions(assumptions.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="secondary"
          disabled={assumptions.length >= MAX_ASSUMPTIONS}
          onClick={() => setAssumptions([...assumptions, ""])}
        >
          Add assumption
        </button>
      </fieldset>

      <div className="side-actions">
        <button type="submit" disabled={!name.trim()}>
          Save details
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
