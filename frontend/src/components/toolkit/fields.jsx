import { useState } from "react";
import { copyText, downloadText } from "./files.js";

/**
 * A number box that can be emptied. It keeps what is being typed ("12." or "") until the box loses focus,
 * and reports a number, or null when empty.
 */
export function NumberField({ id, label, value, placeholder, onChange, min, max, step = "any", hint }) {
  const [draft, setDraft] = useState(null);
  const shown = draft ?? value ?? "";
  return (
    <label className="tool-field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={shown}
        placeholder={placeholder}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = e.target.value === "" ? null : Number(e.target.value);
          if (n === null || Number.isFinite(n)) onChange(n);
        }}
        onBlur={() => setDraft(null)}
      />
      {hint && <small className="hint">{hint}</small>}
    </label>
  );
}

/** Copy and download buttons for a piece of generated text. */
export function TextActions({ text, filename, type, label }) {
  const [state, setState] = useState("");
  async function copy() {
    setState((await copyText(text)) ? "Copied" : "Copy failed: select the text and copy it yourself");
    setTimeout(() => setState(""), 2500);
  }
  return (
    <div className="tool-actions">
      <button type="button" className="secondary" onClick={copy}>
        Copy {label}
      </button>
      <button type="button" className="secondary" onClick={() => downloadText(filename, text, type)}>
        Download {filename}
      </button>
      <span className="hint" role="status" aria-live="polite">
        {state}
      </span>
    </div>
  );
}

/** Loading and error states shared by every tool. */
export function ToolState({ data, loading, error }) {
  if (error) {
    return (
      <p className="form-error" role="alert">
        {error}
      </p>
    );
  }
  if (!data) return <p className="hint">{loading ? "Working it out…" : ""}</p>;
  return null;
}

export function List({ items, className = "hint-list" }) {
  if (!items?.length) return null;
  return (
    <ul className={className}>
      {items.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  );
}
