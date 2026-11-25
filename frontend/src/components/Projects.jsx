import { useEffect, useState } from "react";
import {
  createProject,
  deleteProject,
  duplicateProject,
  getProject,
  listProjects,
  listTrash,
  renameProject,
  restoreProject,
  updateProject,
} from "../api/client.js";

const PAGE_SIZE = 5;
const TRASH_DAYS = 30; // keep in step with PURGE_AFTER_DAYS in the backend

/** "2026-11-15 19:12:45" (UTC, as stored) -> days left before the trash is emptied. */
function daysLeft(deletedAt) {
  const deleted = new Date(`${deletedAt.replace(" ", "T")}Z`);
  const age = (Date.now() - deleted.getTime()) / 86400000;
  return Math.max(0, Math.ceil(TRASH_DAYS - age));
}

/**
 * Saved projects for the logged-in user: save, search, sort, page, rename, duplicate, and a
 * 30-day trash. `dirty` means the design on screen differs from the saved copy.
 */
export default function Projects({ snapshot, currentId, dirty, onSaved, onOpen, onDeleted, confirmDiscard }) {
  const [page, setPage] = useState({ items: [], total: 0, limit: PAGE_SIZE, offset: 0 });
  const [trash, setTrash] = useState([]);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState(""); // the query, after typing has paused
  const [sort, setSort] = useState("updated");
  const [offset, setOffset] = useState(0);
  const [reloadKey, setReloadKey] = useState(0); // bump to reload the list after a change
  // A new design starts with the generated project name (an opened project fills in its own).
  const [name, setName] = useState(() => (currentId ? "" : (snapshot?.architecture?.project_name ?? "")));
  const [renaming, setRenaming] = useState(null); // { id, text }
  const [undo, setUndo] = useState(null); // { id, name } of the project just deleted
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    // Only when the text really changed: otherwise this would send the user back to page 1 on its own.
    if (query === search) return undefined;
    const t = setTimeout(() => {
      setSearch(query);
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [query, search]);

  // Load the current page (and the trash) whenever the search, sort, page or `reloadKey` changes.
  // An answer that arrives after a newer request was made is ignored.
  useEffect(() => {
    let stale = false;
    (async () => {
      try {
        const [projects, trashed] = await Promise.all([
          listProjects({ q: search, limit: PAGE_SIZE, offset, sort }),
          listTrash(),
        ]);
        if (stale) return;
        // Deleting the last item of a page leaves it empty: go back one page.
        if (projects.items.length === 0 && projects.total > 0 && offset > 0) {
          setOffset(Math.max(0, offset - PAGE_SIZE));
          return;
        }
        setPage(projects);
        setTrash(trashed);
      } catch (err) {
        if (!stale) setError(err.message);
      }
    })();
    return () => {
      stale = true;
    };
  }, [search, offset, sort, reloadKey]);

  // A new design starts with the generated project name; opening a project shows its own.
  // (Adjusting state while rendering, as React recommends, instead of in an effect.)
  const suggested = snapshot?.architecture?.project_name ?? "";
  const nameSource = currentId ? null : suggested;
  const [seenNameSource, setSeenNameSource] = useState(nameSource);
  if (nameSource !== seenNameSource) {
    setSeenNameSource(nameSource);
    if (!currentId) setName(suggested);
  }

  async function run(action, done) {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await action();
      if (done) setNote(done);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      const body = { name: name.trim(), ...snapshot };
      const saved = currentId ? await updateProject(currentId, body) : await createProject(body);
      onSaved(saved.id);
      setUndo(null);
    }, "Saved.");

  const open = (id) => {
    if (id !== currentId && !confirmDiscard()) return;
    run(async () => {
      const project = await getProject(id);
      onOpen(project);
      setName(project.name);
      setUndo(null);
    }, "Opened.");
  };

  const rename = () =>
    run(async () => {
      const text = renaming.text.trim();
      if (!text) return;
      await renameProject(renaming.id, text);
      if (renaming.id === currentId) setName(text);
      setRenaming(null);
    }, "Renamed.");

  const duplicate = (p) =>
    run(async () => {
      await duplicateProject(p.id);
    }, `Duplicated "${p.name}".`);

  const remove = (p) =>
    run(async () => {
      await deleteProject(p.id);
      onDeleted(p.id);
      setUndo({ id: p.id, name: p.name });
    }, `Moved "${p.name}" to the trash.`);

  const restore = (p) =>
    run(async () => {
      await restoreProject(p.id);
      setUndo(null);
    }, `Restored "${p.name}".`);

  const eraseForever = (p) => {
    if (!window.confirm(`Delete "${p.name}" forever? This cannot be undone.`)) return;
    run(async () => {
      await deleteProject(p.id, { permanent: true });
      setUndo(null);
    }, "Deleted forever.");
  };

  const pages = Math.max(1, Math.ceil(page.total / PAGE_SIZE));
  const pageNumber = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <section className="panel perf" aria-labelledby="projects-title">
      <div className="title-row">
        <h2 id="projects-title">Saved projects</h2>
        {snapshot && (dirty || !currentId) && (
          <span className="tag badge-unsaved">{currentId ? "Unsaved changes" : "Not saved yet"}</span>
        )}
      </div>

      <div className="perf-actions">
        <input
          aria-label="Project name"
          value={name}
          maxLength={120}
          placeholder="Project name"
          onChange={(e) => setName(e.target.value)}
          disabled={!snapshot}
        />
        <button onClick={save} disabled={!snapshot || busy || !name.trim()}>
          {currentId ? "Save changes" : "Save project"}
        </button>
        {!snapshot && <span className="hint-inline">Generate an architecture to save it.</span>}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="hint" role="status">
        {note}
        {undo && (
          <button type="button" className="linklike" onClick={() => restore(undo)}>
            Undo
          </button>
        )}
      </p>

      <div className="project-tools">
        <input
          type="search"
          aria-label="Search projects"
          placeholder="Search projects"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="Sort projects"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value);
            setOffset(0);
          }}
        >
          <option value="updated">Recently changed</option>
          <option value="name">Name (A to Z)</option>
        </select>
      </div>

      {page.items.length === 0 ? (
        <p className="hint">{search ? "No projects match your search." : "No saved projects yet."}</p>
      ) : (
        <ul className="components">
          {page.items.map((p) => (
            <li key={p.id} className="component">
              {renaming?.id === p.id ? (
                <form
                  className="inline-edit"
                  onSubmit={(e) => {
                    e.preventDefault();
                    rename();
                  }}
                >
                  <input
                    aria-label="New project name"
                    autoFocus
                    value={renaming.text}
                    maxLength={120}
                    onChange={(e) => setRenaming({ id: p.id, text: e.target.value })}
                  />
                  <button type="submit" disabled={busy || !renaming.text.trim()}>
                    Save name
                  </button>
                  <button type="button" className="secondary" onClick={() => setRenaming(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <div className="project-row">
                  <strong className="grow">{p.name}</strong>
                  {p.id === currentId && <span className="tag">open</span>}
                  <span className="tag muted">{p.updated_at}</span>
                  <div className="project-actions">
                    <button type="button" onClick={() => open(p.id)} disabled={busy}>
                      Open
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setRenaming({ id: p.id, text: p.name })}
                      disabled={busy}
                    >
                      Rename
                    </button>
                    <button type="button" className="secondary" onClick={() => duplicate(p)} disabled={busy}>
                      Duplicate
                    </button>
                    <button type="button" className="danger" onClick={() => remove(p)} disabled={busy}>
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {page.total > PAGE_SIZE && (
        <div className="pager">
          <button
            type="button"
            className="secondary"
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            disabled={offset === 0}
          >
            Previous
          </button>
          <span>
            Page {pageNumber} of {pages} ({page.total} projects)
          </span>
          <button
            type="button"
            className="secondary"
            onClick={() => setOffset(offset + PAGE_SIZE)}
            disabled={offset + PAGE_SIZE >= page.total}
          >
            Next
          </button>
        </div>
      )}

      {trash.length > 0 && (
        <details className="how">
          <summary>Trash ({trash.length})</summary>
          <p className="hint">Deleted projects are kept for {TRASH_DAYS} days, then removed for good.</p>
          <ul className="components">
            {trash.map((p) => (
              <li key={p.id} className="component">
                <div className="project-row">
                  <strong className="grow">{p.name}</strong>
                  <span className="tag muted">{daysLeft(p.deleted_at)} days left</span>
                  <div className="project-actions">
                    <button type="button" onClick={() => restore(p)} disabled={busy}>
                      Restore
                    </button>
                    <button type="button" className="danger" onClick={() => eraseForever(p)} disabled={busy}>
                      Delete forever
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
