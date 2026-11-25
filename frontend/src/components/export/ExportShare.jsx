import { useRef, useState } from "react";
import {
  compareVersion,
  createShare,
  fetchAllProjects,
  fetchCostCsv,
  fetchDesignFile,
  fetchDiagramFile,
  fetchDocumentFile,
  getProject,
  getShare,
  importDesign,
  listVersions,
  restoreVersion,
  revokeShare,
  saveBlob,
  sharedDiagramUrl,
} from "../../api/client.js";
import { useRemote } from "../../useRemote.js";
import { copyText } from "../toolkit/files.js";

const SCALE = 2; // PNG pixels per SVG pixel

/** Draws an SVG blob onto a canvas and returns it as a PNG blob. */
function svgToPng(svgBlob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(svgBlob);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth * SCALE;
      canvas.height = image.naturalHeight * SCALE;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        (png) => (png ? resolve(png) : reject(new Error("Could not make the PNG."))),
        "image/png"
      );
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not draw the diagram as an image."));
    };
    image.src = url;
  });
}

function Btn({ busy, id, onClick, children }) {
  return (
    <button type="button" className="secondary" disabled={Boolean(busy)} onClick={onClick}>
      {busy === id ? "Working…" : children}
    </button>
  );
}

const baseName = (filename) => filename.replace(/\.[^.]+$/, "");

function Downloads({ architecture, requirements, settings, trafficScale, onImport }) {
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const fileInput = useRef(null);
  const extra = { capacity: settings?.capacity, latency: settings?.latency, trafficScale };

  async function run(name, work) {
    setBusy(name);
    setError("");
    setMessage("");
    try {
      const note = await work();
      if (note) setMessage(note);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  const download = (name, getFile) =>
    run(name, async () => {
      const { blob, filename } = await getFile();
      saveBlob(blob, filename);
      return `Saved ${filename}.`;
    });

  const printable = () => {
    // Open the tab now (a click is needed for the browser to allow it), then fill it once the document is ready.
    const tab = window.open("", "_blank");
    return run("print", async () => {
      try {
        const { blob, filename } = await fetchDocumentFile(architecture, requirements, extra, "html");
        if (!tab) {
          saveBlob(blob, filename);
          return `Saved ${filename}. Open it and use Print, then Save as PDF.`;
        }
        tab.location.href = URL.createObjectURL(new Blob([blob], { type: "text/html" }));
        return "Opened in a new tab. Use Print, then choose Save as PDF.";
      } catch (err) {
        tab?.close();
        throw err;
      }
    });
  };

  const png = () =>
    run("png", async () => {
      const { blob, filename } = await fetchDiagramFile(architecture, "svg");
      saveBlob(await svgToPng(blob), `${baseName(filename)}.png`);
      return "Saved the diagram as a PNG.";
    });

  const copyMermaid = () =>
    run("mermaid", async () => {
      const { blob } = await fetchDiagramFile(architecture, "mermaid");
      return (await copyText(await blob.text()))
        ? "Mermaid text copied."
        : "Could not copy: use the download instead.";
    });

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await run("import", async () => {
      if (file.size > 2_000_000) throw new Error("That file is too large to be a design.");
      let data;
      try {
        data = JSON.parse(await file.text());
      } catch {
        throw new Error("That file is not valid JSON.");
      }
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error("That file is not a design.");
      const result = await importDesign(data);
      if (!onImport(result.architecture, result.requirements)) return "Import cancelled.";
      return ["Design imported as a new, unsaved design.", ...result.notes].join(" ");
    });
  }

  return (
    <div>
      <h4>Download the design</h4>
      <div className="tool-actions">
        <Btn
          id="md"
          onClick={() => download("md", () => fetchDocumentFile(architecture, requirements, extra))}
        >
          Document (Markdown)
        </Btn>
        <Btn busy={busy} id="print" onClick={printable}>
          Document for PDF (print)
        </Btn>
        <Btn
          id="cost"
          onClick={() => download("cost", () => fetchCostCsv(architecture, requirements, extra))}
        >
          Cost table (CSV)
        </Btn>
        <Btn
          busy={busy}
          id="json"
          onClick={() => download("json", () => fetchDesignFile(architecture, requirements))}
        >
          Design file (JSON)
        </Btn>
      </div>
      <h4>Diagram</h4>
      <div className="tool-actions">
        <Btn
          busy={busy}
          id="svg"
          onClick={() => download("svg", () => fetchDiagramFile(architecture, "svg"))}
        >
          SVG image
        </Btn>
        <Btn busy={busy} id="png" onClick={png}>
          PNG image
        </Btn>
        <Btn busy={busy} id="mermaid" onClick={copyMermaid}>
          Copy as Mermaid
        </Btn>
      </div>
      <h4>Import a design file</h4>
      <p className="hint">
        Open a design that was downloaded as JSON. It is checked and cleaned first, and loads as a new,
        unsaved design.
      </p>
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={onFile}
        aria-label="Choose a design file"
      />
      <Btn busy={busy} id="import" onClick={() => fileInput.current?.click()}>
        Import a design file
      </Btn>
      <p className="hint" role="status" aria-live="polite">
        {message}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Share({ projectId, unsaved }) {
  const [version, setVersion] = useState(0);
  const status = useRemote(() => getShare(projectId), [projectId, version], { delay: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const token = status.data?.token;
  const link = token ? `${window.location.origin}${window.location.pathname}?shared=${token}` : "";
  const embed = token ? `<img src="${sharedDiagramUrl(token)}" alt="Architecture diagram">` : "";

  async function change(action) {
    setBusy(true);
    setError("");
    try {
      await action(projectId);
      setVersion((v) => v + 1);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function copy(text, what) {
    setCopied((await copyText(text)) ? `${what} copied.` : "Could not copy: select the text and copy it.");
  }

  return (
    <div>
      <h4>Share a read-only link</h4>
      <p className="hint">
        Anyone with the link can see the saved design, its diagram and its analysis, without logging in, until
        you turn it off. They cannot change anything.
        {unsaved && " The link shows the last saved version, not the changes on screen."}
      </p>
      {status.error && (
        <p className="form-error" role="alert">
          {status.error}
        </p>
      )}
      {!token ? (
        <button type="button" disabled={busy || !status.data} onClick={() => change(createShare)}>
          Create a share link
        </button>
      ) : (
        <>
          <label className="tool-field" htmlFor="share-link">
            <span>Link</span>
            <input id="share-link" readOnly value={link} onFocus={(e) => e.target.select()} />
          </label>
          <div className="tool-actions">
            <button type="button" className="secondary" onClick={() => copy(link, "Link")}>
              Copy link
            </button>
            <button type="button" className="secondary" onClick={() => copy(embed, "Embed code")}>
              Copy embed code (image)
            </button>
            <button type="button" className="danger" disabled={busy} onClick={() => change(revokeShare)}>
              Turn off the link
            </button>
          </div>
          <p className="hint">
            The embed code shows the diagram as an image in documents and wikis; it stops working when the
            link is turned off.
          </p>
        </>
      )}
      <p className="hint" role="status" aria-live="polite">
        {copied}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function History({ projectId, onRestored }) {
  const [version, setVersion] = useState(0);
  const list = useRemote(() => listVersions(projectId), [projectId, version], { delay: 0 });
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function compare(id) {
    setError("");
    try {
      setDiff(await compareVersion(projectId, id));
    } catch (err) {
      setError(err.message);
    }
  }

  async function restore(id) {
    if (
      !window.confirm(
        "Restore this version? The current saved design is kept as a version, so you can go back."
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await restoreVersion(projectId, id);
      onRestored(await getProject(projectId));
      setDiff(null);
      setVersion((v) => v + 1);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const items = list.data?.items ?? [];
  return (
    <div>
      <h4>Version history</h4>
      <p className="hint">A version is kept every time the project is saved (the latest 30).</p>
      <div className="tool-actions">
        <button type="button" className="secondary" onClick={() => setVersion((v) => v + 1)}>
          Refresh
        </button>
      </div>
      {list.error && (
        <p className="form-error" role="alert">
          {list.error}
        </p>
      )}
      <div className="table-scroll">
        <table className="plain-table">
          <caption className="sr-only">Saved versions</caption>
          <thead>
            <tr>
              <th>Saved</th>
              <th>What</th>
              <th>Components</th>
              <th>Designs</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((v, i) => (
              <tr key={v.id}>
                <td>{v.created_at}</td>
                <td>
                  {v.label}
                  {i === 0 && " (latest)"}
                </td>
                <td>{v.component_count}</td>
                <td>{v.variant_count}</td>
                <td>
                  <button type="button" className="secondary" onClick={() => compare(v.id)}>
                    Compare with now
                  </button>{" "}
                  {i > 0 && (
                    <button type="button" className="secondary" disabled={busy} onClick={() => restore(v.id)}>
                      Restore
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {diff && (
        <div
          className="refine-answer"
          role="region"
          aria-label="Changes since this version"
          aria-live="polite"
        >
          <strong>Since the version saved {diff.version.created_at}:</strong>
          {diff.identical ? (
            <p className="hint">Nothing has changed.</p>
          ) : (
            <>
              {diff.renamed && <p>Renamed: {diff.renamed}</p>}
              {[
                ["Added since", diff.added, "add"],
                ["Removed since", diff.removed, "remove"],
                ["Changed since", diff.changed, "change"],
              ].map(
                ([title, rows, tone]) =>
                  rows.length > 0 && (
                    <div key={title} className={`diff diff-${tone}`}>
                      <strong>{title}</strong>
                      <ul>
                        {rows.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    </div>
                  )
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MyData() {
  const [state, setState] = useState({ busy: false, error: "", done: false });
  async function run() {
    setState({ busy: true, error: "", done: false });
    try {
      const { blob, filename } = await fetchAllProjects();
      saveBlob(blob, filename);
      setState({ busy: false, error: "", done: true });
    } catch (err) {
      setState({ busy: false, error: err.message, done: false });
    }
  }
  return (
    <div>
      <h4>Your data</h4>
      <p className="hint">
        Every project you have saved, including versions' latest state and the trash, as one JSON file.
      </p>
      <button type="button" className="secondary" disabled={state.busy} onClick={run}>
        {state.busy ? "Preparing…" : "Download all my projects"}
      </button>
      <span className="hint" role="status" aria-live="polite">
        {state.done && " Saved."}
      </span>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
    </div>
  );
}

const TABS = [
  { id: "download", label: "Download and import" },
  { id: "share", label: "Share" },
  { id: "history", label: "Version history" },
  { id: "data", label: "Your data" },
];

/** Take the design out of the app (document, diagram, cost, file), import one, share it, and see its versions. */
export default function ExportShare({
  architecture,
  requirements,
  settings,
  trafficScale,
  projectId,
  unsaved,
  onImport,
  onRestored,
}) {
  const [tab, setTab] = useState("download");

  function onKeyDown(e) {
    const index = TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    if (next === -1) return;
    e.preventDefault();
    setTab(TABS[next].id);
    document.getElementById(`export-tab-${TABS[next].id}`)?.focus();
  }

  if (!architecture) {
    return (
      <section className="panel perf" aria-labelledby="export-title">
        <h2 id="export-title">Export and share</h2>
        <p className="perf-intro">
          Generate or import an architecture first. Then download a document, the diagram or the cost table,
          share a read-only link and see past versions.
        </p>
        <ExportImportOnly onImport={onImport} />
      </section>
    );
  }

  const needsProject = (what) => (
    <p className="hint">Save the project first (use Save in the projects section) to {what}.</p>
  );

  return (
    <section className="panel perf export-share" aria-labelledby="export-title">
      <h2 id="export-title">Export and share</h2>
      <div className="code-tabs" role="tablist" aria-label="Export and share" onKeyDown={onKeyDown}>
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`export-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls="export-panel"
            tabIndex={tab === t.id ? 0 : -1}
            className={`code-tab${tab === t.id ? " active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="export-panel" aria-labelledby={`export-tab-${tab}`}>
        {tab === "download" && (
          <Downloads
            architecture={architecture}
            requirements={requirements}
            settings={settings}
            trafficScale={trafficScale}
            onImport={onImport}
          />
        )}
        {tab === "share" &&
          (projectId ? (
            <Share key={projectId} projectId={projectId} unsaved={unsaved} />
          ) : (
            needsProject("share it")
          ))}
        {tab === "history" &&
          (projectId ? (
            <History key={projectId} projectId={projectId} onRestored={onRestored} />
          ) : (
            needsProject("see its versions")
          ))}
        {tab === "data" && <MyData />}
      </div>
    </section>
  );
}

/** Before any design exists, a file can still be imported. */
function ExportImportOnly({ onImport }) {
  const input = useRef(null);
  const [error, setError] = useState("");
  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    try {
      const data = JSON.parse(await file.text());
      const result = await importDesign(data);
      onImport(result.architecture, result.requirements);
    } catch (err) {
      setError(err instanceof SyntaxError ? "That file is not valid JSON." : err.message);
    }
  }
  return (
    <div>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={onFile}
        aria-label="Choose a design file"
      />
      <button type="button" className="secondary" onClick={() => input.current?.click()}>
        Import a design file
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
