import { useState } from "react";
import { getAiHistory, getAiUsage, refineArchitecture, reviewArchitecture } from "../../api/client.js";
import { useRemote } from "../../useRemote.js";

const TABS = [
  { id: "refine", label: "Change the design" },
  { id: "review", label: "AI review" },
  { id: "usage", label: "Usage and history" },
];

const SOURCE_LABEL = {
  ai: "AI",
  rules: "Rule-based (no AI key)",
  demo: "Rule-based stand-in (no AI key)",
};

const EXAMPLES = [
  "Add a search service",
  "Make it multi-region",
  "Add monitoring",
  "Make it highly available",
];

function SourceBadge({ source, cached }) {
  return (
    <span className="ai-source">
      <span className={`badge ${source === "ai" ? "high" : "low"}`}>{SOURCE_LABEL[source] ?? source}</span>
      {cached && <span className="badge">cached</span>}
    </span>
  );
}

function DiffList({ title, items, tone }) {
  if (!items?.length) return null;
  return (
    <div className={`diff diff-${tone}`}>
      <strong>{title}</strong>
      <ul>
        {items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

function Refine({
  architecture,
  requirements,
  prompt,
  onApplyPatch,
  applying,
  onRegenerate,
  regenerating,
  regenError,
}) {
  const [text, setText] = useState("");
  const [state, setState] = useState({ loading: false, error: "", answer: null });

  async function suggest(e) {
    e?.preventDefault();
    if (!text.trim() || state.loading) return;
    setState({ loading: true, error: "", answer: null });
    try {
      const answer = await refineArchitecture(architecture, requirements, text.trim());
      setState({ loading: false, error: "", answer });
    } catch (err) {
      setState({ loading: false, error: err.message, answer: null });
    }
  }

  async function accept() {
    await onApplyPatch(state.answer.patch);
    setState({ loading: false, error: "", answer: null });
    setText("");
  }

  const { loading, error, answer } = state;
  return (
    <div>
      <form onSubmit={suggest} className="refine-form">
        <label htmlFor="refine-text">Describe a change</label>
        <div className="refine-row">
          <input
            id="refine-text"
            value={text}
            maxLength={500}
            placeholder="for example: add a search service backed by a search cluster"
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" disabled={!text.trim() || loading}>
            {loading ? "Thinking…" : "Suggest change"}
          </button>
        </div>
      </form>
      <div className="chips" aria-label="Examples">
        {EXAMPLES.map((ex) => (
          <button key={ex} type="button" className="secondary" onClick={() => setText(ex)}>
            {ex}
          </button>
        ))}
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {answer && (
        <div className="refine-answer" role="region" aria-label="Suggested change" aria-live="polite">
          <p>
            <SourceBadge source={answer.source} cached={answer.cached} /> {answer.summary}
          </p>
          {answer.patch ? (
            <>
              <DiffList title="Adds" items={answer.diff.added} tone="add" />
              <DiffList title="Removes" items={answer.diff.removed} tone="remove" />
              <DiffList title="Changes" items={answer.diff.changed} tone="change" />
              <div className="tool-actions">
                <button type="button" onClick={accept} disabled={applying}>
                  {applying ? "Applying…" : "Accept"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setState({ loading: false, error: "", answer: null })}
                >
                  Discard
                </button>
                <span className="hint">Accepting adds one step to the diagram's undo history.</span>
              </div>
            </>
          ) : (
            <p className="hint">Nothing was changed.</p>
          )}
        </div>
      )}

      <h4>Start over, keeping my edits</h4>
      <p className="hint">
        Generate again from the requirements box, with your current design as context, so the AI keeps what
        you changed. The result replaces the open design (you can undo it).
      </p>
      <button
        type="button"
        className="secondary"
        disabled={!prompt.trim() || regenerating}
        onClick={onRegenerate}
      >
        {regenerating ? "Regenerating…" : "Regenerate keeping my edits"}
      </button>
      {!prompt.trim() && <span className="hint"> Write the requirements first.</span>}
      {regenError && (
        <p className="form-error" role="alert">
          {regenError}
        </p>
      )}
    </div>
  );
}

function Review({ architecture, requirements, onApplyPatch, applying }) {
  const [state, setState] = useState({ loading: false, error: "", data: null });

  async function run() {
    setState({ loading: true, error: "", data: null });
    try {
      setState({ loading: false, error: "", data: await reviewArchitecture(architecture, requirements) });
    } catch (err) {
      setState({ loading: false, error: err.message, data: null });
    }
  }

  const { loading, error, data } = state;
  return (
    <div>
      <p className="hint">
        A second pass that critiques the design: risks, missing pieces and trade-offs, in the same form as the
        recommendations above, labelled by where they came from.
      </p>
      <button type="button" onClick={run} disabled={loading}>
        {loading ? "Reviewing…" : data ? "Review again" : "Review my design"}
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {data && (
        <div aria-live="polite">
          <p>
            <SourceBadge source={data.source} cached={data.cached} /> {data.summary}
          </p>
          {data.findings.map((f) => (
            <article key={f.id} className="tool-card">
              <h5>
                <span className={`badge ${f.severity}`}>{f.severity}</span> {f.title}
              </h5>
              <p>{f.detail}</p>
              <p>
                <strong>Suggestion:</strong> {f.recommendation}
              </p>
              {f.affected_components.length > 0 && (
                <p className="hint">Components: {f.affected_components.join(", ")}</p>
              )}
              {f.fix && onApplyPatch && (
                <button type="button" onClick={() => onApplyPatch(f.fix)} disabled={applying}>
                  {applying ? "Applying…" : f.fix.label}
                </button>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function Usage({ onUsePrompt }) {
  const [version, setVersion] = useState(0);
  const usage = useRemote(() => getAiUsage(), [version], { delay: 0 });
  const history = useRemote(() => getAiHistory(), [version], { delay: 0 });
  const u = usage.data;
  const percent = u && u.quota > 0 ? Math.min(100, Math.round((u.tokens_used / u.quota) * 100)) : 0;

  return (
    <div>
      <div className="tool-actions">
        <button type="button" className="secondary" onClick={() => setVersion((v) => v + 1)}>
          Refresh
        </button>
      </div>
      {usage.error && (
        <p className="form-error" role="alert">
          {usage.error}
        </p>
      )}
      {u && (
        <>
          <h4>This month ({u.month})</h4>
          {u.demo_mode && <p className="hint">Demo mode is on: no tokens are used.</p>}
          <div className="cards">
            <div className="card">
              <span className="card-label">Requests</span>
              <span className="card-value">{u.requests}</span>
              <span className="hint">{u.cached_requests} answered from cache</span>
            </div>
            <div className="card">
              <span className="card-label">Tokens used</span>
              <span className="card-value">{u.tokens_used.toLocaleString()}</span>
              <span className="hint">
                {u.input_tokens.toLocaleString()} in, {u.output_tokens.toLocaleString()} out
              </span>
            </div>
            <div className="card">
              <span className="card-label">Monthly allowance</span>
              <span className="card-value">{u.quota > 0 ? `${percent}%` : "No limit"}</span>
              {u.quota > 0 && (
                <progress max="100" value={percent} aria-label="Share of the monthly allowance used" />
              )}
              {u.quota > 0 && <span className="hint">of {u.quota.toLocaleString()} tokens</span>}
            </div>
          </div>
          {u.by_task.length > 0 && (
            <div className="table-scroll">
              <table className="plain-table">
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Requests</th>
                    <th>Cached</th>
                    <th>Tokens in</th>
                    <th>Tokens out</th>
                  </tr>
                </thead>
                <tbody>
                  {u.by_task.map((t) => (
                    <tr key={t.task}>
                      <td>{t.task}</td>
                      <td>{t.requests}</td>
                      <td>{t.cached}</td>
                      <td>{t.input_tokens.toLocaleString()}</td>
                      <td>{t.output_tokens.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <details className="how">
            <summary>Models in use</summary>
            <ul className="hint-list">
              {Object.entries(u.models).map(([task, model]) => (
                <li key={task}>
                  {task}: <code>{model}</code>
                </li>
              ))}
              {u.fallback_model && (
                <li>
                  fallback when the main model is busy: <code>{u.fallback_model}</code>
                </li>
              )}
            </ul>
            <p className="hint">Set per task in backend/.env (AI_MODEL_GENERATION, AI_MODEL_REVIEW, ...).</p>
          </details>
        </>
      )}

      <h4>Recent prompts</h4>
      {history.data?.items.length === 0 && <p className="hint">No designs generated yet.</p>}
      <ul className="history">
        {history.data?.items.map((h) => (
          <li key={h.id}>
            <button
              type="button"
              className="link"
              onClick={() => onUsePrompt(h.prompt)}
              title="Use this prompt"
            >
              {h.prompt.length > 110 ? `${h.prompt.slice(0, 110)}…` : h.prompt}
            </button>
            <span className="hint">
              {" "}
              {h.project_name && `${h.project_name}, `}
              {h.created_at}
              {h.rating === 1 && " · 👍"}
              {h.rating === -1 && " · 👎"}
              {h.comment && ` · “${h.comment}”`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * AI assistant: change the design from a sentence (reviewed as a diff before it is applied), get a critique,
 * regenerate while keeping edits, and see AI usage and past prompts.
 */
export default function AiAssistant({
  architecture,
  requirements,
  prompt,
  onApplyPatch,
  applying,
  onRegenerate,
  regenerating,
  regenError,
  onUsePrompt,
}) {
  const [tab, setTab] = useState("refine");

  function onKeyDown(e) {
    const index = TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    if (next === -1) return;
    e.preventDefault();
    setTab(TABS[next].id);
    document.getElementById(`ai-tab-${TABS[next].id}`)?.focus();
  }

  if (!architecture) {
    return (
      <section className="panel perf" aria-labelledby="ai-title">
        <h2 id="ai-title">AI assistant</h2>
        <p className="perf-intro">
          Generate an architecture first. Then change it by describing what you want, or ask for a review.
        </p>
      </section>
    );
  }

  return (
    <section className="panel perf ai-assistant" aria-labelledby="ai-title">
      <h2 id="ai-title">AI assistant</h2>
      <p className="perf-intro">
        Nothing here changes your design until you accept it. Suggestions say whether they came from the AI or
        from the app's own rules.
      </p>
      <div className="code-tabs" role="tablist" aria-label="AI assistant" onKeyDown={onKeyDown}>
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`ai-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls="ai-panel"
            tabIndex={tab === t.id ? 0 : -1}
            className={`code-tab${tab === t.id ? " active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="ai-panel" aria-labelledby={`ai-tab-${tab}`}>
        {tab === "refine" && (
          <Refine
            architecture={architecture}
            requirements={requirements}
            prompt={prompt}
            onApplyPatch={onApplyPatch}
            applying={applying}
            onRegenerate={onRegenerate}
            regenerating={regenerating}
            regenError={regenError}
          />
        )}
        {tab === "review" && (
          <Review
            architecture={architecture}
            requirements={requirements}
            onApplyPatch={onApplyPatch}
            applying={applying}
          />
        )}
        {tab === "usage" && <Usage onUsePrompt={onUsePrompt} />}
      </div>
    </section>
  );
}
