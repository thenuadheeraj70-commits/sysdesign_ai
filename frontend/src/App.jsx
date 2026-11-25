import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyFix,
  createPreset,
  extractRequirements,
  fetchMe,
  generateArchitecture,
  getToken,
  regenerateArchitecture,
  setToken,
  setUnauthorizedHandler,
} from "./api/client.js";
import AiAssistant from "./components/ai/AiAssistant.jsx";
import ExportShare from "./components/export/ExportShare.jsx";
import SharedView from "./components/export/SharedView.jsx";
import { GenerationFeedback, ImportDocument } from "./components/ai/PromptTools.jsx";
import AuthForm from "./components/AuthForm.jsx";
import Projects from "./components/Projects.jsx";
import ArchitectureDiagram from "./components/ArchitectureDiagram.jsx";
import ComponentPanel from "./components/ComponentPanel.jsx";
import ConnectionPanel from "./components/ConnectionPanel.jsx";
import DetailsEditor from "./components/DetailsEditor.jsx";
import Analysis from "./components/Analysis.jsx";
import InfrastructureCode from "./components/InfrastructureCode.jsx";
import VariantBar from "./components/VariantBar.jsx";
import Planning from "./components/planning/Planning.jsx";
import Toolkit from "./components/toolkit/Toolkit.jsx";
import { CatalogProvider } from "./catalog.jsx";
import { newComponentId } from "./layout.js";
import {
  canRedo,
  canUndo,
  commit as commitChange,
  redo as redoChange,
  undo as undoChange,
} from "./history.js";
import {
  FIRST_ID,
  MAX_VARIANTS,
  designOf,
  fromProject,
  movedSinceSave,
  newVariant,
  randomVariantId,
  toSaved,
  uniqueName,
  updateVariant,
} from "./variants.js";

const MAX_LENGTH = 5000; // matches ArchitectureRequest.prompt max_length

// Every requirement field, so editing one on a design that has none yet still sends a full object.
const EMPTY_REQUIREMENTS = {
  application_type: "",
  expected_users: null,
  peak_requests_per_second: null,
  availability_target: "",
  monthly_budget: null,
  cloud_provider: "",
  region: "",
  notes: [],
  reliability: {},
  capacity_inputs: {},
};

/** The token in a share link (?shared=...), or null. */
function sharedToken() {
  try {
    return new URLSearchParams(window.location.search).get("shared");
  } catch {
    return null;
  }
}

export default function App() {
  const token = sharedToken();
  // A share link opens a read-only page for anyone, with no login.
  if (token) return <SharedView token={token} />;
  return <MainApp />;
}

function MainApp() {
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(!getToken());

  function logout() {
    setToken(null);
    setUser(null);
  }

  // Restore a previous login, and drop back to the login screen if the token expires.
  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (!getToken()) return;
    fetchMe()
      .then(setUser)
      .catch(() => setToken(null))
      .finally(() => setAuthChecked(true));
  }, []);

  if (!authChecked)
    return (
      <div className="app">
        <p className="hint">Loading…</p>
      </div>
    );
  if (!user) {
    return (
      <AuthForm
        onAuthenticated={({ token, user: u }) => {
          setToken(token);
          setUser(u);
        }}
      />
    );
  }
  return (
    <CatalogProvider>
      <Workspace user={user} onLogout={logout} />
    </CatalogProvider>
  );
}

function Workspace({ user, onLogout }) {
  const [prompt, setPrompt] = useState("");
  // Every design variant of this project, each with its own architecture, undo history and positions.
  // Every edit goes through commit(), which applies to the open variant.
  const [variants, setVariants] = useState(() => [newVariant(FIRST_ID, "Original")]);
  const [activeId, setActiveId] = useState(FIRST_ID);
  const active = variants.find((v) => v.id === activeId) ?? variants[0];
  const history = active.history;
  const result = history.present;
  const positions = active.positions;
  const initialPositions = active.initialPositions;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [selectedEdge, setSelectedEdge] = useState(null); // { source, target }
  const [projectId, setProjectId] = useState(null); // saved project this design belongs to
  const [requirements, setRequirements] = useState(null); // extracted from the prompt, then edited
  const [reqStatus, setReqStatus] = useState("idle"); // idle | loading | ready | failed
  const [resultKey, setResultKey] = useState(0); // remounts the diagram for each new result
  const [applying, setApplying] = useState(false);
  const [fixError, setFixError] = useState("");
  const [editingDetails, setEditingDetails] = useState(false);
  // Capacity per server and latency typed in the Analysis section, shared with the planning tools.
  const [settings, setSettings] = useState({ capacity: null, latency: null });
  const [addingVariants, setAddingVariants] = useState(false);
  const [variantError, setVariantError] = useState("");
  // What the saved copy looked like, to tell whether there are unsaved changes.
  const [baseline, setBaseline] = useState(null);
  const [progress, setProgress] = useState(0); // characters written so far while generating
  const [generated, setGenerated] = useState(null); // { prompt, cached } of the last generation, for feedback
  const [regenerating, setRegenerating] = useState(false);
  const [regenError, setRegenError] = useState("");

  const reqToken = useRef(0); // ignores requirement results from an older prompt
  const activeIdRef = useRef(activeId); // lets the (stable) positions callback know which variant is open
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const canSubmit = prompt.trim().length > 0 && !loading;

  const handlePositions = useCallback(
    (map) =>
      setVariants((vs) =>
        updateVariant(vs, activeIdRef.current, (v) =>
          JSON.stringify(v.positions) === JSON.stringify(map) ? v : { ...v, positions: map }
        )
      ),
    []
  );

  // ---- unsaved changes ----
  const makeBaseline = (list, reqs) => ({
    design: JSON.stringify([designOf(list), reqs ?? null]),
    positions: list.map((v) => ({ id: v.id, positions: v.positions })),
  });
  const changedSinceSave =
    Boolean(result && projectId && baseline) &&
    (JSON.stringify([designOf(variants), requirements ?? null]) !== baseline.design ||
      // Positions only count for variants whose saved copy has some (older saves have none).
      movedSinceSave(variants, baseline.positions));
  const hasUnsavedWork = Boolean(result) && (!projectId || changedSinceSave);

  useEffect(() => {
    if (!hasUnsavedWork) return undefined;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasUnsavedWork]);

  const confirmDiscard = () =>
    !hasUnsavedWork ||
    window.confirm("The design on screen has changes that are not saved. Continue and lose them?");

  // ---- history (of the open variant) ----
  const replace = (architecture) => {
    setVariants([newVariant(FIRST_ID, "Original", architecture)]);
    setActiveId(FIRST_ID);
  };
  const commitTo = (id, change) =>
    setVariants((vs) => updateVariant(vs, id, (v) => ({ ...v, history: commitChange(v.history, change) })));
  const commit = (change) => commitTo(activeId, change);
  const undo = () =>
    setVariants((vs) => updateVariant(vs, activeId, (v) => ({ ...v, history: undoChange(v.history) })));
  const redo = () =>
    setVariants((vs) => updateVariant(vs, activeId, (v) => ({ ...v, history: redoChange(v.history) })));

  // ---- generating ----
  async function handleGenerate() {
    if (!canSubmit) return;
    if (!confirmDiscard()) return;
    setLoading(true);
    setError("");
    const text = prompt.trim();
    setProgress(0);
    setGenerated(null);
    try {
      const meta = {};
      const architecture = await generateArchitecture(text, { onProgress: setProgress, meta });
      setGenerated({ prompt: text, cached: Boolean(meta.cached) });
      replace(architecture);
      setProjectId(null);
      setBaseline(null);
      setSettings({ capacity: null, latency: null });
      setVariantError("");
      setEditingDetails(false);
      setSelectedId(null);
      setSelectedEdge(null);
      setResultKey((k) => k + 1);
      // Requirements are read in the background; the analysis starts once they arrive.
      setRequirements(null);
      setReqStatus("loading");
      const token = ++reqToken.current;
      extractRequirements(text)
        .then((r) => {
          if (token === reqToken.current) {
            setRequirements(r);
            setReqStatus("ready");
          }
        })
        .catch(() => {
          if (token === reqToken.current) setReqStatus("failed");
        });
    } catch (err) {
      replace(null);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  /** Load a saved project into the workspace (also used after restoring an older version). */
  function openProject(p) {
    reqToken.current += 1; // ignore any extraction still in flight
    const opened = fromProject(p);
    setPrompt(p.prompt);
    setVariants(opened.variants);
    setActiveId(opened.activeId);
    setRequirements(p.requirements);
    setReqStatus(p.requirements ? "ready" : "idle");
    setBaseline(makeBaseline(opened.variants, p.requirements));
    setSettings({ capacity: null, latency: null });
    setVariantError("");
    setEditingDetails(false);
    setSelectedId(null);
    setSelectedEdge(null);
    setProjectId(p.id);
    setResultKey((k) => k + 1);
    setError("");
    setGenerated(null);
  }

  /** Load a design from a file as a new, unsaved design. */
  function importDesignFile(architecture, reqs) {
    if (!confirmDiscard()) return false;
    reqToken.current += 1;
    replace(architecture);
    setProjectId(null);
    setBaseline(null);
    setSettings({ capacity: null, latency: null });
    setVariantError("");
    setEditingDetails(false);
    setSelectedId(null);
    setSelectedEdge(null);
    setResultKey((k) => k + 1);
    setRequirements(reqs ?? null);
    setReqStatus(reqs ? "ready" : "idle");
    setError("");
    setGenerated(null);
    return true;
  }

  /** Generate again from the prompt with the open design as context, so the user's edits are kept. */
  async function handleRegenerate() {
    if (!result || regenerating || !prompt.trim()) return;
    const id = activeId;
    setRegenerating(true);
    setRegenError("");
    try {
      const updated = await regenerateArchitecture(prompt.trim(), result);
      commitTo(id, () => updated); // one undo step brings the old design back
    } catch (err) {
      setRegenError(err.message);
    } finally {
      setRegenerating(false);
    }
  }

  // ---- editing the architecture ----
  const updateComponent = (id, patch) =>
    commit((r) => ({ ...r, components: r.components.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));

  const updateDetails = (patch) => {
    commit((r) => ({ ...r, ...patch }));
    setEditingDetails(false);
  };

  // Removing components and connections is ONE history step however it was triggered, so a single
  // Undo brings back everything a delete took away (a component and the connections it had).
  function deleteSelection(ids, links) {
    const gone = new Set(ids);
    commit((r) => {
      const components = r.components.filter((c) => !gone.has(c.id));
      const connections = r.connections.filter(
        (c) => !gone.has(c.source) && !gone.has(c.target) && !links.some((l) => sameLink(l)(c))
      );
      if (components.length === r.components.length && connections.length === r.connections.length) return r;
      return { ...r, components, connections };
    });
    setSelectedId((s) => (gone.has(s) ? null : s));
    setSelectedEdge(null);
  }
  const deleteComponents = (ids) => deleteSelection(ids, []);
  const deleteConnections = (links) => deleteSelection([], links);

  function addComponent({ name, type, provider }) {
    const id = newComponentId(name, new Set(result.components.map((c) => c.id)));
    commit((r) => ({ ...r, components: [...r.components, { id, name, type, provider, configuration: {} }] }));
    setSelectedEdge(null);
    setSelectedId(id);
  }

  function addConnection(source, target) {
    if (!source || !target || source === target) return;
    commit((r) =>
      r.connections.some((c) => c.source === source && c.target === target)
        ? r
        : { ...r, connections: [...r.connections, { source, target, label: "" }] }
    );
  }

  const sameLink = (a) => (c) => c.source === a.source && c.target === a.target;

  const updateConnection = (link, patch) =>
    commit((r) => ({
      ...r,
      connections: r.connections.map((c) => (sameLink(link)(c) ? { ...c, ...patch } : c)),
    }));

  const updateRequirements = (patch) =>
    setRequirements((r) => ({ ...EMPTY_REQUIREMENTS, ...(r ?? {}), ...patch }));

  async function handleApplyFix(fix) {
    if (!result || applying) return;
    const id = activeId; // the fix belongs to this variant even if another is opened while it is applied
    setApplying(true);
    setFixError("");
    try {
      const updated = await applyFix(result, fix);
      commitTo(id, () => updated);
    } catch (err) {
      setFixError(err.message);
    } finally {
      setApplying(false);
    }
  }

  // ---- variants ----
  function switchVariant(id) {
    if (id === activeId) return;
    setActiveId(id);
    setSelectedId(null);
    setSelectedEdge(null);
    setEditingDetails(false);
    setFixError("");
  }

  /** Add a variant (made from `architecture`) and open it. */
  function appendVariant(name, architecture, extra = {}) {
    const id = randomVariantId();
    setVariants((vs) =>
      vs.length >= MAX_VARIANTS ? vs : [...vs, newVariant(id, uniqueName(name, vs), architecture, extra)]
    );
    switchVariant(id);
    return id;
  }

  const sharedSettings = () => ({
    requirements,
    capacity: settings.capacity,
    latency: settings.latency,
  });

  async function addVariant(kind) {
    if (!result || variants.length >= MAX_VARIANTS) return;
    setVariantError("");
    if (kind === "copy") {
      appendVariant(`Copy of ${active.name}`, result, {
        positions: positions,
        initialPositions: positions,
        trafficScale: active.trafficScale,
      });
      return;
    }
    setAddingVariants(true);
    try {
      const preset = await createPreset(result, kind, sharedSettings());
      appendVariant(preset.name, preset.architecture, { trafficScale: preset.traffic_scale });
    } catch (err) {
      setVariantError(err.message);
    } finally {
      setAddingVariants(false);
    }
  }

  /** The three standard alternatives (Cheap, Balanced, Highly available) in one go. */
  async function addStandardVariants() {
    if (!result) return;
    setVariantError("");
    setAddingVariants(true);
    try {
      const have = new Set(variants.map((v) => v.name.toLowerCase()));
      for (const kind of ["cheap", "balanced", "highly_available"]) {
        const preset = await createPreset(result, kind, sharedSettings());
        if (!have.has(preset.name.toLowerCase())) {
          appendVariant(preset.name, preset.architecture, { trafficScale: preset.traffic_scale });
        }
      }
      setActiveId(active.id); // go back to the design that was open
    } catch (err) {
      setVariantError(err.message);
    } finally {
      setAddingVariants(false);
    }
  }

  const renameVariant = (id, name) =>
    setVariants((vs) =>
      updateVariant(vs, id, (v) => ({
        ...v,
        name: uniqueName(
          name,
          vs.filter((other) => other.id !== id)
        ),
      }))
    );

  const duplicateVariant = (id) => {
    const source = variants.find((v) => v.id === id);
    if (!source?.history.present) return;
    appendVariant(`Copy of ${source.name}`, source.history.present, {
      positions: source.positions,
      initialPositions: source.positions,
      trafficScale: source.trafficScale,
    });
  };

  function deleteVariant(id) {
    if (variants.length <= 1) return;
    const target = variants.find((v) => v.id === id);
    if (!window.confirm(`Delete the variant "${target?.name}"? Its changes will be lost.`)) return;
    const remaining = variants.filter((v) => v.id !== id);
    setVariants(remaining);
    if (id === activeId) {
      setActiveId(remaining[0].id);
      setSelectedId(null);
      setSelectedEdge(null);
      setEditingDetails(false);
    }
  }

  const setTrafficShare = (id, scale) =>
    setVariants((vs) => updateVariant(vs, id, (v) => ({ ...v, trafficScale: scale })));

  const select = (id) => {
    setSelectedId(id);
    if (id) setSelectedEdge(null);
  };
  const selectEdge = (edge) => {
    setSelectedEdge(edge);
    if (edge) setSelectedId(null);
  };

  const variantBar = result ? (
    <VariantBar
      variants={variants}
      activeId={active.id}
      busy={addingVariants}
      error={variantError}
      onSwitch={switchVariant}
      onAdd={addVariant}
      onRename={renameVariant}
      onDuplicate={duplicateVariant}
      onDelete={deleteVariant}
      onTrafficShare={setTrafficShare}
    />
  ) : null;

  return (
    <div className="app">
      <header className="header">
        <h1>SysDesign AI</h1>
        <p className="hint">
          Signed in as {user.email}{" "}
          <button type="button" className="link-btn" onClick={onLogout}>
            Log out
          </button>
        </p>
        <p>
          Describe what you want to build and get a proposed system architecture: components, how they
          connect, and the assumptions behind them.
        </p>
      </header>

      <main className="layout">
        <section className="panel input-panel">
          <label htmlFor="requirements">Requirements</label>
          <textarea
            id="requirements"
            value={prompt}
            maxLength={MAX_LENGTH}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Build an e-commerce application for 100,000 users with payments, search, and order tracking."
          />
          <ImportDocument onText={setPrompt} disabled={loading} />
          <div className="input-footer">
            <span className="counter">
              {prompt.length} / {MAX_LENGTH}
            </span>
            <button onClick={handleGenerate} disabled={!canSubmit}>
              {loading ? "Generating…" : "Generate Architecture"}
            </button>
          </div>
          {generated && result && (
            <GenerationFeedback
              key={`${resultKey}:${generated.prompt}`}
              prompt={generated.prompt}
              projectName={result.project_name}
              cached={generated.cached}
            />
          )}
        </section>

        <section className="panel results-panel" aria-live="polite">
          <Results
            result={result}
            loading={loading}
            error={error}
            diagramKey={`${resultKey}:${active.id}`}
            variantBar={variantBar}
            selectedId={selectedId}
            selectedEdge={selectedEdge}
            onSelect={select}
            onSelectEdge={selectEdge}
            onUpdate={updateComponent}
            onDeleteComponents={deleteComponents}
            onDeleteSelection={deleteSelection}
            onAddComponent={addComponent}
            onConnect={addConnection}
            onDeleteConnections={deleteConnections}
            onUpdateConnection={updateConnection}
            editingDetails={editingDetails}
            onEditDetails={() => setEditingDetails(true)}
            onSaveDetails={updateDetails}
            onCancelDetails={() => setEditingDetails(false)}
            initialPositions={initialPositions}
            onPositions={handlePositions}
            undo={{ run: undo, enabled: canUndo(history) }}
            redo={{ run: redo, enabled: canRedo(history) }}
            requirements={requirements}
            progress={progress}
          />
        </section>
      </main>

      <AiAssistant
        architecture={result}
        requirements={requirements}
        prompt={prompt}
        onApplyPatch={handleApplyFix}
        applying={applying}
        onRegenerate={handleRegenerate}
        regenerating={regenerating}
        regenError={regenError}
        onUsePrompt={setPrompt}
      />

      <Projects
        snapshot={
          result
            ? {
                prompt,
                architecture: result,
                requirements,
                positions,
                variants: toSaved(variants),
                active_variant_id: active.id,
              }
            : null
        }
        currentId={projectId}
        dirty={changedSinceSave}
        confirmDiscard={confirmDiscard}
        onSaved={(id) => {
          setProjectId(id);
          setBaseline(makeBaseline(variants, requirements));
        }}
        onDeleted={(id) => {
          if (id === projectId) {
            setProjectId(null);
            setBaseline(null);
          }
        }}
        onOpen={openProject}
      />

      <Analysis
        architecture={result}
        requirements={requirements}
        onRequirementsChange={updateRequirements}
        onSettingsChange={setSettings}
        trafficScale={active.trafficScale}
        seedKey={`${resultKey}:${reqStatus}`}
        requirementsStatus={reqStatus}
        onApplyFix={handleApplyFix}
        applying={applying}
        fixError={fixError}
      />

      <Planning
        variants={variants}
        activeId={active.id}
        architecture={result}
        requirements={requirements}
        settings={settings}
        trafficScale={active.trafficScale}
        onSwitchVariant={switchVariant}
        onAddStandard={addStandardVariants}
        addingVariants={addingVariants}
        onApplyPatch={handleApplyFix}
        applying={applying}
      />

      <Toolkit
        architecture={result}
        requirements={requirements}
        onRequirementsChange={updateRequirements}
        onApplyPatch={handleApplyFix}
        applying={applying}
        onAddVariant={(name, architecture) => appendVariant(name, architecture)}
        canAddVariant={variants.length < MAX_VARIANTS}
      />

      <ExportShare
        architecture={result}
        requirements={requirements}
        settings={settings}
        trafficScale={active.trafficScale}
        projectId={projectId}
        unsaved={changedSinceSave}
        onImport={importDesignFile}
        onRestored={openProject}
      />

      <InfrastructureCode
        key={`${resultKey}:${active.id}`}
        architecture={result}
        region={requirements?.region || undefined}
      />
    </div>
  );
}

function Results({
  result,
  loading,
  error,
  diagramKey,
  variantBar,
  selectedId,
  selectedEdge,
  onSelect,
  onSelectEdge,
  onUpdate,
  onDeleteComponents,
  onDeleteSelection,
  onAddComponent,
  onConnect,
  onDeleteConnections,
  onUpdateConnection,
  editingDetails,
  onEditDetails,
  onSaveDetails,
  onCancelDetails,
  initialPositions,
  onPositions,
  undo,
  redo,
  requirements,
  progress,
}) {
  if (loading) {
    return (
      <div className="state">
        <div className="spinner" />
        <p>
          Designing your architecture. This can take a few seconds.
          {progress > 0 && ` Written so far: ${progress.toLocaleString()} characters.`}
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="state error">
        <h2>Couldn't generate an architecture</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="state">
        <h2>Your architecture will appear here</h2>
        <p>Enter your requirements and select Generate Architecture.</p>
      </div>
    );
  }

  const selected = result.components.find((c) => c.id === selectedId);
  const edge =
    selectedEdge &&
    result.connections.find((c) => c.source === selectedEdge.source && c.target === selectedEdge.target);

  const nameById = Object.fromEntries(result.components.map((c) => [c.id, c.name]));

  return (
    <div className="result">
      {editingDetails ? (
        <DetailsEditor architecture={result} onSave={onSaveDetails} onCancel={onCancelDetails} />
      ) : (
        <>
          <div className="title-row">
            <h2>{result.project_name}</h2>
            <button type="button" className="secondary" onClick={onEditDetails}>
              Edit details
            </button>
          </div>
          {result.description && <p className="lead">{result.description}</p>}
        </>
      )}

      {variantBar}

      <h3>Diagram</h3>
      <div className="diagram-area">
        <ArchitectureDiagram
          key={diagramKey}
          architecture={result}
          selectedId={selected ? selectedId : null}
          selectedEdge={edge ? selectedEdge : null}
          onSelect={onSelect}
          onSelectEdge={onSelectEdge}
          onConnect={onConnect}
          onDeleteSelection={onDeleteSelection}
          onAdd={onAddComponent}
          undo={undo}
          redo={redo}
          initialPositions={initialPositions}
          onPositions={onPositions}
        />
        {selected && (
          <ComponentPanel
            key={`${selected.id}:${JSON.stringify(selected)}`}
            component={selected}
            architecture={result}
            requirements={requirements}
            onChange={(patch) => onUpdate(selected.id, patch)}
            onDelete={() => onDeleteComponents([selected.id])}
            onClose={() => onSelect(null)}
          />
        )}
        {edge && (
          <ConnectionPanel
            key={`${edge.source}->${edge.target}:${edge.label}`}
            connection={edge}
            sourceName={nameById[edge.source]}
            targetName={nameById[edge.target]}
            onChange={(patch) => onUpdateConnection(edge, patch)}
            onDelete={() => onDeleteConnections([edge])}
            onClose={() => onSelectEdge(null)}
          />
        )}
      </div>

      <h3>Components ({result.components.length})</h3>
      <ul className="components">
        {result.components.map((c) => (
          <li key={c.id} className="component">
            <div className="component-head">
              <strong>{c.name}</strong>
              <span className="tag">{c.type}</span>
              <span className="tag muted">{c.provider}</span>
            </div>
            {Object.keys(c.configuration).length > 0 && (
              <dl className="config">
                {Object.entries(c.configuration).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        ))}
      </ul>

      {result.connections.length > 0 && (
        <>
          <h3>Connections ({result.connections.length})</h3>
          <ul className="connections">
            {result.connections.map((conn) => (
              <li key={`${conn.source}->${conn.target}`}>
                <span>{nameById[conn.source] ?? conn.source}</span>
                <span className="arrow" aria-label="connects to">
                  →
                </span>
                <span>{nameById[conn.target] ?? conn.target}</span>
                {conn.label && <em>{conn.label}</em>}
              </li>
            ))}
          </ul>
        </>
      )}

      {!editingDetails && result.assumptions.length > 0 && (
        <>
          <h3>Assumptions</h3>
          <ul className="assumptions">
            {result.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
