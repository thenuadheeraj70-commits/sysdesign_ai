import { useState } from "react";
import { useGlossary } from "./glossary.jsx";

/** Plain-language definitions of every term used in the tools. */
export default function Learn() {
  const glossary = useGlossary();
  const [q, setQ] = useState("");
  const all = [...glossary.values()].sort((a, b) => a.term.localeCompare(b.term));
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? all.filter((t) => t.term.toLowerCase().includes(needle) || t.definition.toLowerCase().includes(needle))
    : all;

  return (
    <div>
      <p className="hint">
        Terms from the tools above appear underlined wherever they are used: hover or focus one to see its
        meaning. Select a component in the diagram and choose “Explain this component” for a walkthrough of
        it.
      </p>
      <label className="tool-field" htmlFor="glossary-search">
        <span>Search terms</span>
        <input id="glossary-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      {all.length === 0 && <p className="hint">The glossary could not be loaded.</p>}
      <dl className="glossary">
        {shown.map((t) => (
          <div key={t.term}>
            <dt>{t.term}</dt>
            <dd>{t.definition}</dd>
          </div>
        ))}
      </dl>
      {all.length > 0 && shown.length === 0 && <p className="hint">No term matches “{q}”.</p>}
    </div>
  );
}
