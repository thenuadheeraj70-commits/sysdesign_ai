import { getPatterns } from "../../api/client.js";
import { useRemote } from "../../useRemote.js";
import { ToolState } from "./fields.jsx";
import { GlossaryText } from "./glossary.jsx";

const GROUPS = [
  { status: "recommended", title: "Recommended for this design" },
  { status: "consider", title: "Worth considering" },
  { status: "in place", title: "Already in your design" },
  { status: "not needed", title: "Not needed yet" },
];

function PatternCard({ p, onApplyPatch, applying }) {
  return (
    <article className="tool-card">
      <h5>{p.name}</h5>
      <p>
        <GlossaryText>{p.summary}</GlossaryText>
      </p>
      <p>
        <strong>In your design:</strong> <GlossaryText>{p.why}</GlossaryText>
      </p>
      <details className="how">
        <summary>When to use it, when not to, and the trade-offs</summary>
        <p>
          <strong>Use it when:</strong> {p.when_to_use}
        </p>
        <p>
          <strong>Skip it when:</strong> {p.when_not_to}
        </p>
        <p>
          <strong>Trade-offs:</strong> {p.trade_offs}
        </p>
        <p>
          <strong>What it looks like here:</strong> {p.how}
        </p>
      </details>
      {p.fix && onApplyPatch && (
        <button type="button" onClick={() => onApplyPatch(p.fix)} disabled={applying}>
          {applying ? "Applying…" : p.fix.label}
        </button>
      )}
    </article>
  );
}

/** Well-known design patterns: which the design uses, which it would benefit from, and which it does not need. */
export default function Patterns({ architecture, requirements, onApplyPatch, applying }) {
  const key = JSON.stringify([architecture, requirements]);
  const { data, loading, error } = useRemote(() => getPatterns(architecture, requirements), [key]);
  if (!data) return <ToolState data={data} loading={loading} error={error} />;

  return (
    <div className={loading ? "analysis-stale" : undefined}>
      <p className="hint">
        Each pattern comes with the evidence from your design, so a suggestion is never just a name. Where a
        pattern adds something to the diagram, you can apply it with one click (undo with the diagram's Undo).
      </p>
      {GROUPS.map((g) => {
        const items = data.patterns.filter((p) => p.status === g.status);
        if (items.length === 0) return null;
        return (
          <section key={g.status} className="tool-group">
            <h4>
              {g.title} <span className="badge">{items.length}</span>
            </h4>
            <div className="tool-cards">
              {items.map((p) => (
                <PatternCard key={p.id} p={p} onApplyPatch={onApplyPatch} applying={applying} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
