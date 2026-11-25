import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeArchitecture } from "../api/client.js";
import Analysis from "./Analysis.jsx";

vi.mock("../api/client.js", () => ({
  analyzeArchitecture: vi.fn(),
  previewFix: vi.fn(),
  getCatalog: vi.fn().mockResolvedValue({ types: ["compute"], providers: ["aws", "gcp"] }),
}));

const architecture = {
  project_name: "Shop",
  description: "",
  assumptions: [],
  connections: [],
  components: [{ id: "api", name: "API", type: "compute", provider: "aws", configuration: {} }],
};

const response = (util = 10) => ({
  inputs: {
    peak_requests_per_second: 100,
    number_of_servers: 2,
    capacity_per_server: 500,
    average_latency: 150,
    monthly_budget: null,
  },
  derived: ["Assumed 150 ms latency."],
  performance: {
    total_capacity: 1000,
    utilization_percentage: util,
    estimated_status: "Low",
    bottleneck: "None",
    recommendation: "No changes needed.",
    explanation: ["math"],
    disclaimer: "A model.",
  },
  cost: {
    is_estimate: true,
    notice: "Estimate only.",
    currency: "USD",
    breakdown: [
      {
        id: "api",
        name: "API",
        resource_type: "compute",
        unit: "instance",
        quantity: 2,
        estimated_unit_monthly_price: 70,
        price_source: "pricing table",
        monthly_cost: 140,
        share_of_total_percentage: 100,
      },
    ],
    total_monthly_cost: 140,
    monthly_budget: 140,
    budget_difference: 0,
    budget_status: "Within budget",
    explanation: ["x"],
  },
  optimization: { summary: "No issues.", recommendations: [], limitations: ["l"], notice: "n" },
});

const props = (extra = {}) => ({
  architecture,
  requirements: { expected_users: 1000, notes: [] },
  onRequirementsChange: vi.fn(),
  seedKey: "1:ready",
  requirementsStatus: "ready",
  onApplyFix: vi.fn(),
  applying: false,
  fixError: "",
  ...extra,
});

/** Let the 500 ms debounce pass and the (mocked) request settle. */
const settle = () => act(() => vi.advanceTimersByTimeAsync(700));

describe("Analysis", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    analyzeArchitecture.mockReset();
    analyzeArchitecture.mockResolvedValue(response());
  });
  afterEach(() => vi.useRealTimers());

  it("analyzes on its own, without any button, and shows all three results", async () => {
    render(<Analysis {...props()} />);
    expect(analyzeArchitecture).not.toHaveBeenCalled(); // waits for typing to pause
    await settle();
    expect(analyzeArchitecture).toHaveBeenCalledTimes(1);
    expect(analyzeArchitecture.mock.calls[0][0]).toMatchObject({
      architecture,
      requirements: { expected_users: 1000 },
      capacity_per_server: null,
      average_latency: null,
    });
    // (getBy, not findBy: findBy polls with timers, which are faked in this file)
    expect(screen.getByText("Assumed 150 ms latency.")).toBeInTheDocument();
    expect(screen.getByText("Utilization")).toBeInTheDocument(); // performance
    expect(screen.getByText("Total monthly cost")).toBeInTheDocument(); // cost
    expect(screen.getByText("No issues.")).toBeInTheDocument(); // recommendations
    expect(screen.getByText("Up to date.")).toBeInTheDocument();
  });

  it("recalculates when the architecture changes", async () => {
    const { rerender } = render(<Analysis {...props()} />);
    await settle();
    const edited = {
      ...architecture,
      components: [...architecture.components, { ...architecture.components[0], id: "db" }],
    };
    rerender(<Analysis {...props({ architecture: edited })} />);
    await settle();
    expect(analyzeArchitecture).toHaveBeenCalledTimes(2);
    expect(analyzeArchitecture.mock.calls[1][0].architecture).toBe(edited);
  });

  it("recalculates when the requirements change", async () => {
    const { rerender } = render(<Analysis {...props()} />);
    await settle();
    rerender(<Analysis {...props({ requirements: { expected_users: 5000, notes: [] } })} />);
    await settle();
    expect(analyzeArchitecture).toHaveBeenCalledTimes(2);
    expect(analyzeArchitecture.mock.calls[1][0].requirements.expected_users).toBe(5000);
  });

  it("sends one request after a burst of edits, not one per keystroke", async () => {
    render(<Analysis {...props()} />);
    await settle();
    analyzeArchitecture.mockClear();
    const capacity = screen.getByLabelText("Capacity per server (req/s)");
    for (const value of ["6", "60", "600"]) {
      fireEvent.change(capacity, { target: { value } });
      await act(() => vi.advanceTimersByTimeAsync(100));
    }
    await settle();
    expect(analyzeArchitecture).toHaveBeenCalledTimes(1);
    expect(analyzeArchitecture.mock.calls[0][0].capacity_per_server).toBe(600);
  });

  it("does not analyze while requirements are still being read", async () => {
    render(<Analysis {...props({ requirementsStatus: "loading" })} />);
    await settle();
    expect(analyzeArchitecture).not.toHaveBeenCalled();
    expect(screen.getByText("Reading your requirements…")).toBeInTheDocument();
  });

  it("does not send an invalid value, and says what is wrong", async () => {
    render(<Analysis {...props()} />);
    await settle();
    analyzeArchitecture.mockClear();
    fireEvent.change(screen.getByLabelText("Capacity per server (req/s)"), { target: { value: "-5" } });
    await settle();
    expect(screen.getByText("Capacity per server must be greater than 0.")).toBeInTheDocument();
    expect(analyzeArchitecture).not.toHaveBeenCalled();
  });

  it("tells the app about edited requirements, and clears the peak when users change", async () => {
    const onRequirementsChange = vi.fn();
    render(<Analysis {...props({ onRequirementsChange })} />);
    fireEvent.change(screen.getByLabelText("Expected users"), { target: { value: "250000" } });
    expect(onRequirementsChange).toHaveBeenLastCalledWith({
      expected_users: 250000,
      peak_requests_per_second: null, // re-estimated from the new user count
    });
    fireEvent.change(screen.getByLabelText("Monthly budget (USD)"), { target: { value: "900" } });
    expect(onRequirementsChange).toHaveBeenLastCalledWith({ monthly_budget: 900 });
    fireEvent.change(screen.getByLabelText("Region"), { target: { value: "eu-west-1" } });
    expect(onRequirementsChange).toHaveBeenLastCalledWith({ region: "eu-west-1" });
    fireEvent.change(screen.getByLabelText("Cloud provider"), { target: { value: "gcp" } });
    expect(onRequirementsChange).toHaveBeenLastCalledWith({ cloud_provider: "gcp" });
  });

  it("turns notes typed one per line into a list", () => {
    const onRequirementsChange = vi.fn();
    render(<Analysis {...props({ onRequirementsChange })} />);
    fireEvent.change(screen.getByLabelText("Other requirements (one per line)"), {
      target: { value: "PCI compliant\n\n  audit logs  \n" },
    });
    expect(onRequirementsChange).toHaveBeenLastCalledWith({ notes: ["PCI compliant", "audit logs"] });
  });

  it("fills the boxes from new requirements only when the seed key changes", () => {
    const { rerender } = render(<Analysis {...props()} />);
    expect(screen.getByLabelText("Expected users")).toHaveValue(1000);
    // what is being typed is not overwritten when the parent hands back changed requirements
    fireEvent.change(screen.getByLabelText("Expected users"), { target: { value: "1500" } });
    rerender(<Analysis {...props({ requirements: { expected_users: 999, notes: [] } })} />);
    expect(screen.getByLabelText("Expected users")).toHaveValue(1500);
    // a new design or a reopened project brings new requirements
    rerender(
      <Analysis {...props({ requirements: { expected_users: 77, notes: ["n"] }, seedKey: "2:ready" })} />
    );
    expect(screen.getByLabelText("Expected users")).toHaveValue(77);
    expect(screen.getByLabelText("Other requirements (one per line)")).toHaveValue("n");
  });

  it("shows an error when the analysis fails, and recovers on the next success", async () => {
    analyzeArchitecture.mockRejectedValueOnce(new Error("None of the components could be priced"));
    const { rerender } = render(<Analysis {...props()} />);
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("None of the components could be priced");
    rerender(<Analysis {...props({ requirements: { expected_users: 1, notes: [] } })} />);
    await settle();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Total monthly cost")).toBeInTheDocument();
  });

  it("asks for an architecture first when there is none", () => {
    render(<Analysis {...props({ architecture: null })} />);
    expect(screen.getByText(/Generate an architecture first/)).toBeInTheDocument();
    expect(analyzeArchitecture).not.toHaveBeenCalled();
  });
});
