import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api/client.js";
import VariantBar from "../VariantBar.jsx";
import { newVariant } from "../../variants.js";
import BudgetAdvisor from "./BudgetAdvisor.jsx";
import CompareVariants from "./CompareVariants.jsx";
import Growth from "./Growth.jsx";
import LineChart from "./LineChart.jsx";
import Planning from "./Planning.jsx";
import WhatIf from "./WhatIf.jsx";

vi.mock("../../api/client.js", () => ({
  compareVariants: vi.fn(),
  whatIf: vi.fn(),
  growth: vi.fn(),
  budgetAdvisor: vi.fn(),
}));

const ARCH = {
  project_name: "Shop",
  description: "",
  components: [{ id: "api", name: "API", type: "compute", provider: "aws", configuration: {} }],
  connections: [],
  assumptions: [],
};
const SHARED = { requirements: { monthly_budget: 300 }, capacity: null, latency: null, trafficScale: 1 };

beforeEach(() => vi.resetAllMocks());

describe("VariantBar", () => {
  const variants = [
    newVariant("a", "Original", ARCH),
    newVariant("b", "Cheap", ARCH, { trafficScale: 0.25 }),
  ];

  function setup(props = {}) {
    const handlers = {
      onSwitch: vi.fn(),
      onAdd: vi.fn(),
      onRename: vi.fn(),
      onDuplicate: vi.fn(),
      onDelete: vi.fn(),
      onTrafficShare: vi.fn(),
    };
    const user = userEvent.setup();
    render(<VariantBar variants={variants} activeId="a" busy={false} error="" {...handlers} {...props} />);
    return { user, ...handlers };
  }

  it("shows every variant, the open one, and its traffic share", () => {
    setup();
    expect(screen.getByRole("tab", { name: "Original" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /Cheap/ })).toHaveTextContent("25% traffic");
  });

  it("switches variant and offers the ways to add one", async () => {
    const { user, onSwitch, onAdd } = setup();
    await user.click(screen.getByRole("tab", { name: /Cheap/ }));
    expect(onSwitch).toHaveBeenCalledWith("b");
    await user.click(screen.getByRole("button", { name: "Add variant" }));
    const items = screen.getAllByRole("menuitem");
    expect(items.length).toBeGreaterThanOrEqual(3);
    await user.click(items[0]);
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(); // closes after a choice
  });

  it("renames the open variant, ignores a blank name, and can be cancelled", async () => {
    const { user, onRename } = setup();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const box = screen.getByLabelText("Variant name");
    expect(box).toHaveValue("Original");
    await user.clear(box);
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
    await user.type(box, "Main");
    await user.click(screen.getByRole("button", { name: "Save name" }));
    expect(onRename).toHaveBeenCalledWith("a", "Main");

    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Variant name")).not.toBeInTheDocument();
  });

  it("duplicates and deletes the open variant, but never the last one", async () => {
    const { user, onDuplicate, onDelete } = setup();
    await user.click(screen.getByRole("button", { name: "Duplicate" }));
    await user.click(screen.getByRole("button", { name: "Delete variant" }));
    expect(onDuplicate).toHaveBeenCalledWith("a");
    expect(onDelete).toHaveBeenCalledWith("a");
  });

  it("cannot delete when there is only one variant", () => {
    setup({ variants: [variants[0]] });
    expect(screen.getByRole("button", { name: "Delete variant" })).toBeDisabled();
  });

  it("changes the traffic share only for valid percentages", async () => {
    const { user, onTrafficShare } = setup();
    const box = screen.getByLabelText(/Traffic this design serves/);
    expect(box).toHaveValue(100);
    await user.clear(box);
    await user.type(box, "40");
    expect(onTrafficShare).toHaveBeenLastCalledWith("a", 0.4);
    onTrafficShare.mockClear();
    await user.clear(box);
    await user.type(box, "0");
    expect(onTrafficShare).not.toHaveBeenCalled(); // below 0.1%
  });

  it("stops adding at six variants and while busy, and shows an error", () => {
    const six = Array.from({ length: 6 }, (_, i) => newVariant(`v${i}`, `V${i}`, ARCH));
    setup({ variants: six, activeId: "v0", error: "Preset failed" });
    expect(screen.getByRole("button", { name: /Limit of 6 reached/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Duplicate" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Preset failed");
  });

  it("shows when variants are being added", () => {
    setup({ busy: true });
    expect(screen.getByRole("button", { name: "Adding…" })).toBeDisabled();
  });
});

describe("Planning section", () => {
  function setup(props = {}) {
    const handlers = { onSwitchVariant: vi.fn(), onAddStandard: vi.fn(), onApplyPatch: vi.fn() };
    const user = userEvent.setup();
    render(
      <Planning
        variants={[newVariant("a", "Original", ARCH)]}
        activeId="a"
        architecture={ARCH}
        requirements={{ monthly_budget: 300 }}
        settings={{ capacity: null, latency: null }}
        trafficScale={1}
        addingVariants={false}
        applying={false}
        {...handlers}
        {...props}
      />
    );
    return { user, ...handlers };
  }

  it("asks for an architecture first", () => {
    render(<Planning architecture={null} variants={[]} settings={{}} />);
    expect(screen.getByText(/Generate an architecture first/)).toBeInTheDocument();
  });

  it("has four tabs, works with arrow keys, and only the open tool calls the server", async () => {
    api.compareVariants.mockResolvedValue({ variants: [], notes: [] });
    api.whatIf.mockResolvedValue(WHATIF);
    const { user } = setup();
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(api.whatIf).not.toHaveBeenCalled();
    screen.getByRole("tab", { name: "Compare variants" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Traffic what-if" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(api.whatIf).toHaveBeenCalledTimes(1));
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Budget advisor" })).toHaveAttribute("aria-selected", "true");
  });

  it("offers to create the three standard variants when there is only one", async () => {
    const { user, onAddStandard } = setup();
    await user.click(screen.getByRole("button", { name: /Create Cheap, Balanced and Highly available/ }));
    expect(onAddStandard).toHaveBeenCalled();
  });
});

describe("Compare variants", () => {
  const variants = [
    { id: "a", name: "Original", architecture: ARCH, traffic_scale: 1 },
    { id: "b", name: "Cheap", architecture: ARCH, traffic_scale: 1 },
  ];
  const row = (id, name, overrides = {}) => ({
    id,
    name,
    error: null,
    component_count: 6,
    number_of_servers: 4,
    requests_per_second: 900,
    utilization_percentage: 45,
    status: "Moderate",
    bottleneck: "",
    monthly_cost: 700,
    budget_status: "Over budget",
    discount_savings: 0,
    issues: { critical: 0, high: 1, medium: 0, low: 0 },
    single_points_of_failure: 2,
    resilience_score: 85,
    cost_rank: 2,
    resilience_rank: 1,
    ...overrides,
  });

  it("shows one column per variant with ranks, badges and the suggestion", async () => {
    api.compareVariants.mockResolvedValue({
      variants: [
        row("a", "Original"),
        row("b", "Cheap", {
          monthly_cost: 300,
          cost_rank: 1,
          resilience_rank: 2,
          resilience_score: 70,
          issues: { critical: 0, high: 0, medium: 0, low: 0 },
          budget_status: "Within budget",
        }),
      ],
      recommended_id: "b",
      recommendation: "Cheap is the best fit.",
      notes: ["Estimates only."],
    });
    const onSwitch = vi.fn();
    const user = userEvent.setup();
    render(
      <CompareVariants
        variants={variants}
        shared={SHARED}
        activeId="a"
        onSwitch={onSwitch}
        onAddStandard={vi.fn()}
        adding={false}
      />
    );
    expect(await screen.findByText("Cheap is the best fit.")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getByText("Recommended")).toBeInTheDocument();
    expect(within(table).getByText("cheapest")).toBeInTheDocument();
    expect(within(table).getByText("most resilient")).toBeInTheDocument();
    expect(within(table).getByText("1 high")).toBeInTheDocument();
    expect(within(table).getByText("None")).toBeInTheDocument();
    expect(within(table).getByText("Over budget")).toBeInTheDocument();
    await user.click(within(table).getByRole("button", { name: "Open" }));
    expect(onSwitch).toHaveBeenCalledWith("b");
    expect(within(table).getByText("Open", { selector: ".tag" })).toBeInTheDocument(); // the open variant is marked
  });

  it("shows a variant that could not be analyzed without hiding the others", async () => {
    api.compareVariants.mockResolvedValue({
      variants: [row("a", "Original"), row("b", "Broken", { error: "no web servers" })],
      recommended_id: "a",
      recommendation: "",
      notes: [],
    });
    render(
      <CompareVariants
        variants={variants}
        shared={SHARED}
        activeId="a"
        onSwitch={vi.fn()}
        onAddStandard={vi.fn()}
        adding={false}
      />
    );
    expect(await screen.findByText(/Broken could not be analyzed: no web servers/)).toBeInTheDocument();
  });

  it("shows the server's error", async () => {
    api.compareVariants.mockRejectedValue(new Error("Compare failed"));
    render(
      <CompareVariants
        variants={variants}
        shared={SHARED}
        activeId="a"
        onSwitch={vi.fn()}
        onAddStandard={vi.fn()}
        adding={false}
      />
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Compare failed");
  });

  it("does not call the server with fewer than two variants", () => {
    render(
      <CompareVariants
        variants={[variants[0]]}
        shared={SHARED}
        activeId="a"
        onSwitch={vi.fn()}
        onAddStandard={vi.fn()}
        adding
      />
    );
    expect(api.compareVariants).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
  });
});

const WHATIF = {
  base_requests_per_second: 100,
  number_of_servers: 2,
  capacity_per_server: 100,
  capacity_requests_per_second: 200,
  comfortable_requests_per_second: 140,
  target_utilization: 70,
  low_utilization_below: 30,
  high_utilization_above: 80,
  base_monthly_cost: 200,
  server_monthly_price: 50,
  points: [
    {
      requests_per_second: 10,
      users_equivalent: 1000,
      utilization_percentage: 5,
      status: "Low",
      bottleneck: "",
      servers_needed: 1,
      monthly_cost_if_scaled: 200,
    },
    {
      requests_per_second: 1000,
      users_equivalent: 100000,
      utilization_percentage: 500,
      status: "High",
      bottleneck: "",
      servers_needed: 15,
      monthly_cost_if_scaled: 850,
    },
  ],
  notes: ["A model, not a measurement."],
};

describe("Traffic what-if", () => {
  it("starts at today's traffic and recalculates locally as the slider moves", async () => {
    api.whatIf.mockResolvedValue(WHATIF);
    const user = userEvent.setup();
    render(<WhatIf architecture={ARCH} shared={SHARED} />);
    expect(await screen.findByText(/100 req\/s/)).toBeInTheDocument();
    expect(screen.getByText("50%", { selector: ".card-value" })).toBeInTheDocument(); // 100 of 200 req/s
    expect(screen.getByText("Moderate")).toBeInTheDocument();
    expect(api.whatIf).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "10×" })); // 1000 req/s
    expect(screen.getByText("500%", { selector: ".card-value" })).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.getByText("15", { selector: ".card-value" })).toBeInTheDocument(); // servers needed: 1000 / (100 x 70%)
    expect(api.whatIf).toHaveBeenCalledTimes(1); // no new server call for slider moves
  });

  it("jumps to an exact value, clamped to the slider's range", async () => {
    api.whatIf.mockResolvedValue(WHATIF);
    const user = userEvent.setup();
    render(<WhatIf architecture={ARCH} shared={SHARED} />);
    const exact = await screen.findByLabelText("Exact req/s");
    await user.clear(exact);
    await user.type(exact, "50");
    expect(screen.getByLabelText(/Traffic:/)).toBeInTheDocument();
    expect(Number(screen.getByRole("slider").value)).toBeCloseTo(Math.log10(0.5), 1);
    await user.clear(exact);
    await user.type(exact, "999999");
    expect(screen.getByRole("slider")).toHaveValue("1"); // never beyond ten times today's peak
  });

  it("describes the chart for screen readers and lists the numbers", async () => {
    api.whatIf.mockResolvedValue(WHATIF);
    render(<WhatIf architecture={ARCH} shared={SHARED} />);
    await screen.findByText(/100 req\/s/);
    expect(
      screen.getAllByRole("img").some((i) => /Utilization rises/.test(i.getAttribute("aria-label") ?? ""))
    ).toBe(true);
    expect(screen.getByText("A model, not a measurement.")).toBeInTheDocument();
  });

  it("shows the server's error", async () => {
    api.whatIf.mockRejectedValue(new Error("No web servers"));
    render(<WhatIf architecture={ARCH} shared={SHARED} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("No web servers");
  });
});

describe("Growth", () => {
  const GROWTH = {
    months: [0, 6, 12].map((m) => ({
      month: m,
      requests_per_second: 100 * 1.1 ** m,
      tiers: {
        web: { utilization_percentage: 10 + m * 5, instances_needed: 1 + m },
        database: { utilization_percentage: 5, instances_needed: 1 },
      },
      monthly_cost_if_scaled: 200 + m * 10,
    })),
    tiers: [
      {
        kind: "web",
        name: "Web servers",
        instances: 2,
        capacity_per_instance: 100,
        assumption: "Your capacity setting",
        first_scale_month: 6,
      },
      {
        kind: "database",
        name: "Database",
        instances: 1,
        capacity_per_instance: 1000,
        assumption: "A round planning number",
        first_scale_month: null,
      },
    ],
    base_monthly_cost: 200,
    total_cost_if_scaled: 2800,
    total_cost_unchanged: 2400,
    target_utilization: 70,
    high_utilization_above: 80,
    assumptions: ["Growth is steady."],
  };

  it("shows when each tier needs to scale and the cost of keeping up", async () => {
    api.growth.mockResolvedValue(GROWTH);
    render(<Growth architecture={ARCH} shared={SHARED} />);
    expect((await screen.findAllByText("Web servers")).length).toBeGreaterThan(0);
    expect(screen.getByText("Scale by month 6")).toBeInTheDocument();
    expect(screen.getByText("Growth is steady.")).toBeInTheDocument();
    expect(api.growth).toHaveBeenCalledWith(ARCH, SHARED, expect.any(Number), expect.any(Number));
  });

  it("asks again when the growth rate changes", async () => {
    api.growth.mockResolvedValue(GROWTH);
    const user = userEvent.setup();
    render(<Growth architecture={ARCH} shared={SHARED} />);
    await screen.findAllByText("Web servers");
    const rate = screen.getAllByRole("spinbutton")[0];
    await user.clear(rate);
    await user.type(rate, "25");
    await waitFor(() => expect(api.growth).toHaveBeenLastCalledWith(ARCH, SHARED, 25, expect.any(Number)));
  });

  it("shows the server's error", async () => {
    api.growth.mockRejectedValue(new Error("Growth failed"));
    render(<Growth architecture={ARCH} shared={SHARED} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Growth failed");
  });
});

describe("Budget advisor", () => {
  const step = (label, saving, total, risk = "low") => ({
    label,
    saving,
    total_after: total,
    utilization_after: 60,
    risk,
    risk_note: `Note for ${label}`,
    patch: { label },
    cumulative_patch: { label: `up to ${label}` },
  });
  const ADVICE = {
    current_total: 500,
    budget: 300,
    over_by: 200,
    reachable: true,
    final_total: 280,
    steps: [step("Right-size the web servers", 120, 380), step("Trim the cache", 100, 280, "medium")],
    notes: ["Prices are estimates."],
  };

  it("starts from the budget in the requirements and lists safest steps first", async () => {
    api.budgetAdvisor.mockResolvedValue(ADVICE);
    render(<BudgetAdvisor architecture={ARCH} shared={SHARED} onApplyPatch={vi.fn()} applying={false} />);
    expect(screen.getByLabelText("Monthly budget (USD)")).toHaveValue(300);
    expect(await screen.findByText("Right-size the web servers")).toBeInTheDocument();
    expect(api.budgetAdvisor).toHaveBeenCalledWith(ARCH, SHARED, 300);
    expect(screen.getByText("Over budget by")).toBeInTheDocument();
    expect(screen.getByText("Fits the budget")).toBeInTheDocument();
    const steps = screen.getAllByRole("listitem").filter((li) => li.classList.contains("advisor-step"));
    expect(steps).toHaveLength(2);
  });

  it("applies a step or every step up to it with one click", async () => {
    api.budgetAdvisor.mockResolvedValue(ADVICE);
    const onApplyPatch = vi.fn();
    const user = userEvent.setup();
    render(
      <BudgetAdvisor architecture={ARCH} shared={SHARED} onApplyPatch={onApplyPatch} applying={false} />
    );
    await user.click(await screen.findByRole("button", { name: "Apply this step" }));
    expect(onApplyPatch).toHaveBeenLastCalledWith({ label: "up to Right-size the web servers" });
    await user.click(screen.getByRole("button", { name: "Apply steps 1 to 2 (everything)" }));
    expect(onApplyPatch).toHaveBeenLastCalledWith({ label: "up to Trim the cache" });
  });

  it("disables the buttons while a change is being applied", async () => {
    api.budgetAdvisor.mockResolvedValue(ADVICE);
    render(<BudgetAdvisor architecture={ARCH} shared={SHARED} onApplyPatch={vi.fn()} applying />);
    expect(await screen.findByRole("button", { name: "Apply this step" })).toBeDisabled();
  });

  it("says when the design already fits, and when it still does not", async () => {
    api.budgetAdvisor.mockResolvedValue({
      ...ADVICE,
      steps: [],
      over_by: -100,
      notes: ["Already within your budget."],
    });
    render(<BudgetAdvisor architecture={ARCH} shared={SHARED} onApplyPatch={vi.fn()} applying={false} />);
    expect(await screen.findByText("Already within your budget.")).toBeInTheDocument();
    expect(screen.getByText("Headroom")).toBeInTheDocument();
  });

  it("does not ask the server for a missing or invalid budget", async () => {
    const user = userEvent.setup();
    render(
      <BudgetAdvisor
        architecture={ARCH}
        shared={{ ...SHARED, requirements: {} }}
        onApplyPatch={vi.fn()}
        applying={false}
      />
    );
    await new Promise((r) => setTimeout(r, 600));
    expect(api.budgetAdvisor).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Monthly budget (USD)"), "-5");
    expect(screen.getByText("The budget must be 0 or more.")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 600));
    expect(api.budgetAdvisor).not.toHaveBeenCalled();
  });
});

describe("LineChart", () => {
  it("draws each series, the reference lines and the marker, with a text summary", () => {
    const { container } = render(
      <LineChart
        summary="Utilization rises with traffic."
        series={[
          {
            name: "Utilization",
            points: [
              { x: 0, y: 0 },
              { x: 10, y: 50 },
              { x: 20, y: 100 },
            ],
          },
        ]}
        refLines={[{ y: 80, label: "80% high", tone: "warn" }]}
        vLines={[{ x: 15, label: "limit" }]}
        marker={{ x: 10, y: 50 }}
        xMax={20}
        yMax={120}
        formatX={(x) => `${x} rps`}
        formatY={(y) => `${y}%`}
        xLabel="Requests"
        yLabel="Utilization"
      />
    );
    expect(screen.getByRole("img", { name: "Utilization rises with traffic." })).toBeInTheDocument();
    expect(container.querySelectorAll("path").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("80% high")).toBeInTheDocument();
    expect(screen.getByText("limit")).toBeInTheDocument();
    expect(screen.getByText("Requests")).toBeInTheDocument();
  });

  it("copes with a series that has a single point", () => {
    render(
      <LineChart
        summary="One point."
        series={[{ name: "A", points: [{ x: 1, y: 1 }] }]}
        xMax={2}
        formatX={String}
        formatY={String}
      />
    );
    expect(screen.getByRole("img", { name: "One point." })).toBeInTheDocument();
  });
});
