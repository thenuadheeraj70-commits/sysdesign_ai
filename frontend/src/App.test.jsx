import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.jsx";
import * as api from "./api/client.js";

vi.mock("./api/client.js", () => ({
  getToken: vi.fn(),
  setToken: vi.fn(),
  setUnauthorizedHandler: vi.fn(),
  fetchMe: vi.fn(),
  login: vi.fn(),
  register: vi.fn(),
  generateArchitecture: vi.fn(),
  extractRequirements: vi.fn(),
  analyzeArchitecture: vi.fn(),
  applyFix: vi.fn(),
  previewFix: vi.fn(),
  getCatalog: vi.fn(),
  listProjects: vi.fn(),
  listTrash: vi.fn(),
  getProject: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  renameProject: vi.fn(),
  duplicateProject: vi.fn(),
  restoreProject: vi.fn(),
  deleteProject: vi.fn(),
  generateInfrastructureCode: vi.fn(),
  downloadInfrastructureZip: vi.fn(),
  // planning tools (variants and presets)
  createPreset: vi.fn(),
  compareVariants: vi.fn(),
  whatIf: vi.fn(),
  growth: vi.fn(),
  budgetAdvisor: vi.fn(),
  // design toolkit
  estimateCapacity: vi.fn(),
  designApi: vi.fn(),
  designDataModel: vi.fn(),
  designSequences: vi.fn(),
  getDecisions: vi.fn(),
  getPatterns: vi.fn(),
  estimateReliability: vi.fn(),
  planMultiRegion: vi.fn(),
  explainComponent: vi.fn(),
  getGlossary: vi.fn(),
  // AI assistant
  regenerateArchitecture: vi.fn(),
  refineArchitecture: vi.fn(),
  reviewArchitecture: vi.fn(),
  importDocument: vi.fn(),
  getAiUsage: vi.fn(),
  getAiHistory: vi.fn(),
  sendFeedback: vi.fn(),
  // export, sharing, versions
  saveBlob: vi.fn(),
  fetchDocumentFile: vi.fn(),
  fetchDiagramFile: vi.fn(),
  fetchCostCsv: vi.fn(),
  fetchDesignFile: vi.fn(),
  fetchAllProjects: vi.fn(),
  importDesign: vi.fn(),
  getShare: vi.fn(),
  createShare: vi.fn(),
  revokeShare: vi.fn(),
  getSharedDesign: vi.fn(),
  sharedDiagramUrl: vi.fn(),
  listVersions: vi.fn(),
  compareVersion: vi.fn(),
  restoreVersion: vi.fn(),
}));

// The real diagram is a canvas library that needs a browser. This stand-in exposes the same
// callbacks as buttons, so the app's editing logic (add, connect, delete, undo, redo) is what gets tested.
vi.mock("./components/ArchitectureDiagram.jsx", async () => {
  const { createElement: h } = await import("react");
  return {
    default: ({ architecture, onAdd, onConnect, onDeleteSelection, onSelect, undo, redo }) =>
      h(
        "div",
        { "data-testid": "diagram" },
        h(
          "ul",
          null,
          architecture.components.map((c) => h("li", { key: c.id, "data-testid": "node" }, c.id))
        ),
        h("span", { "data-testid": "edge-count" }, String(architecture.connections.length)),
        h(
          "button",
          { onClick: () => onAdd({ name: "Search Service", type: "search", provider: "aws" }) },
          "stub add"
        ),
        h(
          "button",
          { onClick: () => onConnect(architecture.components[0].id, architecture.components[1].id) },
          "stub connect first to second"
        ),
        h(
          "button",
          { onClick: () => onDeleteSelection([architecture.components[0].id], []) },
          "stub delete first"
        ),
        // What a Delete key press reports: the component AND the connection that was attached to it.
        h(
          "button",
          {
            onClick: () =>
              onDeleteSelection(
                [architecture.components[0].id],
                architecture.connections.map((c) => ({ source: c.source, target: c.target }))
              ),
          },
          "stub delete first with its connections"
        ),
        h(
          "button",
          { onClick: () => onDeleteSelection([], [{ source: "api", target: "db" }]) },
          "stub delete the connection"
        ),
        h("button", { onClick: () => onSelect(architecture.components[0].id) }, "stub select first"),
        h("button", { onClick: undo.run, disabled: !undo.enabled }, "Undo"),
        h("button", { onClick: redo.run, disabled: !redo.enabled }, "Redo")
      ),
  };
});

const component = (id, type, configuration = {}) => ({
  id,
  name: id.toUpperCase(),
  type,
  provider: "aws",
  configuration,
});
const ARCH = {
  project_name: "Shop",
  description: "A shop.",
  assumptions: ["10k users"],
  components: [component("api", "compute", { instances: 2 }), component("db", "database")],
  connections: [{ source: "api", target: "db", label: "" }],
};
const SCALED = {
  ...ARCH,
  components: [component("api", "compute", { instances: 8 }), component("db", "database")],
};
const FIX = {
  label: "Scale application servers to about 70% utilization",
  add_components: [],
  add_connections: [],
  update_components: [{ id: "api", configuration: { instances: 8 } }],
};

// What the backend would answer: an over-capacity issue (with a fix) until the servers are scaled.
function analysisFor({ architecture }) {
  const scaled = architecture.components.find((c) => c.id === "api")?.configuration.instances === 8;
  return Promise.resolve({
    inputs: {
      peak_requests_per_second: 900,
      number_of_servers: scaled ? 8 : 2,
      capacity_per_server: 500,
      average_latency: 150,
      monthly_budget: null,
    },
    derived: [],
    performance: {
      total_capacity: 1000,
      utilization_percentage: scaled ? 22 : 90,
      estimated_status: "Low",
      bottleneck: "None",
      recommendation: "ok",
      explanation: [],
      disclaimer: "model",
    },
    cost: {
      is_estimate: true,
      notice: "estimate",
      currency: "USD",
      breakdown: [],
      total_monthly_cost: 100,
      monthly_budget: 100,
      budget_difference: 0,
      budget_status: "Within budget",
      explanation: [],
    },
    optimization: {
      summary: scaled ? "No issues." : "Found 1 possible issue.",
      limitations: [],
      notice: "",
      recommendations: scaled
        ? []
        : [
            {
              id: "high-utilization",
              severity: "high",
              confidence: "medium",
              issue: "High server utilization",
              explanation: "90% used.",
              recommendation: "Add servers.",
              affected_components: ["api"],
              fix: FIX,
            },
          ],
    },
  });
}

const SESSION = { token: "tok", user: { id: 1, email: "me@example.com" } };

function loggedIn() {
  api.getToken.mockReturnValue("tok");
  api.fetchMe.mockResolvedValue(SESSION.user);
}

async function generate(user) {
  await user.type(screen.getByLabelText("Requirements"), "  Build a shop  ");
  await user.click(screen.getByRole("button", { name: "Generate Architecture" }));
  await screen.findByTestId("diagram");
}

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getToken.mockReturnValue(null);
    api.getCatalog.mockResolvedValue({ types: ["compute", "database", "search"], providers: ["aws", "gcp"] });
    api.listProjects.mockResolvedValue({ items: [], total: 0, limit: 5, offset: 0 });
    api.listTrash.mockResolvedValue([]);
    api.generateArchitecture.mockResolvedValue(ARCH);
    api.extractRequirements.mockResolvedValue({ expected_users: 1000, notes: [] });
    api.analyzeArchitecture.mockImplementation(analysisFor);
    api.applyFix.mockResolvedValue(SCALED);
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  describe("signing in", () => {
    it("shows the login form when nobody is signed in, then opens the workspace after login", async () => {
      api.login.mockResolvedValue(SESSION);
      const user = userEvent.setup();
      render(<App />);

      expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
      await user.type(screen.getByLabelText("Email"), "me@example.com");
      await user.type(screen.getByLabelText("Password"), "password123");
      await user.click(screen.getByRole("button", { name: "Log in" }));

      expect(await screen.findByText(/Signed in as me@example.com/)).toBeInTheDocument();
      expect(api.setToken).toHaveBeenCalledWith("tok");
    });

    it("restores a saved session without asking again", async () => {
      loggedIn();
      render(<App />);
      expect(await screen.findByText(/Signed in as me@example.com/)).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Log in" })).not.toBeInTheDocument();
    });

    it("falls back to the login form when the saved session is no longer valid", async () => {
      api.getToken.mockReturnValue("expired");
      api.fetchMe.mockRejectedValue(new Error("Please log in."));
      render(<App />);
      expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
      expect(api.setToken).toHaveBeenCalledWith(null);
    });

    it("logs out", async () => {
      loggedIn();
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole("button", { name: "Log out" }));
      expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
      expect(api.setToken).toHaveBeenCalledWith(null);
    });
  });

  describe("working on a design", () => {
    async function open() {
      loggedIn();
      const user = userEvent.setup();
      render(<App />);
      await screen.findByText(/Signed in as/);
      await generate(user);
      return user;
    }

    it("generates an architecture, reads the requirements, and analyzes it automatically", async () => {
      await open();
      expect(api.generateArchitecture).toHaveBeenCalledWith("Build a shop", expect.any(Object)); // trimmed
      expect(api.extractRequirements).toHaveBeenCalledWith("Build a shop");
      expect(screen.getAllByTestId("node").map((n) => n.textContent)).toEqual(["api", "db"]);
      expect(await screen.findByText("High server utilization")).toBeInTheDocument();
      expect(api.analyzeArchitecture.mock.calls[0][0].architecture).toEqual(ARCH);
      expect(api.analyzeArchitecture.mock.calls[0][0].requirements).toMatchObject({ expected_users: 1000 });
    });

    it("shows a generation error instead of a design", async () => {
      api.generateArchitecture.mockRejectedValue(new Error("AI service request failed"));
      loggedIn();
      const user = userEvent.setup();
      render(<App />);
      await screen.findByText(/Signed in as/);
      await user.type(screen.getByLabelText("Requirements"), "Build a shop");
      await user.click(screen.getByRole("button", { name: "Generate Architecture" }));
      expect(await screen.findByText("AI service request failed")).toBeInTheDocument();
      expect(screen.queryByTestId("diagram")).not.toBeInTheDocument();
    });

    it("adds a component, and undo and redo move through the change", async () => {
      const user = await open();
      await user.click(screen.getByRole("button", { name: "stub add" }));
      expect(screen.getAllByTestId("node").map((n) => n.textContent)).toEqual([
        "api",
        "db",
        "search-service",
      ]);

      await user.click(screen.getByRole("button", { name: "Undo" }));
      expect(screen.getAllByTestId("node")).toHaveLength(2);
      expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();

      await user.click(screen.getByRole("button", { name: "Redo" }));
      expect(screen.getAllByTestId("node")).toHaveLength(3);
    });

    it("re-analyzes after an edit", async () => {
      const user = await open();
      await screen.findByText("High server utilization");
      const callsBefore = api.analyzeArchitecture.mock.calls.length;
      await user.click(screen.getByRole("button", { name: "stub add" }));
      await waitFor(() => expect(api.analyzeArchitecture.mock.calls.length).toBeGreaterThan(callsBefore), {
        timeout: 4000,
      });
      const last = api.analyzeArchitecture.mock.calls.at(-1)[0];
      expect(last.architecture.components).toHaveLength(3);
    });

    it("does not add a duplicate connection", async () => {
      const user = await open();
      expect(screen.getByTestId("edge-count")).toHaveTextContent("1");
      await user.click(screen.getByRole("button", { name: "stub connect first to second" })); // api -> db exists
      expect(screen.getByTestId("edge-count")).toHaveTextContent("1");
      expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled(); // nothing changed, so nothing to undo
    });

    it("deleting a component also removes its connections, and undo brings both back", async () => {
      const user = await open();
      await user.click(screen.getByRole("button", { name: "stub delete first" }));
      expect(screen.getAllByTestId("node").map((n) => n.textContent)).toEqual(["db"]);
      expect(screen.getByTestId("edge-count")).toHaveTextContent("0");

      await user.click(screen.getByRole("button", { name: "Undo" }));
      expect(screen.getAllByTestId("node")).toHaveLength(2);
      expect(screen.getByTestId("edge-count")).toHaveTextContent("1");
    });

    it("a delete that removes a component and its connections is ONE undo step", async () => {
      const user = await open();
      await user.click(screen.getByRole("button", { name: "stub delete first with its connections" }));
      expect(screen.getAllByTestId("node")).toHaveLength(1);
      expect(screen.getByTestId("edge-count")).toHaveTextContent("0");

      await user.click(screen.getByRole("button", { name: "Undo" }));
      expect(screen.getAllByTestId("node")).toHaveLength(2);
      expect(screen.getByTestId("edge-count")).toHaveTextContent("1"); // both came back together
      expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled(); // nothing earlier to undo
    });

    it("deleting only a connection keeps both components", async () => {
      const user = await open();
      await user.click(screen.getByRole("button", { name: "stub delete the connection" }));
      expect(screen.getAllByTestId("node")).toHaveLength(2);
      expect(screen.getByTestId("edge-count")).toHaveTextContent("0");
      await user.click(screen.getByRole("button", { name: "Undo" }));
      expect(screen.getByTestId("edge-count")).toHaveTextContent("1");
    });

    it("edits the project details", async () => {
      const user = await open();
      await user.click(screen.getByRole("button", { name: "Edit details" }));
      const editor = document.querySelector(".details-editor"); // the Projects panel has a "Project name" box too
      const name = within(editor).getByLabelText("Project name");
      await user.clear(name);
      await user.type(name, "Renamed Shop");
      await user.click(screen.getByRole("button", { name: "Save details" }));
      expect(screen.getByRole("heading", { name: "Renamed Shop" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Undo" }));
      expect(screen.getByRole("heading", { name: "Shop" })).toBeInTheDocument();
    });

    it("applies a recommendation's fix, re-analyzes, and can be undone", async () => {
      const user = await open();
      const card = (await screen.findByText("High server utilization")).closest("li");
      await user.click(within(card).getByRole("button", { name: "Apply fix" }));

      expect(api.applyFix).toHaveBeenCalledWith(ARCH, FIX);
      // the issue disappears once the analysis of the scaled design comes back
      expect(await screen.findByText("No issues.", {}, { timeout: 4000 })).toBeInTheDocument();
      expect(screen.queryByText("High server utilization")).not.toBeInTheDocument();
      expect(api.analyzeArchitecture.mock.calls.at(-1)[0].architecture).toEqual(SCALED);

      await user.click(screen.getByRole("button", { name: "Undo" }));
      expect(await screen.findByText("High server utilization", {}, { timeout: 4000 })).toBeInTheDocument();
    });

    it("shows why a fix could not be applied and leaves the design alone", async () => {
      api.applyFix.mockRejectedValue(new Error("Component 'api' no longer exists"));
      const user = await open();
      const card = (await screen.findByText("High server utilization")).closest("li");
      await user.click(within(card).getByRole("button", { name: "Apply fix" }));
      expect(await screen.findByText("Component 'api' no longer exists")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    });

    it("asks before replacing a design that has not been saved", async () => {
      const user = await open();
      window.confirm.mockReturnValue(false);
      await user.click(screen.getByRole("button", { name: "Generate Architecture" }));
      expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("not saved"));
      expect(api.generateArchitecture).toHaveBeenCalledTimes(1);

      window.confirm.mockReturnValue(true);
      await user.click(screen.getByRole("button", { name: "Generate Architecture" }));
      await waitFor(() => expect(api.generateArchitecture).toHaveBeenCalledTimes(2));
    });

    it("marks a new design as not saved yet", async () => {
      await open();
      expect(screen.getByText("Not saved yet")).toBeInTheDocument();
    });
  });
});

describe("App: AI assistant, toolkit, export and sharing", () => {
  const PATCH = {
    label: "Add search",
    add_components: [{ id: "search", name: "Search", type: "search", provider: "aws" }],
  };
  const OTHER = {
    ...ARCH,
    project_name: "Imported",
    components: [component("web", "compute")],
    connections: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.getToken.mockReturnValue("tok");
    api.fetchMe.mockResolvedValue(SESSION.user);
    api.getCatalog.mockResolvedValue({ types: ["compute", "database", "search"], providers: ["aws"] });
    api.listProjects.mockResolvedValue({ items: [], total: 0, limit: 5, offset: 0 });
    api.listTrash.mockResolvedValue([]);
    api.generateArchitecture.mockResolvedValue(ARCH);
    api.extractRequirements.mockResolvedValue({ expected_users: 1000, notes: [] });
    api.analyzeArchitecture.mockImplementation(analysisFor);
    api.applyFix.mockResolvedValue(SCALED);
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  async function open() {
    const user = userEvent.setup({ applyAccept: false });
    render(<App />);
    await screen.findByText(/Signed in as/);
    await generate(user);
    return user;
  }

  it("opens a share link as a read-only page for someone who is not logged in", async () => {
    window.history.pushState({}, "", "/?shared=abc123");
    api.getToken.mockReturnValue(null);
    api.getSharedDesign.mockResolvedValue({
      name: "Shop",
      updated_at: "now",
      architecture: ARCH,
      document: {
        title: "Shared Shop",
        description: "",
        generated_on: "2026-11-18",
        requirements: [],
        assumptions: [],
        components: [],
        connections: [],
        mermaid: "",
        performance: [],
        cost: { currency: "USD", lines: [], total: 0, budget: null, status: "", notice: "" },
        recommendations: [],
        risks: [],
        capacity: [],
        reliability: [],
        decisions: [],
        patterns: [],
        notes: [],
      },
    });
    api.sharedDiagramUrl.mockReturnValue("http://x/diagram.svg");
    try {
      render(<App />);
      expect(await screen.findByRole("heading", { name: "Shared Shop" })).toBeInTheDocument();
      expect(api.getSharedDesign).toHaveBeenCalledWith("abc123");
      expect(api.fetchMe).not.toHaveBeenCalled();
      expect(screen.queryByRole("heading", { name: "Log in" })).not.toBeInTheDocument();
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("shows progress while the design is written", async () => {
    let finish;
    api.generateArchitecture.mockImplementation((_prompt, options) => {
      options.onProgress(1500);
      return new Promise((resolve) => (finish = () => resolve(ARCH)));
    });
    render(<App />);
    await screen.findByText(/Signed in as/);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Requirements"), "Build a shop");
    await user.click(screen.getByRole("button", { name: "Generate Architecture" }));
    expect(await screen.findByText(/Written so far: 1,500 characters/)).toBeInTheDocument();
    finish();
    await screen.findByTestId("diagram");
    expect(screen.queryByText(/Written so far/)).not.toBeInTheDocument();
  });

  it("asks for feedback on the new design and sends it, noting a cached answer", async () => {
    api.generateArchitecture.mockImplementation(async (_prompt, options) => {
      options.meta.cached = true;
      return ARCH;
    });
    api.sendFeedback.mockResolvedValue(null);
    const user = await open();
    expect(screen.getByText("cached result")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Helpful" }));
    expect(api.sendFeedback).toHaveBeenCalledWith("Build a shop", "Shop", 1, "");
  });

  it("changes the design from a sentence only after the user accepts the suggested change", async () => {
    api.refineArchitecture.mockResolvedValue({
      summary: "Add search.",
      patch: PATCH,
      diff: { added: ["Search (search)"], removed: [], changed: [] },
      source: "ai",
      cached: false,
    });
    const user = await open();
    await user.type(screen.getByLabelText("Describe a change"), "add search");
    await user.click(screen.getByRole("button", { name: "Suggest change" }));
    await screen.findByRole("region", { name: "Suggested change" });
    expect(api.refineArchitecture).toHaveBeenCalledWith(
      ARCH,
      expect.objectContaining({ expected_users: 1000 }),
      "add search"
    );
    expect(api.applyFix).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("node")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(api.applyFix).toHaveBeenCalledWith(ARCH, PATCH));
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled()); // one undo step
  });

  it("regenerates with the current design as context, and undo brings the old design back", async () => {
    api.regenerateArchitecture.mockResolvedValue(OTHER);
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Regenerate keeping my edits" }));
    await waitFor(() => expect(screen.getAllByTestId("node").map((n) => n.textContent)).toEqual(["web"]));
    expect(api.regenerateArchitecture).toHaveBeenCalledWith("Build a shop", ARCH);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getAllByTestId("node").map((n) => n.textContent)).toEqual(["api", "db"]);
  });

  it("keeps the design when regenerating fails and says why", async () => {
    api.regenerateArchitecture.mockRejectedValue(new Error("AI service is busy"));
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Regenerate keeping my edits" }));
    expect(await screen.findByText("AI service is busy")).toBeInTheDocument();
    expect(screen.getAllByTestId("node")).toHaveLength(2);
  });

  it("fills the requirements box from an imported file", async () => {
    api.importDocument.mockResolvedValue({
      text: "A shop for 5000 users.",
      source: "file",
      truncated: false,
      note: "",
    });
    render(<App />);
    const user = userEvent.setup({ applyAccept: false });
    await screen.findByText(/Signed in as/);
    await user.upload(
      screen.getByLabelText("Choose a file to import"),
      new File(["x"], "brief.txt", { type: "text/plain" })
    );
    await waitFor(() => expect(screen.getByLabelText("Requirements")).toHaveValue("A shop for 5000 users."));
  });

  it("loads an imported design file as a new unsaved design, asking first", async () => {
    api.importDesign.mockResolvedValue({
      architecture: OTHER,
      requirements: { expected_users: 7, notes: [] },
      notes: [],
    });
    const user = await open();
    await user.click(screen.getByRole("tab", { name: "Download and import" }));
    window.confirm.mockReturnValue(false);
    await user.upload(
      screen.getByLabelText("Choose a design file"),
      new File(["{}"], "d.json", { type: "application/json" })
    );
    expect(await screen.findByText("Import cancelled.")).toBeInTheDocument();
    expect(screen.getAllByTestId("node").map((n) => n.textContent)).toEqual(["api", "db"]);

    window.confirm.mockReturnValue(true);
    await user.upload(
      screen.getByLabelText("Choose a design file"),
      new File(["{}"], "d.json", { type: "application/json" })
    );
    await waitFor(() => expect(screen.getAllByTestId("node").map((n) => n.textContent)).toEqual(["web"]));
    expect(screen.getByText("Not saved yet")).toBeInTheDocument();
  });

  it("adds a multi-region design as a new variant", async () => {
    api.planMultiRegion.mockResolvedValue({
      regions: [
        { code: "us-east-1", name: "N. Virginia" },
        { code: "eu-west-1", name: "Ireland" },
      ],
      latency_matrix: {},
      latency_rows: [],
      average_latency_before_ms: null,
      average_latency_after_ms: null,
      links: [],
      failover: [],
      changes: [],
      architecture: OTHER,
      notes: [],
    });
    const user = await open();
    await user.click(screen.getByRole("tab", { name: "Multi-region" }));
    await user.click(await screen.findByRole("button", { name: "Add as a new variant" }));
    const tabs = await screen.findByRole("tablist", { name: "Variants of this design" });
    expect(within(tabs).getAllByRole("tab")).toHaveLength(2);
    expect(within(tabs).getByRole("tab", { name: /Multi-region/ })).toBeInTheDocument();
    expect(screen.getAllByTestId("node").map((n) => n.textContent)).toEqual(["web"]); // the new variant is open
  });

  it("offers sharing and history once the project is saved", async () => {
    api.createProject.mockResolvedValue({ id: 9, name: "Shop", updated_at: "now" });
    api.getShare.mockResolvedValue({ shared: false, token: null });
    api.listVersions.mockResolvedValue({
      items: [{ id: 1, label: "Created", created_at: "now", component_count: 2, variant_count: 1 }],
    });
    const user = await open();
    await user.click(screen.getByRole("tab", { name: "Share" }));
    expect(screen.getByText(/Save the project first/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save project" }));
    await waitFor(() => expect(api.createProject).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Create a share link" })).toBeInTheDocument();
    expect(api.getShare).toHaveBeenCalledWith(9);

    await user.click(screen.getByRole("tab", { name: "Version history" }));
    expect(await screen.findByText(/Created/, { selector: "td" })).toBeInTheDocument();
    expect(api.listVersions).toHaveBeenCalledWith(9);
  });

  it("restoring a version reopens the project from the server", async () => {
    api.createProject.mockResolvedValue({ id: 9, name: "Shop", updated_at: "now" });
    api.listVersions.mockResolvedValue({
      items: [
        { id: 2, label: "Saved", created_at: "t2", component_count: 1, variant_count: 1 },
        { id: 1, label: "Created", created_at: "t1", component_count: 2, variant_count: 1 },
      ],
    });
    api.restoreVersion.mockResolvedValue({ restored: 1 });
    api.getProject.mockResolvedValue({
      id: 9,
      name: "Shop",
      prompt: "Build a shop",
      architecture: OTHER,
      requirements: { expected_users: 3, notes: [] },
      updated_at: "now",
    });
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Save project" }));
    await waitFor(() => expect(api.createProject).toHaveBeenCalled());
    await user.click(screen.getByRole("tab", { name: "Version history" }));
    await user.click((await screen.findAllByRole("button", { name: "Restore" }))[0]);
    await waitFor(() => expect(screen.getAllByTestId("node").map((n) => n.textContent)).toEqual(["web"]));
    expect(api.getProject).toHaveBeenCalledWith(9);
  });
});
