import { useState } from "react";
import ApiDesign from "./ApiDesign.jsx";
import Capacity from "./Capacity.jsx";
import DataModel from "./DataModel.jsx";
import Decisions from "./Decisions.jsx";
import Learn from "./Learn.jsx";
import MultiRegion from "./MultiRegion.jsx";
import Patterns from "./Patterns.jsx";
import Reliability from "./Reliability.jsx";
import Sequences from "./Sequences.jsx";
import { GlossaryProvider } from "./glossary.jsx";

const TABS = [
  { id: "capacity", label: "Capacity" },
  { id: "api", label: "API design" },
  { id: "data", label: "Data model" },
  { id: "sequences", label: "Sequence diagrams" },
  { id: "decisions", label: "Decisions" },
  { id: "patterns", label: "Patterns" },
  { id: "reliability", label: "Reliability" },
  { id: "regions", label: "Multi-region" },
  { id: "learn", label: "Learn" },
];

/**
 * Design toolkit: the documents and calculations that usually come with a system design (capacity estimate, API
 * and data model, request flows, decision records, patterns, reliability and multi-region plans). Only the open
 * tab calculates, so the rest cost nothing.
 */
export default function Toolkit({
  architecture,
  requirements,
  onRequirementsChange,
  onApplyPatch,
  applying,
  onAddVariant,
  canAddVariant,
}) {
  const [tab, setTab] = useState("capacity");

  function onKeyDown(e) {
    const index = TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next === -1) return;
    e.preventDefault();
    setTab(TABS[next].id);
    document.getElementById(`toolkit-tab-${TABS[next].id}`)?.focus();
  }

  if (!architecture) {
    return (
      <section className="panel perf" aria-labelledby="toolkit-title">
        <h2 id="toolkit-title">Design toolkit</h2>
        <p className="perf-intro">
          Generate an architecture first. Then estimate capacity, draft the API and data model, see request
          flows, write decision records, check patterns and reliability, and plan multiple regions.
        </p>
      </section>
    );
  }

  const shared = { architecture, requirements };
  return (
    <GlossaryProvider>
      <section className="panel perf toolkit" aria-labelledby="toolkit-title">
        <h2 id="toolkit-title">Design toolkit</h2>
        <p className="perf-intro">
          Everything here is worked out from your design and requirements with simple, stated rules: no AI
          call, no cost. Treat the results as a starting point to check and edit, not as final answers.
        </p>

        <div className="code-tabs" role="tablist" aria-label="Design toolkit" onKeyDown={onKeyDown}>
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`toolkit-tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls="toolkit-panel"
              tabIndex={tab === t.id ? 0 : -1}
              className={`code-tab${tab === t.id ? " active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div role="tabpanel" id="toolkit-panel" aria-labelledby={`toolkit-tab-${tab}`}>
          {tab === "capacity" && <Capacity {...shared} onRequirementsChange={onRequirementsChange} />}
          {tab === "api" && <ApiDesign {...shared} />}
          {tab === "data" && <DataModel {...shared} />}
          {tab === "sequences" && <Sequences {...shared} />}
          {tab === "decisions" && <Decisions {...shared} />}
          {tab === "patterns" && <Patterns {...shared} onApplyPatch={onApplyPatch} applying={applying} />}
          {tab === "reliability" && (
            <Reliability
              {...shared}
              onRequirementsChange={onRequirementsChange}
              onApplyPatch={onApplyPatch}
              applying={applying}
            />
          )}
          {tab === "regions" && (
            <MultiRegion {...shared} onAddVariant={onAddVariant} canAddVariant={canAddVariant} />
          )}
          {tab === "learn" && <Learn />}
        </div>
      </section>
    </GlossaryProvider>
  );
}
