const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";
const TOKEN_KEY = "sysdesign_token";

// ---- login token (kept in localStorage so a refresh keeps you logged in) ----
export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: the user just has to log in again */
  }
}

let onUnauthorized = () => {};
/** Called when the server says the login is missing or expired. */
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

/** The Error for a failed response, with the server's own message when it gave one. */
async function failure(response, token) {
  let detail = `Request failed (${response.status}).`;
  try {
    const data = await response.json();
    if (typeof data.detail === "string") {
      detail = data.detail;
    } else if (Array.isArray(data.detail) && data.detail[0]?.msg) {
      detail = data.detail[0].msg.replace(/^Value error, /, "");
    }
  } catch {
    /* keep the default message */
  }
  if (response.status === 401 && token) onUnauthorized();
  return new Error(detail);
}

const authHeaders = (json) => {
  const headers = {};
  if (json) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return { headers, token };
};

const unreachable = () => new Error(`Can't reach the backend at ${API_URL}. Check that it is running.`);

/**
 * Send JSON to the backend. Returns parsed JSON (or null for 204), or throws an Error with a readable message.
 * If `meta` is given, meta.cached tells whether the server answered from its AI cache.
 */
async function request(method, path, body, meta) {
  const { headers, token } = authHeaders(body !== undefined);

  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw unreachable();
  }

  if (!response.ok) throw await failure(response, token);
  if (meta) meta.cached = response.headers.get("X-AI-Cached") === "1";
  return response.status === 204 ? null : response.json();
}

const post = (path, body, meta) => request("POST", path, body, meta);

// ---- auth ----
export const register = (email, password) => post("/api/auth/register", { email, password });
export const login = (email, password) => post("/api/auth/login", { email, password });
export const fetchMe = () => request("GET", "/api/auth/me");

// ---- projects ----
/** One page of saved projects: { items, total, limit, offset }. */
export function listProjects({ q = "", limit = 10, offset = 0, sort = "updated" } = {}) {
  const params = new URLSearchParams({ limit, offset, sort });
  if (q.trim()) params.set("q", q.trim());
  return request("GET", `/api/projects?${params}`);
}
export const listTrash = () => request("GET", "/api/projects/trash");
export const getProject = (id) => request("GET", `/api/projects/${id}`);
export const createProject = (project) => post("/api/projects", project);
export const updateProject = (id, project) => request("PUT", `/api/projects/${id}`, project);
export const renameProject = (id, name) => request("PATCH", `/api/projects/${id}`, { name });
export const duplicateProject = (id) => post(`/api/projects/${id}/duplicate`);
export const restoreProject = (id) => post(`/api/projects/${id}/restore`);
/** Moves the project to the trash; with { permanent: true } removes it for good. */
export const deleteProject = (id, { permanent = false } = {}) =>
  request("DELETE", `/api/projects/${id}${permanent ? "?permanent=true" : ""}`);

// ---- design ----
/**
 * POST /api/architecture -> ArchitectureResult.
 * Options: onProgress(characters) streams progress while the model writes; meta (an object) receives
 * { cached } when the server answered from its cache.
 */
export async function generateArchitecture(prompt, { onProgress, meta } = {}) {
  if (!onProgress) return post("/api/architecture", { prompt }, meta);

  const { headers, token } = authHeaders(true);
  let response;
  try {
    response = await fetch(`${API_URL}/api/architecture/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt }),
    });
  } catch {
    throw unreachable();
  }
  if (!response.ok) throw await failure(response, token);

  // One JSON object per line: progress..., then a result or an error.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = null;
  const handle = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.event === "progress") onProgress(event.characters);
    else if (event.event === "error") throw new Error(event.message);
    else if (event.event === "result") {
      result = event.architecture;
      if (meta) meta.cached = Boolean(event.cached);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    lines.forEach(handle);
  }
  handle(buffer);
  if (!result) throw new Error("The server stopped before sending a design. Try again.");
  return result;
}
/** POST /api/requirements -> Requirements (users, traffic, budget... pulled from the prompt) */
export const extractRequirements = (prompt) => post("/api/requirements", { prompt });
/** POST /api/analyze -> performance + cost + recommendations derived from the architecture */
export const analyzeArchitecture = (payload) => post("/api/analyze", payload);
const withRegion = (path, region) => (region ? `${path}?region=${encodeURIComponent(region)}` : path);

/** `region` (for example "eu-west-1") becomes the Terraform default region. */
export const generateInfrastructureCode = (architecture, region) =>
  post(withRegion("/api/generate-code", region), architecture);

/** GET /api/catalog -> { types, providers } */
export const getCatalog = () => request("GET", "/api/catalog");

/** POST /api/preview-fix -> { before, after } headline numbers, without applying the fix */
export const previewFix = (payload) => post("/api/preview-fix", payload);

/** POST /api/generate-code/zip -> saves the Terraform + Kubernetes files as a ZIP download. */
export async function downloadInfrastructureZip(architecture, region) {
  const headers = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(`${API_URL}${withRegion("/api/generate-code/zip", region)}`, {
      method: "POST",
      headers,
      body: JSON.stringify(architecture),
    });
  } catch {
    throw new Error(`Can't reach the backend at ${API_URL}. Check that it is running.`);
  }
  if (!response.ok) throw new Error(`Download failed (${response.status}).`);
  const match = /filename="?([^";]+)"?/.exec(response.headers.get("Content-Disposition") || "");
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = match ? match[1] : "sysdesign-ai-infrastructure.zip";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** POST /api/apply-fix -> the architecture with a recommendation's fix applied */
export const applyFix = (architecture, patch) => post("/api/apply-fix", { architecture, patch });

// ---- planning tools (compare, presets, what-if, growth, budget advisor) ----

/** The inputs every planning tool shares: the requirements and the two analysis overrides. */
const settings = ({ requirements, capacity, latency, trafficScale }) => ({
  requirements: requirements ?? {},
  capacity_per_server: capacity ?? null,
  average_latency: latency ?? null,
  traffic_scale: trafficScale ?? 1,
});

/** POST /api/presets -> a variant built from the design: kind is cheap, balanced, highly_available, dev, staging, production */
export const createPreset = (architecture, kind, shared) =>
  post("/api/presets", { architecture, kind, ...settings(shared) });

/** POST /api/compare -> side-by-side numbers for several variants */
export const compareVariants = (variants, shared) => post("/api/compare", { variants, ...settings(shared) });

/** POST /api/what-if -> utilization, servers and cost across traffic levels */
export const whatIf = (architecture, shared, rpsValues) =>
  post("/api/what-if", {
    architecture,
    ...settings(shared),
    ...(rpsValues ? { rps_values: rpsValues } : {}),
  });

/** POST /api/growth -> month-by-month growth projection */
export const growth = (architecture, shared, monthlyGrowthPercent, months) =>
  post("/api/growth", {
    architecture,
    ...settings(shared),
    monthly_growth_percent: monthlyGrowthPercent,
    months,
  });

/** POST /api/budget-advisor -> the cheapest changes that fit a budget, safest first */
export const budgetAdvisor = (architecture, shared, budget) =>
  post("/api/budget-advisor", { architecture, ...settings(shared), budget });

// ---- design toolkit (capacity, API design, data model, sequences, decisions, patterns, reliability, regions) ----

const toolkit = (path) => (architecture, requirements) =>
  post(path, { architecture, requirements: requirements ?? {} });

export const estimateCapacity = toolkit("/api/capacity");
export const designApi = toolkit("/api/api-design");
export const designDataModel = toolkit("/api/data-model");
export const designSequences = toolkit("/api/sequences");
export const getDecisions = toolkit("/api/decisions");
export const getPatterns = toolkit("/api/patterns");
export const estimateReliability = toolkit("/api/reliability");

/** options: { primary_region, secondary_regions, mode, user_regions } */
export const planMultiRegion = (architecture, requirements, options) =>
  post("/api/multi-region", { architecture, requirements: requirements ?? {}, ...options });

export const explainComponent = (architecture, requirements, componentId) =>
  post("/api/explain", { architecture, requirements: requirements ?? {}, component_id: componentId });

/** GET /api/glossary -> { terms: [{ term, definition }] } */
export const getGlossary = () => request("GET", "/api/glossary");

// ---- AI assistant (refine, review, regenerate, documents, usage, feedback) ----

/** POST /api/refine -> { summary, patch, diff: {added, removed, changed}, source, cached } */
export const refineArchitecture = (architecture, requirements, instruction) =>
  post("/api/refine", { architecture, requirements: requirements ?? {}, instruction });

/** POST /api/regenerate -> ArchitectureResult built from the prompt with the current design as context */
export const regenerateArchitecture = (prompt, architecture) =>
  post("/api/regenerate", { prompt, architecture });

/** POST /api/review -> { summary, findings, source, cached } */
export const reviewArchitecture = (architecture, requirements) =>
  post("/api/review", { architecture, requirements: requirements ?? {} });

/** POST /api/import-document -> { text, source, truncated, note } for a text, PDF or image file */
export const importDocument = (filename, mediaType, dataBase64) =>
  post("/api/import-document", { filename, media_type: mediaType, data_base64: dataBase64 });

export const getAiUsage = () => request("GET", "/api/ai/usage");
export const getAiHistory = () => request("GET", "/api/ai/history");
/** rating is 1 (helpful) or -1 (not helpful) */
export const sendFeedback = (prompt, projectName, rating, comment) =>
  post("/api/ai/feedback", { prompt, project_name: projectName ?? "", rating, comment: comment ?? "" });

// ---- export, import, sharing and version history ----

const settingsBody = (architecture, requirements, extra) => ({
  architecture,
  requirements: requirements ?? {},
  ...(extra?.capacity ? { capacity_per_server: extra.capacity } : {}),
  ...(extra?.latency ? { average_latency: extra.latency } : {}),
  ...(extra?.trafficScale ? { traffic_scale: extra.trafficScale } : {}),
});

/** POST a body, get a file back: { blob, filename } */
async function fetchFile(path, body, fallbackName) {
  const { headers, token } = authHeaders(true);
  let response;
  try {
    response = await fetch(`${API_URL}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  } catch {
    throw unreachable();
  }
  if (!response.ok) throw await failure(response, token);
  const match = /filename="?([^";]+)"?/.exec(response.headers.get("Content-Disposition") || "");
  return { blob: await response.blob(), filename: match ? match[1] : fallbackName };
}

/** GET a file (needs the login) */
async function fetchFileGet(path, fallbackName) {
  const { headers, token } = authHeaders(false);
  let response;
  try {
    response = await fetch(`${API_URL}${path}`, { headers });
  } catch {
    throw unreachable();
  }
  if (!response.ok) throw await failure(response, token);
  const match = /filename="?([^";]+)"?/.exec(response.headers.get("Content-Disposition") || "");
  return { blob: await response.blob(), filename: match ? match[1] : fallbackName };
}

/** Save a blob to the user's downloads. */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const fetchDocumentFile = (architecture, requirements, extra, format = "markdown") =>
  fetchFile(
    `/api/export/document?format=${format}`,
    settingsBody(architecture, requirements, extra),
    "design.md"
  );
export const fetchDiagramFile = (architecture, format = "svg") =>
  fetchFile(
    `/api/export/diagram?format=${format}`,
    architecture,
    `diagram.${format === "svg" ? "svg" : "mmd"}`
  );
export const fetchCostCsv = (architecture, requirements, extra) =>
  fetchFile("/api/export/cost-csv", settingsBody(architecture, requirements, extra), "cost.csv");
export const fetchDesignFile = (architecture, requirements) =>
  fetchFile(
    "/api/export/design-file",
    { architecture, requirements: requirements ?? {} },
    "design.sysdesign.json"
  );
export const fetchAllProjects = () => fetchFileGet("/api/projects/export-all", "my-sysdesign-projects.json");

/** POST /api/import/design -> { architecture, requirements, notes } for the contents of a design file */
export const importDesign = (data) => post("/api/import/design", { data });

export const getShare = (projectId) => request("GET", `/api/projects/${projectId}/share`);
export const createShare = (projectId) => post(`/api/projects/${projectId}/share`);
export const revokeShare = (projectId) => request("DELETE", `/api/projects/${projectId}/share`);
/** GET /api/shared/{token} -> { name, updated_at, document, architecture }; no login needed */
export const getSharedDesign = (token) => request("GET", `/api/shared/${encodeURIComponent(token)}`);
export const sharedDiagramUrl = (token) => `${API_URL}/api/shared/${encodeURIComponent(token)}/diagram.svg`;

export const listVersions = (projectId) => request("GET", `/api/projects/${projectId}/versions`);
export const compareVersion = (projectId, versionId) =>
  request("GET", `/api/projects/${projectId}/versions/${versionId}/compare`);
export const restoreVersion = (projectId, versionId) =>
  post(`/api/projects/${projectId}/versions/${versionId}/restore`);
