const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

/** POST JSON to the backend. Returns parsed JSON, or throws an Error with a readable message. */
async function post(path, body) {
  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      `Can't reach the backend at ${API_URL}. Check that it is running.`
    );
  }

  if (!response.ok) {
    let detail = `Request failed (${response.status}).`;
    try {
      const data = await response.json();
      if (typeof data.detail === "string") {
        detail = data.detail;
      } else if (Array.isArray(data.detail) && data.detail[0]?.msg) {
        // FastAPI validation errors (422) come back as a list
        detail = data.detail[0].msg;
      }
    } catch {
      /* keep the default message */
    }
    throw new Error(detail);
  }

  return response.json();
}

/** POST /api/architecture -> ArchitectureResult */
export function generateArchitecture(prompt) {
  return post("/api/architecture", { prompt });
}

/** POST /api/simulate -> SimulationResponse */
export function runSimulation(inputs) {
  return post("/api/simulate", inputs);
}

/** POST /api/cost -> CostResponse */
export function runCostEstimate(payload) {
  return post("/api/cost", payload);
}

/** POST /api/optimize -> OptimizationResult (analyzes only; never regenerates the architecture) */
export function analyzeArchitecture(payload) {
  return post("/api/optimize", payload);
}

export function generateInfrastructureCode(architecture) { return post("/api/generate-code", architecture); }
