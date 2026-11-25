import { useState } from "react";
import { MAX_VARIANTS } from "../variants.js";

// What "Add variant" offers. `copy` duplicates the open design; the rest are built by the backend.
const ADD_CHOICES = [
  { kind: "copy", label: "Copy of this design", hint: "Same design, to try other changes on" },
  { kind: "cheap", label: "Cheap", hint: "Fewest servers, no redundancy" },
  { kind: "balanced", label: "Balanced", hint: "Headroom, multi-zone database, load balancer" },
  { kind: "highly_available", label: "Highly available", hint: "Spare capacity and redundancy everywhere" },
  { kind: "dev", label: "Development", hint: "One of everything, 2% of the traffic" },
  { kind: "staging", label: "Staging", hint: "Half the instances, 25% of the traffic" },
  { kind: "production", label: "Production", hint: "Production-grade version of this design" },
];

/**
 * Tabs for the project's design variants, with the actions on the open one: add (copy or preset), rename,
 * duplicate, delete, and the share of the traffic it serves.
 */
export default function VariantBar({
  variants,
  activeId,
  busy,
  error,
  onSwitch,
  onAdd,
  onRename,
  onDuplicate,
  onDelete,
  onTrafficShare,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(null); // text being typed, or null
  const active = variants.find((v) => v.id === activeId) ?? variants[0];
  const full = variants.length >= MAX_VARIANTS;
  const [shareText, setShareText] = useState(null); // percentage being typed, or null to show the saved one

  function submitRename(e) {
    e.preventDefault();
    const name = renaming.trim();
    if (name) onRename(active.id, name);
    setRenaming(null);
  }

  function onShareChange(e) {
    const text = e.target.value;
    setShareText(text);
    const percent = Number(text);
    if (text.trim() !== "" && Number.isFinite(percent) && percent >= 0.1 && percent <= 100000) {
      onTrafficShare(active.id, percent / 100);
    }
  }

  const sharePercent = Math.round(active.trafficScale * 10000) / 100;

  return (
    <div className="variant-bar" role="group" aria-label="Design variants">
      <div className="variant-tabs" role="tablist" aria-label="Variants of this design">
        {variants.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={v.id === activeId}
            className={`variant-tab${v.id === activeId ? " active" : ""}`}
            onClick={() => {
              setRenaming(null);
              setShareText(null);
              onSwitch(v.id);
            }}
          >
            {v.name}
            {v.trafficScale !== 1 && <small> · {Math.round(v.trafficScale * 10000) / 100}% traffic</small>}
          </button>
        ))}

        <div className="variant-add">
          <button
            type="button"
            className="secondary"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            disabled={full || busy}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {busy ? "Adding…" : full ? `Limit of ${MAX_VARIANTS} reached` : "Add variant"}
          </button>
          {menuOpen && (
            <ul className="variant-menu" role="menu">
              {ADD_CHOICES.map((choice) => (
                <li key={choice.kind} role="none">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onAdd(choice.kind);
                    }}
                  >
                    <strong>{choice.label}</strong>
                    <span>{choice.hint}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="variant-actions">
        {renaming === null ? (
          <>
            <button type="button" className="secondary" onClick={() => setRenaming(active.name)}>
              Rename
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => onDuplicate(active.id)}
              disabled={full || busy}
            >
              Duplicate
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => onDelete(active.id)}
              disabled={variants.length === 1}
              title={variants.length === 1 ? "A project needs at least one design" : undefined}
            >
              Delete variant
            </button>
          </>
        ) : (
          <form className="inline-edit" onSubmit={submitRename}>
            <input
              aria-label="Variant name"
              autoFocus
              value={renaming}
              maxLength={60}
              onChange={(e) => setRenaming(e.target.value)}
            />
            <button type="submit" disabled={!renaming.trim()}>
              Save name
            </button>
            <button type="button" className="secondary" onClick={() => setRenaming(null)}>
              Cancel
            </button>
          </form>
        )}

        <label className="variant-share">
          Traffic this design serves (% of peak)
          <input
            type="number"
            min="0.1"
            max="100000"
            step="any"
            value={shareText ?? sharePercent}
            onChange={onShareChange}
            onBlur={() => setShareText(null)}
          />
        </label>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
