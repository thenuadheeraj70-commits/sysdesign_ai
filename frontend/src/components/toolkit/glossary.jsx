import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { getGlossary } from "../../api/client.js";

const GlossaryContext = createContext(new Map());

/** Loads the glossary once so any text under it can show a definition when a term is hovered or focused. */
export function GlossaryProvider({ children }) {
  const [terms, setTerms] = useState([]);
  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => getGlossary())
      .then((r) => alive && setTerms(r.terms ?? []))
      .catch(() => {}); // tooltips are a bonus; the tools work without them
    return () => {
      alive = false;
    };
  }, []);
  const map = useMemo(() => new Map(terms.map((t) => [t.term.toLowerCase(), t])), [terms]);
  return <GlossaryContext.Provider value={map}>{children}</GlossaryContext.Provider>;
}

export const useGlossary = () => useContext(GlossaryContext);

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** One term, underlined, with its definition on hover and keyboard focus. */
export function Term({ children, name }) {
  const glossary = useGlossary();
  const entry = glossary.get(String(name ?? children).toLowerCase());
  if (!entry) return <>{children}</>;
  return (
    <span className="term" tabIndex={0} data-definition={entry.definition} title={entry.definition}>
      {children}
    </span>
  );
}

/** Text in which the first mention of each glossary term gets a definition tip. */
export function GlossaryText({ children }) {
  const glossary = useGlossary();
  const text = typeof children === "string" ? children : "";
  const parts = useMemo(() => {
    if (!text || glossary.size === 0) return [text];
    // Longer terms first so "read replica" wins over "replica".
    const names = [...glossary.keys()].sort((a, b) => b.length - a.length).map(escapeRegex);
    const pattern = new RegExp(String.raw`\b(${names.join("|")})(?:e?s)?\b`, "gi");
    const seen = new Set();
    const out = [];
    let last = 0;
    for (const m of text.matchAll(pattern)) {
      const key = m[1].toLowerCase(); // the term itself: "indexes" counts as "index"
      if (seen.has(key)) continue;
      seen.add(key);
      if (m.index > last) out.push(text.slice(last, m.index));
      out.push({ text: m[0], name: m[1] });
      last = m.index + m[0].length;
    }
    out.push(text.slice(last));
    return out;
  }, [text, glossary]);
  if (typeof children !== "string") return <>{children}</>;
  return (
    <>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          p
        ) : (
          <Term key={i} name={p.name}>
            {p.text}
          </Term>
        )
      )}
    </>
  );
}
