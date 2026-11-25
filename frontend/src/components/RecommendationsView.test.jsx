import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import RecommendationsView from "./RecommendationsView.jsx";

const fix = {
  label: "Scale application servers to about 70% utilization",
  add_components: [{ id: "cache", name: "Cache", type: "cache", provider: "aws", configuration: {} }],
  add_connections: [{ source: "api", target: "cache", label: "" }],
  update_components: [{ id: "api", configuration: { instances: 8 } }],
};

const data = {
  summary: "Found 2 possible issues.",
  limitations: ["Roles are guessed."],
  notice: "Suggestions only.",
  recommendations: [
    {
      id: "high-utilization",
      severity: "critical",
      confidence: "medium",
      issue: "Servers are over capacity",
      explanation: "Utilization is 250%.",
      recommendation: "Add servers.",
      affected_components: ["api"],
      fix,
    },
    {
      id: "missing-cache",
      severity: "low",
      confidence: "medium",
      issue: "No cache found",
      explanation: "No cache.",
      recommendation: "Consider one.",
      affected_components: [],
      fix: null,
    },
  ],
};

const preview = {
  before: {
    total_monthly_cost: 785,
    utilization_percentage: 250,
    number_of_servers: 4,
    issue_count: 3,
    component_count: 9,
    budget_status: "Within budget",
  },
  after: {
    total_monthly_cost: 1555,
    utilization_percentage: 66.7,
    number_of_servers: 15,
    issue_count: 2,
    component_count: 10,
    budget_status: "Within budget",
  },
};

function setup(props = {}) {
  const handlers = { onApplyFix: vi.fn(), onPreviewFix: vi.fn().mockResolvedValue(preview) };
  render(<RecommendationsView data={data} nameById={{ api: "API Servers" }} {...handlers} {...props} />);
  return { user: userEvent.setup(), ...handlers };
}

describe("RecommendationsView", () => {
  it("lists the issues with severity counts and what each affects", () => {
    setup();
    expect(screen.getByText("Servers are over capacity")).toBeInTheDocument();
    expect(screen.getByText("1 critical")).toBeInTheDocument();
    expect(screen.getByText("1 low")).toBeInTheDocument();
    expect(screen.getByText("API Servers")).toBeInTheDocument();
  });

  it("describes in plain words what a fix will change", () => {
    setup();
    expect(screen.getByText("Add Cache (cache)")).toBeInTheDocument();
    expect(screen.getByText("Add 1 connection")).toBeInTheDocument();
    expect(screen.getByText("API Servers: set instances = 8")).toBeInTheDocument();
  });

  it("offers a fix only where one exists", () => {
    setup();
    expect(screen.getAllByRole("button", { name: "Apply fix" })).toHaveLength(1);
  });

  it("applies the fix when asked", async () => {
    const { user, onApplyFix } = setup();
    await user.click(screen.getByRole("button", { name: "Apply fix" }));
    expect(onApplyFix).toHaveBeenCalledWith(fix);
  });

  it("previews the before and after numbers, marking improvements and regressions", async () => {
    const { user, onPreviewFix } = setup();
    await user.click(screen.getByRole("button", { name: "Preview impact" }));
    expect(onPreviewFix).toHaveBeenCalledWith(fix);

    const table = await screen.findByRole("table");
    const row = (label) => within(table).getByText(label).closest("tr");
    expect(row("Monthly cost")).toHaveTextContent("$785→$1,555");
    expect(within(row("Monthly cost")).getByText("$1,555")).toHaveClass("tone-worse");
    expect(row("Utilization")).toHaveTextContent("250%→66.7%");
    expect(within(row("Utilization")).getByText("66.7%")).toHaveClass("tone-good");
    expect(row("Web servers")).toHaveTextContent("4→15");
    expect(within(row("Open issues")).getByText("2")).toHaveClass("tone-good");
    expect(screen.getByRole("button", { name: "Refresh preview" })).toBeInTheDocument();
  });

  it("shows why a preview failed", async () => {
    const { user } = setup({
      onPreviewFix: vi.fn().mockRejectedValue(new Error("Component 'api' no longer exists")),
    });
    await user.click(screen.getByRole("button", { name: "Preview impact" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer exists");
  });

  it("disables Apply while a fix is being applied", () => {
    setup({ applying: true });
    expect(screen.getByRole("button", { name: "Applying…" })).toBeDisabled();
  });

  it("hides fixes when applying is not available", () => {
    setup({ onApplyFix: undefined });
    expect(screen.queryByRole("button", { name: "Apply fix" })).not.toBeInTheDocument();
  });

  it("shows an apply error", () => {
    setup({ fixError: "A component with id 'cache' already exists." });
    expect(screen.getByRole("alert")).toHaveTextContent("already exists");
  });

  it("says when nothing was found", () => {
    setup({ data: { ...data, summary: "No issues.", recommendations: [] } });
    expect(screen.getByText("No issues.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument(); // no recommendation cards
  });
});
