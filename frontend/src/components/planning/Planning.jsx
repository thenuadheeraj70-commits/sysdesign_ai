import { useMemo, useState } from "react";
import { forCompare } from "../../variants.js";
import BudgetAdvisor from "./BudgetAdvisor.jsx";
import CompareVariants from "./CompareVariants.jsx";
import Growth from "./Growth.jsx";
import WhatIf from "./WhatIf.jsx";

const TABS = [
  { id: "compare", label: "Compare variants" },
  { id: "whatif", label: "Traffic what-if" },
  { id: "growth", label: "Growth" },
  { id: "budget", label: "Budget advisor" },
];

/**
 * Planning tools for choosing between designs and planning ahead. They all use the same requirements and
 * overrides as the Analysis section, and update on their own when the design changes.
 */
export default function Planning({
  variants,
  activeId,
  architecture,
  requirements,
  settings,
  trafficScale,
  onSwitchVariant,
  onAddStandard,
  addingVariants,
  onApplyPatch,
  applying,
}) {
  const [tab, setTab] = useState("compare");

  const shared = useMemo(
    () => ({ requirements, capacity: settings.capacity, latency: settings.latency, trafficScale }),
    [requirements, settings.capacity, settings.latency, trafficScale]
  );
  const compareList = useMemo(() => forCompare(variants), [variants]);

  function onKeyDown(e) {
    const index = TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    if (next === -1) return;
    e.preventDefault();
    setTab(TABS[next].id);
    document.getElementById(`plan-tab-${TABS[next].id}`)?.focus();
  }

  if (!architecture) {
    return (
      <section className="panel perf" aria-labelledby="planning-title">
        <h2 id="planning-title">Planning tools</h2>
        <p className="perf-intro">
          Generate an architecture first. Then compare variants, see what happens when traffic changes,
          project growth, and find the cheapest way to fit a budget.
        </p>
      </section>
    );
  }

  return (
    <section className="panel perf" aria-labelledby="planning-title">
      <h2 id="planning-title">Planning tools</h2>
      <p className="perf-intro">
        Choose between designs and plan ahead. Everything here is an estimate from the same simple model as
        the Analysis section, using the requirements, traffic profile and discounts you set there.
      </p>

      <div className="code-tabs" role="tablist" aria-label="Planning tools" onKeyDown={onKeyDown}>
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`plan-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls="plan-panel"
            tabIndex={tab === t.id ? 0 : -1}
            className={`code-tab${tab === t.id ? " active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="plan-panel" aria-labelledby={`plan-tab-${tab}`}>
        {tab === "compare" && (
          <CompareVariants
            variants={compareList}
            shared={shared}
            activeId={activeId}
            onSwitch={onSwitchVariant}
            onAddStandard={onAddStandard}
            adding={addingVariants}
          />
        )}
        {tab === "whatif" && <WhatIf architecture={architecture} shared={shared} />}
        {tab === "growth" && <Growth architecture={architecture} shared={shared} />}
        {tab === "budget" && (
          <BudgetAdvisor
            architecture={architecture}
            shared={shared}
            onApplyPatch={onApplyPatch}
            applying={applying}
          />
        )}
      </div>
    </section>
  );
}
