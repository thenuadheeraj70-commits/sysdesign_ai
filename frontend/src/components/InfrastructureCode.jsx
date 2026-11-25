import { useEffect, useRef, useState } from "react";
import { downloadInfrastructureZip, generateInfrastructureCode } from "../api/client.js";
import "./InfrastructureCode.css";

const TABS = [
  { id: "terraform", label: "Terraform" },
  { id: "kubernetes", label: "Kubernetes" },
];

// Show the most important files first. Anything else keeps the backend's order.
const FILE_ORDER = [
  "main.tf",
  "variables.tf",
  "outputs.tf",
  "providers.tf",
  "deployment.yaml",
  "service.yaml",
  "configmap.yaml",
  "hpa.yaml",
  "ingress.yaml",
];

const fileName = (path) => path.split("/").pop();

function sortFiles(files) {
  const rank = (f) => {
    const i = FILE_ORDER.indexOf(fileName(f.path));
    return i === -1 ? FILE_ORDER.length : i;
  };
  return [...files].sort((a, b) => rank(a) - rank(b));
}

/** Copies text to the clipboard. Returns true on success. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for browsers or pages where the Clipboard API is unavailable
    try {
      const box = document.createElement("textarea");
      box.value = text;
      box.setAttribute("readonly", "");
      box.style.position = "fixed";
      box.style.opacity = "0";
      document.body.appendChild(box);
      box.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(box);
      return ok;
    } catch {
      return false;
    }
  }
}

export default function InfrastructureCode({ architecture, region }) {
  const [generated, setGenerated] = useState(null); // { data, snapshot }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("terraform");
  const [selectedFile, setSelectedFile] = useState({}); // tab id -> file path
  const [copyState, setCopyState] = useState(""); // "", "copied" or "failed"
  const [zipBusy, setZipBusy] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const snapshot = architecture ? JSON.stringify([architecture, region ?? ""]) : "";
  const stale = generated && generated.snapshot !== snapshot;

  async function handleGenerate() {
    if (!architecture || loading) return;
    setLoading(true);
    setError("");
    try {
      const data = await generateInfrastructureCode(architecture, region);
      setGenerated({ data, snapshot });
      setCopyState("");
    } catch (err) {
      setGenerated(null);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleZip() {
    if (!architecture || zipBusy) return;
    setZipBusy(true);
    setError("");
    try {
      await downloadInfrastructureZip(architecture, region);
    } catch (err) {
      setError(err.message);
    } finally {
      setZipBusy(false);
    }
  }

  function showCopyState(state) {
    setCopyState(state);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopyState(""), 2000);
  }

  async function handleCopy(content) {
    showCopyState((await copyText(content)) ? "copied" : "failed");
  }

  function changeTab(id) {
    setTab(id);
    setCopyState("");
  }

  function changeFile(path) {
    setSelectedFile((s) => ({ ...s, [tab]: path }));
    setCopyState("");
  }

  const section = generated?.data[tab];
  const files = section ? sortFiles(section.files) : [];
  const file = files.find((f) => f.path === selectedFile[tab]) ?? files[0];

  return (
    <section className="panel perf code" aria-labelledby="code-title">
      <h2 id="code-title">Infrastructure Code</h2>
      <p className="perf-intro">
        Generates starter Terraform and Kubernetes files from your architecture. The code is shown here for
        you to review and copy. Nothing is deployed, applied, or saved.
      </p>

      <div className="perf-actions">
        <button onClick={handleGenerate} disabled={!architecture || loading}>
          {loading ? "Generating…" : generated ? "Generate Again" : "Generate Code"}
        </button>
        <button type="button" onClick={handleZip} disabled={!architecture || zipBusy}>
          {zipBusy ? "Preparing…" : "Download ZIP"}
        </button>
        {!architecture && <span className="hint-inline">Generate an architecture first.</span>}
      </div>

      {error && (
        <div className="state error perf-error" role="alert">
          <h3>Couldn't generate the code</h3>
          <p>{error}</p>
        </div>
      )}

      {generated && !error && (
        <div className="sim-results">
          {stale && (
            <p className="code-banner">
              The architecture has changed since this code was generated. Select Generate Again to update it.
            </p>
          )}

          <TabList
            label="Infrastructure code type"
            idPrefix="code-tab"
            items={TABS}
            activeId={tab}
            onSelect={changeTab}
            className="code-tabs"
          />

          <div role="tabpanel" id="code-panel" aria-labelledby={`code-tab-${tab}`}>
            {section.available === false ? (
              <p className="hint">{section.message}</p>
            ) : (
              <>
                {section.message && <p className="code-message">{section.message}</p>}

                {file ? (
                  <>
                    <TabList
                      label={`${tab === "terraform" ? "Terraform" : "Kubernetes"} files`}
                      idPrefix="file-tab"
                      items={files.map((f) => ({ id: f.path, label: fileName(f.path) }))}
                      activeId={file.path}
                      onSelect={changeFile}
                      className="file-tabs"
                    />
                    <CodeViewer file={file} copyState={copyState} onCopy={() => handleCopy(file.content)} />
                  </>
                ) : (
                  <p className="hint">No files were generated.</p>
                )}

                <Details section={section} />
              </>
            )}
          </div>

          <p className="hint">{generated.data.notice}</p>
        </div>
      )}
    </section>
  );
}

/** Row of tab buttons with arrow-key navigation. */
function TabList({ label, items, activeId, onSelect, idPrefix, className }) {
  function onKeyDown(e) {
    const current = items.findIndex((t) => t.id === activeId);
    let next = -1;
    if (e.key === "ArrowRight") next = (current + 1) % items.length;
    else if (e.key === "ArrowLeft") next = (current - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    if (next === -1) return;

    e.preventDefault();
    onSelect(items[next].id);
    document.getElementById(`${idPrefix}-${items[next].id}`)?.focus();
  }

  return (
    <div className={className} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item) => {
        const active = item.id === activeId;
        return (
          <button
            key={item.id}
            id={`${idPrefix}-${item.id}`}
            role="tab"
            type="button"
            aria-selected={active}
            aria-controls={idPrefix === "code-tab" ? "code-panel" : undefined}
            tabIndex={active ? 0 : -1}
            className={`code-tab${active ? " active" : ""}`}
            onClick={() => onSelect(item.id)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/** Read-only code view with line numbers and a Copy button. */
function CodeViewer({ file, copyState, onCopy }) {
  const lines = file.content.replace(/\n$/, "").split("\n");

  return (
    <div className="code-viewer">
      <div className="code-toolbar">
        <span className="code-path">{file.path}</span>
        <div className="code-copy">
          <span className={`copy-status ${copyState}`} role="status">
            {copyState === "copied" && "Copied to clipboard"}
            {copyState === "failed" && "Couldn't copy. Select the text and copy it manually."}
          </span>
          <button type="button" className="copy-btn" onClick={onCopy}>
            {copyState === "copied" ? "Copied ✓" : "Copy"}
          </button>
        </div>
      </div>
      <pre className="code-body" tabIndex={0} aria-label={`Contents of ${fileName(file.path)}`}>
        <code>
          {lines.map((line, i) => (
            <span className="code-line" key={i}>
              {line || " "}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

/** Warnings and skipped components for the selected tab. */
function Details({ section }) {
  const warnings = section.warnings ?? [];
  const skipped = section.skipped_components ?? [];
  if (warnings.length === 0 && skipped.length === 0 && !section.notice) return null;

  return (
    <div className="code-details">
      {warnings.length > 0 && (
        <details open>
          <summary>Things to check ({warnings.length})</summary>
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      {skipped.length > 0 && (
        <details>
          <summary>Not generated ({skipped.length})</summary>
          <ul>
            {skipped.map((s) => (
              <li key={s.id}>
                <strong>{s.name}</strong>: {s.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {section.notice && <p className="hint">{section.notice}</p>}
    </div>
  );
}
