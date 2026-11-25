import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api/client.js";
import ExportShare from "./ExportShare.jsx";
import SharedView from "./SharedView.jsx";

vi.mock("../../api/client.js", () => ({
  compareVersion: vi.fn(),
  createShare: vi.fn(),
  fetchAllProjects: vi.fn(),
  fetchCostCsv: vi.fn(),
  fetchDesignFile: vi.fn(),
  fetchDiagramFile: vi.fn(),
  fetchDocumentFile: vi.fn(),
  getProject: vi.fn(),
  getShare: vi.fn(),
  getSharedDesign: vi.fn(),
  importDesign: vi.fn(),
  listVersions: vi.fn(),
  restoreVersion: vi.fn(),
  revokeShare: vi.fn(),
  saveBlob: vi.fn(),
  sharedDiagramUrl: vi.fn((token) => `http://api.test/api/shared/${token}/diagram.svg`),
}));

const ARCH = {
  project_name: "Shop",
  description: "",
  components: [{ id: "api", name: "API", type: "compute", provider: "aws", configuration: {} }],
  connections: [],
  assumptions: [],
};
const file = (text, filename) => ({ blob: new Blob([text]), filename });

function setup(props = {}) {
  const handlers = { onImport: vi.fn().mockReturnValue(true), onRestored: vi.fn() };
  const user = userEvent.setup({ applyAccept: false });
  render(
    <ExportShare
      architecture={ARCH}
      requirements={{ expected_users: 10 }}
      settings={{ capacity: 100, latency: 20 }}
      trafficScale={0.5}
      projectId={null}
      unsaved={false}
      {...handlers}
      {...props}
    />
  );
  return { user, ...handlers };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.sharedDiagramUrl.mockImplementation((t) => `http://api.test/api/shared/${t}/diagram.svg`);
  api.fetchDocumentFile.mockResolvedValue(file("# doc", "shop.md"));
  api.fetchCostCsv.mockResolvedValue(file("Item", "shop-cost.csv"));
  api.fetchDesignFile.mockResolvedValue(file("{}", "shop.sysdesign.json"));
  api.fetchDiagramFile.mockResolvedValue(file("<svg/>", "shop.svg"));
});

describe("Export: downloads", () => {
  it("offers to import before any design exists", () => {
    render(<ExportShare architecture={null} onImport={vi.fn()} />);
    expect(screen.getByText(/Generate or import an architecture first/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import a design file" })).toBeInTheDocument();
  });

  it("downloads the document with the analysis settings the user has on screen", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Document (Markdown)" }));
    expect(api.fetchDocumentFile).toHaveBeenCalledWith(
      ARCH,
      { expected_users: 10 },
      { capacity: 100, latency: 20, trafficScale: 0.5 }
    );
    await waitFor(() => expect(api.saveBlob).toHaveBeenCalledWith(expect.any(Blob), "shop.md"));
    expect(await screen.findByText("Saved shop.md.")).toBeInTheDocument();
  });

  it.each([
    ["Cost table (CSV)", "shop-cost.csv"],
    ["Design file (JSON)", "shop.sysdesign.json"],
    ["SVG image", "shop.svg"],
  ])("downloads %s", async (label, filename) => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(api.saveBlob).toHaveBeenCalledWith(expect.any(Blob), filename));
  });

  it("shows why a download failed and re-enables the buttons", async () => {
    api.fetchCostCsv.mockRejectedValue(new Error("Can't reach the backend."));
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Cost table (CSV)" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Can't reach the backend");
    expect(screen.getByRole("button", { name: "Cost table (CSV)" })).toBeEnabled();
  });

  it("copies the diagram as Mermaid text", async () => {
    api.fetchDiagramFile.mockResolvedValue(file("flowchart LR\n", "shop.mmd"));
    const { user } = setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await user.click(screen.getByRole("button", { name: "Copy as Mermaid" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("flowchart LR\n"));
    expect(await screen.findByText("Mermaid text copied.")).toBeInTheDocument();
    expect(api.fetchDiagramFile).toHaveBeenCalledWith(ARCH, "mermaid");
  });

  describe("printable document", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("opens the document in a new tab for printing", async () => {
      api.fetchDocumentFile.mockResolvedValue(file("<html></html>", "shop.html"));
      const tab = { location: { href: "" }, close: vi.fn() };
      vi.stubGlobal("open", vi.fn().mockReturnValue(tab));
      URL.createObjectURL = vi.fn().mockReturnValue("blob:printable");
      const { user } = setup();
      await user.click(screen.getByRole("button", { name: "Document for PDF (print)" }));
      await waitFor(() => expect(tab.location.href).toBe("blob:printable"));
      expect(api.fetchDocumentFile).toHaveBeenCalledWith(ARCH, expect.anything(), expect.anything(), "html");
      expect(await screen.findByText(/Save as PDF/)).toBeInTheDocument();
    });

    it("downloads it instead when the browser blocks the new tab", async () => {
      api.fetchDocumentFile.mockResolvedValue(file("<html></html>", "shop.html"));
      vi.stubGlobal("open", vi.fn().mockReturnValue(null));
      const { user } = setup();
      await user.click(screen.getByRole("button", { name: "Document for PDF (print)" }));
      await waitFor(() => expect(api.saveBlob).toHaveBeenCalledWith(expect.any(Blob), "shop.html"));
    });

    it("closes the empty tab if the document cannot be made", async () => {
      api.fetchDocumentFile.mockRejectedValue(new Error("boom"));
      const tab = { location: { href: "" }, close: vi.fn() };
      vi.stubGlobal("open", vi.fn().mockReturnValue(tab));
      const { user } = setup();
      await user.click(screen.getByRole("button", { name: "Document for PDF (print)" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("boom");
      expect(tab.close).toHaveBeenCalled();
    });
  });
});

describe("Export: import a design file", () => {
  const upload = async (user, contents, name = "design.json") =>
    user.upload(
      screen.getByLabelText("Choose a design file"),
      new File([contents], name, { type: "application/json" })
    );

  it("loads the checked design and reports what was repaired", async () => {
    api.importDesign.mockResolvedValue({
      architecture: ARCH,
      requirements: { expected_users: 5 },
      notes: ["1 connection(s) were dropped."],
    });
    const { user, onImport } = setup();
    await upload(user, JSON.stringify({ components: [] }));
    await waitFor(() => expect(onImport).toHaveBeenCalledWith(ARCH, { expected_users: 5 }));
    expect(
      await screen.findByText(/imported as a new, unsaved design\. 1 connection\(s\) were dropped/)
    ).toBeInTheDocument();
  });

  it("says so when the user cancels the replace-confirmation", async () => {
    api.importDesign.mockResolvedValue({ architecture: ARCH, requirements: null, notes: [] });
    const { user } = setup({ onImport: vi.fn().mockReturnValue(false) });
    await upload(user, "{}");
    expect(await screen.findByText("Import cancelled.")).toBeInTheDocument();
  });

  it.each([
    ["not json at all", "not valid JSON"],
    ["[1, 2]", "not a design"],
    ["42", "not a design"],
  ])("refuses %s before asking the server", async (contents, why) => {
    const { user, onImport } = setup();
    await upload(user, contents);
    expect(await screen.findByRole("alert")).toHaveTextContent(why);
    expect(api.importDesign).not.toHaveBeenCalled();
    expect(onImport).not.toHaveBeenCalled();
  });

  it("shows the server's reason for a bad design", async () => {
    api.importDesign.mockRejectedValue(
      new Error("That file does not look like a design: it has no list of components.")
    );
    const { user, onImport } = setup();
    await upload(user, "{}");
    expect(await screen.findByRole("alert")).toHaveTextContent("no list of components");
    expect(onImport).not.toHaveBeenCalled();
  });
});

describe("Export: sharing", () => {
  it("needs a saved project first", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "Share" }));
    expect(screen.getByText(/Save the project first/)).toBeInTheDocument();
    expect(api.getShare).not.toHaveBeenCalled();
  });

  it("creates a link, shows it with embed code, and turns it off", async () => {
    api.getShare.mockResolvedValueOnce({ shared: false, token: null });
    api.createShare.mockResolvedValue({ shared: true, token: "T".repeat(30) });
    api.revokeShare.mockResolvedValue({ shared: false, token: null });
    const { user } = setup({ projectId: 7 });
    await user.click(screen.getByRole("tab", { name: "Share" }));

    api.getShare.mockResolvedValue({ shared: true, token: "T".repeat(30) });
    await user.click(await screen.findByRole("button", { name: "Create a share link" }));
    expect(api.createShare).toHaveBeenCalledWith(7);
    const link = await screen.findByLabelText("Link");
    expect(link.value).toContain(`?shared=${"T".repeat(30)}`);
    expect(link).toHaveAttribute("readonly");

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await user.click(screen.getByRole("button", { name: "Copy embed code (image)" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('<img src="http://api.test/api/shared/'))
    );

    api.getShare.mockResolvedValue({ shared: false, token: null });
    await user.click(screen.getByRole("button", { name: "Turn off the link" }));
    expect(api.revokeShare).toHaveBeenCalledWith(7);
    expect(await screen.findByRole("button", { name: "Create a share link" })).toBeInTheDocument();
  });

  it("warns that the link shows the last saved version when there are unsaved changes", async () => {
    api.getShare.mockResolvedValue({ shared: false, token: null });
    const { user } = setup({ projectId: 7, unsaved: true });
    await user.click(screen.getByRole("tab", { name: "Share" }));
    expect(await screen.findByText(/last saved version, not the changes on screen/)).toBeInTheDocument();
  });

  it("shows an error if the link cannot be created", async () => {
    api.getShare.mockResolvedValue({ shared: false, token: null });
    api.createShare.mockRejectedValue(new Error("Project not found."));
    const { user } = setup({ projectId: 7 });
    await user.click(screen.getByRole("tab", { name: "Share" }));
    await user.click(await screen.findByRole("button", { name: "Create a share link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Project not found.");
  });
});

describe("Export: version history", () => {
  const versions = {
    items: [
      { id: 3, label: "Saved", created_at: "2026-11-18 12:00:00", component_count: 5, variant_count: 1 },
      { id: 2, label: "Saved", created_at: "2026-11-18 11:00:00", component_count: 6, variant_count: 2 },
      { id: 1, label: "Created", created_at: "2026-11-18 10:00:00", component_count: 6, variant_count: 1 },
    ],
  };

  async function openHistory(props = {}) {
    api.listVersions.mockResolvedValue(versions);
    const result = setup({ projectId: 7, ...props });
    await result.user.click(screen.getByRole("tab", { name: "Version history" }));
    await screen.findByText("2026-11-18 12:00:00");
    return result;
  }

  it("lists versions newest first and cannot restore the latest", async () => {
    await openHistory();
    expect(screen.getByText(/Saved \(latest\)/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Restore" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Compare with now" })).toHaveLength(3);
  });

  it("compares a version with now in words", async () => {
    api.compareVersion.mockResolvedValue({
      version: versions.items[2],
      added: [],
      removed: ["Product Images"],
      changed: ["API: instances 2 → 4"],
      renamed: "Shop → Shop v2",
      identical: false,
    });
    const { user } = await openHistory();
    await user.click(screen.getAllByRole("button", { name: "Compare with now" })[2]);
    const region = await screen.findByRole("region", { name: "Changes since this version" });
    expect(api.compareVersion).toHaveBeenCalledWith(7, 1);
    expect(within(region).getByText("Product Images")).toBeInTheDocument();
    expect(within(region).getByText("API: instances 2 → 4")).toBeInTheDocument();
    expect(within(region).getByText(/Renamed: Shop → Shop v2/)).toBeInTheDocument();
  });

  it("says when nothing has changed", async () => {
    api.compareVersion.mockResolvedValue({
      version: versions.items[0],
      added: [],
      removed: [],
      changed: [],
      renamed: "",
      identical: true,
    });
    const { user } = await openHistory();
    await user.click(screen.getAllByRole("button", { name: "Compare with now" })[0]);
    expect(await screen.findByText("Nothing has changed.")).toBeInTheDocument();
  });

  it("restores after confirmation and reopens the project", async () => {
    api.restoreVersion.mockResolvedValue({ restored: 1 });
    api.getProject.mockResolvedValue({ id: 7, name: "Shop" });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user, onRestored } = await openHistory();
    await user.click(screen.getAllByRole("button", { name: "Restore" })[1]);
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith({ id: 7, name: "Shop" }));
    expect(api.restoreVersion).toHaveBeenCalledWith(7, 1);
  });

  it("does nothing if the user declines the confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { user, onRestored } = await openHistory();
    await user.click(screen.getAllByRole("button", { name: "Restore" })[0]);
    expect(api.restoreVersion).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();
  });

  it("shows an error when restoring fails", async () => {
    api.restoreVersion.mockRejectedValue(new Error("Version not found."));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user, onRestored } = await openHistory();
    await user.click(screen.getAllByRole("button", { name: "Restore" })[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Version not found.");
    expect(onRestored).not.toHaveBeenCalled();
  });
});

describe("Export: my data", () => {
  it("downloads every project", async () => {
    api.fetchAllProjects.mockResolvedValue(file("{}", "my-sysdesign-projects.json"));
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "Your data" }));
    await user.click(screen.getByRole("button", { name: "Download all my projects" }));
    await waitFor(() =>
      expect(api.saveBlob).toHaveBeenCalledWith(expect.any(Blob), "my-sysdesign-projects.json")
    );
    expect(await screen.findByText(/Saved\./)).toBeInTheDocument();
  });

  it("shows an error when it fails", async () => {
    api.fetchAllProjects.mockRejectedValue(new Error("Request failed (401)."));
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "Your data" }));
    await user.click(screen.getByRole("button", { name: "Download all my projects" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("401");
  });
});

describe("Shared page (read-only, no login)", () => {
  const doc = {
    title: "Shop",
    description: "An online shop.",
    generated_on: "2026-11-18",
    requirements: [{ label: "Expected users", value: "100,000" }],
    assumptions: ["10k users"],
    components: [{ name: "API Servers", type: "compute", provider: "aws", settings: "instances = 4" }],
    connections: [],
    mermaid: "",
    performance: [{ label: "Utilization", value: "12.0% (Low)" }],
    cost: {
      currency: "USD",
      lines: [
        {
          name: "API Servers",
          resource_type: "compute",
          quantity: 4,
          unit: "instance",
          unit_price: 35,
          monthly_cost: 140,
        },
      ],
      total: 140,
      budget: 500,
      status: "within budget",
      notice: "Estimates only.",
    },
    recommendations: [{ severity: "critical", issue: "No backups", recommendation: "Add backups" }],
    risks: [],
    capacity: [],
    reliability: [],
    decisions: [],
    patterns: [],
    notes: [],
  };

  it("shows the design, its diagram and its analysis, with no edit controls", async () => {
    api.getSharedDesign.mockResolvedValue({
      name: "Shop",
      updated_at: "2026-11-18 10:00:00",
      document: doc,
      architecture: ARCH,
    });
    render(<SharedView token="tok" />);
    expect(await screen.findByRole("heading", { name: "Shop", level: 1 })).toBeInTheDocument();
    expect(api.getSharedDesign).toHaveBeenCalledWith("tok");
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Architecture diagram of Shop/ })).toHaveAttribute(
      "src",
      "http://api.test/api/shared/tok/diagram.svg"
    );
    expect(screen.getByText("instances = 4")).toBeInTheDocument();
    expect(screen.getByText("12.0% (Low)")).toBeInTheDocument();
    expect(screen.getByText(/Total \$140\.00 per month\./)).toBeInTheDocument();
    expect(screen.getByText(/Budget \$500\.00: within budget/)).toBeInTheDocument();
    expect(screen.getByText("critical")).toHaveClass("high"); // critical is shown with the high style
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^(save|delete|edit|generate|share)/i })
    ).not.toBeInTheDocument();
  });

  it("shows a clear message for a link that is off", async () => {
    api.getSharedDesign.mockRejectedValue(new Error("This link does not exist or has been turned off."));
    render(<SharedView token="gone" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("turned off");
    expect(screen.getByRole("link", { name: "Go to SysDesign AI" })).toBeInTheDocument();
  });

  it("shows text from the design as text, not markup", async () => {
    const hostile = {
      ...doc,
      title: "<img src=x onerror=alert(1)>",
      components: [{ name: "<script>x</script>", type: "t", provider: "p", settings: "" }],
    };
    api.getSharedDesign.mockResolvedValue({
      name: "x",
      updated_at: "now",
      document: hostile,
      architecture: ARCH,
    });
    const { container } = render(<SharedView token="tok" />);
    expect(await screen.findByText("<script>x</script>")).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img[onerror]")).toBeNull();
  });
});
