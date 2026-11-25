import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api/client.js";
import { duration, pct } from "./files.js";
import { GlossaryProvider, GlossaryText, Term } from "./glossary.jsx";
import Explain from "./Explain.jsx";
import SequenceDiagram from "./SequenceDiagram.jsx";
import Toolkit from "./Toolkit.jsx";

vi.mock("../../api/client.js", () => ({
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
}));

const ARCH = {
  project_name: "Shop",
  description: "",
  components: [
    { id: "api", name: "API", type: "compute", provider: "aws", configuration: {} },
    { id: "db", name: "DB", type: "database", provider: "aws", configuration: {} },
  ],
  connections: [{ source: "api", target: "db", label: "sql" }],
  assumptions: [],
};
const FIX = {
  label: "Make DB multi-zone",
  update_components: [{ id: "db", configuration: { multi_az: true } }],
};

const GLOSSARY = {
  terms: [
    { term: "RTO", definition: "How long recovery may take." },
    { term: "Read replica", definition: "A read-only copy." },
    { term: "Replica", definition: "A copy." },
    { term: "Index", definition: "A lookup structure." },
  ],
};

function setup(props = {}) {
  const handlers = {
    onRequirementsChange: vi.fn(),
    onApplyPatch: vi.fn(),
    onAddVariant: vi.fn(),
  };
  const user = userEvent.setup();
  render(
    <Toolkit architecture={ARCH} requirements={{}} applying={false} canAddVariant {...handlers} {...props} />
  );
  return { user, ...handlers };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.getGlossary.mockResolvedValue(GLOSSARY);
  api.estimateCapacity.mockResolvedValue({
    inputs: [
      {
        key: "total_users",
        label: "Total users",
        value: 1000,
        unit: "users",
        source: "default",
        hint: "h",
        minimum: 0,
        maximum: 1e9,
      },
    ],
    lines: [
      {
        section: "Traffic",
        label: "Peak requests",
        value: 42,
        unit: "req/s",
        formula: "1000 x 2 / 86400",
        note: "",
      },
      { section: "Storage", label: "Storage per year", value: 7, unit: "GB", formula: "a x b", note: "n" },
    ],
    headlines: ["About 42 requests per second at peak."],
    comparison: ["Your web tier is fine."],
    notes: ["Estimates only."],
  });
});

describe("Toolkit", () => {
  it("asks for an architecture first", () => {
    render(<Toolkit architecture={null} requirements={null} />);
    expect(screen.getByText(/Generate an architecture first/)).toBeInTheDocument();
    expect(api.estimateCapacity).not.toHaveBeenCalled();
  });

  it("shows nine tabs and calculates only the open one", async () => {
    setup();
    expect(screen.getAllByRole("tab")).toHaveLength(9);
    expect(await screen.findByText("About 42 requests per second at peak.")).toBeInTheDocument();
    expect(api.estimateCapacity).toHaveBeenCalledTimes(1);
    expect(api.getPatterns).not.toHaveBeenCalled();
    expect(api.estimateReliability).not.toHaveBeenCalled();
  });

  it("moves between tabs with the arrow keys", async () => {
    const { user } = setup();
    screen.getByRole("tab", { name: "Capacity" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "API design" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Learn" })).toHaveAttribute("aria-selected", "true"); // wraps around
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "toolkit-tab-learn");
  });

  it("reports a failure in a tool without breaking the others", async () => {
    api.estimateCapacity.mockRejectedValue(new Error("Backend is down"));
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("Backend is down");
    expect(screen.getAllByRole("tab")).toHaveLength(9);
  });
});

describe("Capacity", () => {
  it("shows each result with its formula and groups them by section", async () => {
    setup();
    expect(await screen.findByText("1000 x 2 / 86400")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Traffic" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Storage" })).toBeInTheDocument();
    expect(screen.getByText("Your web tier is fine.")).toBeInTheDocument();
  });

  it("saves an assumption you type into the requirements, and removes it when you clear it", async () => {
    const { user, onRequirementsChange } = setup({ requirements: { capacity_inputs: { total_users: 500 } } });
    const box = await screen.findByLabelText(/Total users/);
    expect(box).toHaveValue(500);
    await user.clear(box);
    expect(onRequirementsChange).toHaveBeenLastCalledWith({ capacity_inputs: {} });
    await user.type(box, "250");
    expect(onRequirementsChange).toHaveBeenLastCalledWith({ capacity_inputs: { total_users: 250 } });
  });

  it("shows the assumed value as a placeholder when you have not set one", async () => {
    setup();
    expect(await screen.findByLabelText(/Total users/)).toHaveAttribute("placeholder", "1,000");
  });
});

describe("Reliability", () => {
  const reliability = {
    estimated_availability_percent: 99.8301,
    downtime_minutes_per_year: 893.2,
    downtime_minutes_per_month: 74.4,
    target_availability_percent: 99.99,
    availability_gap_percent: -0.16,
    estimated_rto_minutes: 30,
    estimated_rpo_minutes: 1440,
    rto_reason: "The database is a single instance",
    rpo_reason: "Nightly backups",
    components: [
      { id: "db", name: "DB", availability_percent: 99.5, why: "Single zone", on_critical_path: true },
    ],
    verdicts: ["Availability: the estimate is short of the 99.99% target."],
    advice: [
      { title: "Make DB multi-zone", detail: "A standby takes over.", fix: FIX },
      { title: "No fix here", detail: "Just advice.", fix: null },
    ],
    assumptions: ["One server is 99.5%."],
  };

  it("shows the estimate, the verdicts and the component table", async () => {
    api.estimateReliability.mockResolvedValue(reliability);
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "Reliability" }));
    expect(await screen.findByText("99.83%")).toBeInTheDocument();
    expect(screen.getByText(/short of the 99.99% target/)).toBeInTheDocument();
    expect(screen.getByText("1 day")).toBeInTheDocument(); // an RPO of 1440 minutes
    expect(within(screen.getByRole("table")).getByText("Single zone")).toBeInTheDocument();
  });

  it("applies an advised fix, and only offers a button where there is a fix", async () => {
    api.estimateReliability.mockResolvedValue(reliability);
    const { user, onApplyPatch } = setup();
    await user.click(screen.getByRole("tab", { name: "Reliability" }));
    await user.click(await screen.findByRole("button", { name: "Make DB multi-zone" }));
    expect(onApplyPatch).toHaveBeenCalledWith(FIX);
    expect(screen.getAllByRole("button", { name: /multi-zone/ })).toHaveLength(1);
  });

  it("saves targets into the requirements", async () => {
    api.estimateReliability.mockResolvedValue(reliability);
    const { user, onRequirementsChange } = setup({ requirements: { reliability: { rto_minutes: 10 } } });
    await user.click(screen.getByRole("tab", { name: "Reliability" }));
    await user.type(await screen.findByLabelText(/Availability target/), "99.9");
    expect(onRequirementsChange).toHaveBeenLastCalledWith({
      reliability: { rto_minutes: 10, availability_percent: 99.9 },
    });
  });
});

describe("Patterns", () => {
  it("groups patterns by status and applies a fix", async () => {
    api.getPatterns.mockResolvedValue({
      patterns: [
        {
          id: "a",
          name: "Read replicas",
          status: "recommended",
          summary: "s",
          why: "w",
          when_to_use: "u",
          when_not_to: "n",
          trade_offs: "t",
          how: "h",
          fix: FIX,
        },
        {
          id: "b",
          name: "CQRS",
          status: "not needed",
          summary: "s",
          why: "w",
          when_to_use: "u",
          when_not_to: "n",
          trade_offs: "t",
          how: "h",
          fix: null,
        },
      ],
    });
    const { user, onApplyPatch } = setup();
    await user.click(screen.getByRole("tab", { name: "Patterns" }));
    expect(await screen.findByRole("heading", { name: /Recommended for this design/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Not needed yet/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Worth considering/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: FIX.label }));
    expect(onApplyPatch).toHaveBeenCalledWith(FIX);
  });
});

describe("Multi-region", () => {
  const regions = [
    { code: "us-east-1", name: "N. Virginia" },
    { code: "eu-west-1", name: "Ireland" },
    { code: "ap-south-1", name: "Mumbai" },
  ];
  const plan = (overrides = {}) => ({
    regions,
    latency_matrix: {},
    latency_rows: [],
    average_latency_before_ms: null,
    average_latency_after_ms: null,
    links: [],
    failover: ["Detect.", "Route."],
    changes: ["Add 6 component(s) in eu-west-1"],
    architecture: { ...ARCH, project_name: "Multi" },
    notes: [],
    ...overrides,
  });

  it("asks for the plan with the chosen regions and mode", async () => {
    api.planMultiRegion.mockResolvedValue(plan());
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "Multi-region" }));
    await user.click(await screen.findByRole("checkbox", { name: /Ireland/ }));
    await user.click(screen.getByRole("radio", { name: /Active-active/ }));
    await waitFor(() =>
      expect(api.planMultiRegion).toHaveBeenLastCalledWith(
        ARCH,
        {},
        expect.objectContaining({
          primary_region: "us-east-1",
          secondary_regions: ["eu-west-1"],
          mode: "active-active",
        })
      )
    );
  });

  it("limits other regions to four", async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ code: `r-${i}`, name: `Region ${i}` }));
    api.planMultiRegion.mockResolvedValue(plan({ regions: [{ code: "us-east-1", name: "Home" }, ...many] }));
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "Multi-region" }));
    for (let i = 0; i < 4; i++)
      await user.click(await screen.findByRole("checkbox", { name: new RegExp(`Region ${i}`) }));
    expect(screen.getByRole("checkbox", { name: /Region 5/ })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Region 0/ })).toBeEnabled();
  });

  it("shows latency before and after for users, and adds the result as a variant", async () => {
    api.planMultiRegion.mockResolvedValue(
      plan({
        average_latency_before_ms: 90,
        average_latency_after_ms: 20,
        latency_rows: [
          {
            user_region: "eu-west-1",
            percent: 100,
            nearest_region: "eu-west-1",
            primary_latency_ms: 90,
            best_latency_ms: 20,
          },
        ],
      })
    );
    const { user, onAddVariant } = setup();
    await user.click(screen.getByRole("tab", { name: "Multi-region" }));
    await user.click(await screen.findByRole("button", { name: "Add where users are" }));
    expect(await screen.findByText("90 ms", { selector: ".card-value" })).toBeInTheDocument();
    expect(screen.getByText("20 ms", { selector: ".card-value" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Add as a new variant" }));
    expect(onAddVariant).toHaveBeenCalledWith(
      expect.stringContaining("Multi-region"),
      expect.objectContaining({ project_name: "Multi" })
    );
  });

  it("cannot add a variant when the limit is reached", async () => {
    api.planMultiRegion.mockResolvedValue(plan());
    const { user } = setup({ canAddVariant: false });
    await user.click(screen.getByRole("tab", { name: "Multi-region" }));
    expect(await screen.findByRole("button", { name: "Add as a new variant" })).toBeDisabled();
    expect(screen.getByText(/limit has been reached/)).toBeInTheDocument();
  });

  it("shows the server's reason when the plan is refused", async () => {
    api.planMultiRegion.mockRejectedValue(new Error("'mars-1' is not a region this tool knows."));
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "Multi-region" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("mars-1");
  });
});

describe("Sequence diagrams", () => {
  const flow = (id, extra = {}) => ({
    id,
    title: `Flow ${id}`,
    description: "d",
    available: true,
    reason: "",
    participants: [
      { id: "c", name: "Client", kind: "client" },
      { id: "a", name: "API", kind: "api" },
    ],
    steps: [
      { kind: "call", source: "c", target: "a", label: "GET /items" },
      { kind: "return", source: "a", target: "c", label: "200 OK" },
    ],
    mermaid: "sequenceDiagram\n",
    ...extra,
  });

  it("draws the first available flow and switches flows", async () => {
    api.designSequences.mockResolvedValue({
      domain: "generic",
      flows: [
        flow("login", { available: false, reason: "No auth service in this design." }),
        flow("read"),
        flow("write"),
      ],
    });
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "Sequence diagrams" }));
    expect(await screen.findByRole("heading", { name: "Flow read" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /2 messages between Client, API/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Flow login/ }));
    expect(screen.getByText("No auth service in this design.")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /messages between/ })).not.toBeInTheDocument();
  });

  it("draws arrows, a dashed return, notes and an alt frame", () => {
    const { container } = render(
      <SequenceDiagram
        title="T"
        participants={[
          { id: "c", name: "Client", kind: "client" },
          { id: "a", name: "API", kind: "api" },
        ]}
        steps={[
          { kind: "call", source: "c", target: "a", label: "go" },
          { kind: "call", source: "a", target: "a", label: "think" },
          { kind: "alt", label: "cache hit" },
          { kind: "return", source: "a", target: "c", label: "fast" },
          { kind: "else", label: "miss" },
          { kind: "async", source: "a", target: "c", label: "later" },
          { kind: "end" },
          { kind: "note", source: "c", target: "a", label: "a note" },
        ]}
      />
    );
    expect(container.querySelectorAll("line.seq-line")).toHaveLength(3); // call, return, async
    expect(container.querySelectorAll("line.seq-line.dashed")).toHaveLength(1);
    expect(container.querySelectorAll("path.seq-line")).toHaveLength(1); // the self-call loop
    expect(container.querySelectorAll("rect.seq-frame")).toHaveLength(1);
    expect(container.querySelector(".seq-note")).toBeInTheDocument();
    expect(screen.getByText("alt cache hit")).toBeInTheDocument();
  });

  it("closes frames that were left open and ignores stray else or end steps", () => {
    const { container } = render(
      <SequenceDiagram
        title="T"
        participants={[{ id: "a", name: "A", kind: "api" }]}
        steps={[{ kind: "else", label: "x" }, { kind: "end" }, { kind: "alt", label: "open" }]}
      />
    );
    expect(container.querySelectorAll("rect.seq-frame")).toHaveLength(1);
  });
});

describe("Other tools", () => {
  it("shows the API design with an OpenAPI download", async () => {
    api.designApi.mockResolvedValue({
      domain: "ecommerce",
      base_path: "/api/v1",
      conventions: ["Use plurals."],
      groups: [
        {
          name: "Orders",
          description: "d",
          endpoints: [
            {
              method: "POST",
              path: "/orders",
              summary: "Place an order",
              auth: "user",
              service: "API",
              idempotent: true,
              paginated: false,
              note: "",
            },
          ],
        },
      ],
      openapi: { openapi: "3.0.3", paths: {} },
      notes: [],
    });
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "API design" }));
    expect(await screen.findByText("/orders")).toBeInTheDocument();
    expect(screen.getByText("POST")).toHaveClass("method-post");
    expect(screen.getByText(/safe to repeat/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download openapi.json" })).toBeInTheDocument();
  });

  it("shows the data model, and says so when there is no SQL", async () => {
    api.designDataModel.mockResolvedValue({
      domain: "generic",
      dialect: "none",
      entities: [
        {
          name: "Item",
          description: "d",
          store: "document",
          fields: [{ name: "id", type: "uuid", key: "pk", nullable: false, references: "", note: "" }],
          indexes: ["id"],
          note: "",
        },
      ],
      relations: [{ source: "Item", target: "Owner", kind: "one-to-many", via: "owner_id" }],
      mermaid: "erDiagram\n",
      sql: "",
      notes: [],
    });
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "Data model" }));
    expect(await screen.findByText("primary key")).toBeInTheDocument();
    expect(screen.getByText(/Item → Owner: one-to-many \(through owner_id\)/)).toBeInTheDocument();
    expect(screen.getByText(/no relational database/)).toBeInTheDocument();
  });

  it("lists decisions with their alternatives", async () => {
    api.getDecisions.mockResolvedValue({
      markdown: "# ADR",
      records: [
        {
          id: "ADR-001",
          title: "Use Postgres",
          status: "Proposed",
          context: "c",
          decision: "d",
          alternatives: [{ name: "MongoDB", pros: ["flexible"], cons: ["joins"] }],
          consequences: ["Need backups"],
          components: ["db"],
        },
      ],
    });
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "Decisions" }));
    expect(await screen.findByText(/ADR-001: Use Postgres/)).toBeInTheDocument();
    expect(screen.getByText("MongoDB")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /all as Markdown/ })).toBeInTheDocument();
  });

  it("searches the glossary in the Learn tab", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "Learn" }));
    expect(await screen.findByText("How long recovery may take.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Search terms"), "copy");
    expect(screen.queryByText("RTO")).not.toBeInTheDocument();
    expect(screen.getByText("Read replica")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Search terms"));
    await user.type(screen.getByLabelText("Search terms"), "zzz");
    expect(screen.getByText(/No term matches/)).toBeInTheDocument();
  });
});

describe("Glossary tips", () => {
  async function renderTip(node) {
    render(<GlossaryProvider>{node}</GlossaryProvider>);
    await waitFor(() => expect(api.getGlossary).toHaveBeenCalled());
  }

  it("underlines a known term with its definition and leaves unknown words alone", async () => {
    await renderTip(
      <p>
        <span>
          <Term>RTO</Term>
        </span>
        <span>
          <Term>Nonsense</Term>
        </span>
      </p>
    );
    const tip = await screen.findByText("RTO");
    expect(tip).toHaveAttribute("data-definition", "How long recovery may take.");
    expect(tip).toHaveAttribute("tabindex", "0");
    expect(screen.getByText("Nonsense")).not.toHaveAttribute("data-definition");
  });

  it("marks only the first mention of a term and prefers the longest match", async () => {
    await renderTip(
      <GlossaryText>A read replica helps. The read replica again. RTO matters, rto too.</GlossaryText>
    );
    await waitFor(() => expect(document.querySelectorAll(".term")).toHaveLength(2));
    const tips = [...document.querySelectorAll(".term")].map((e) => e.textContent.toLowerCase());
    expect(tips).toEqual(["read replica", "rto"]); // not "replica", and not the repeats
  });

  it("recognises simple plurals but only as whole words", async () => {
    await renderTip(
      <GlossaryText>Missing indexes slow reads. An indexer is not a term. One index is fine.</GlossaryText>
    );
    await waitFor(() => expect(document.querySelectorAll(".term")).toHaveLength(1));
    const tip = document.querySelector(".term");
    expect(tip.textContent).toBe("indexes"); // the first mention is shown as written
    expect(tip).toHaveAttribute("data-definition", "A lookup structure.");
  });

  it("works without the glossary loaded", async () => {
    api.getGlossary.mockRejectedValue(new Error("down"));
    render(
      <GlossaryProvider>
        <GlossaryText>An RTO is a number.</GlossaryText>
      </GlossaryProvider>
    );
    expect(await screen.findByText("An RTO is a number.")).toBeInTheDocument();
  });
});

describe("Explain this component", () => {
  const explanation = {
    component_id: "db",
    name: "DB",
    kind: "database",
    what_it_is: "The system of record.",
    role_here: "DB is a database in this design.",
    receives_from: ["API"],
    sends_to: [],
    alternatives: [{ name: "MongoDB", choose_when: "records vary" }],
    pitfalls: ["No backups."],
    terms: [],
  };

  it("loads the explanation on demand and hides it again", async () => {
    api.explainComponent.mockResolvedValue(explanation);
    const user = userEvent.setup();
    render(<Explain architecture={ARCH} requirements={{}} componentId="db" />);
    expect(api.explainComponent).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Explain this component" }));
    expect(await screen.findByText("The system of record.")).toBeInTheDocument();
    expect(api.explainComponent).toHaveBeenCalledWith(ARCH, {}, "db");
    expect(screen.getByText(/Receives from:/).closest("p")).toHaveTextContent("Receives from: API");
    expect(screen.getByText(/MongoDB: choose it when records vary/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide explanation" }));
    expect(screen.queryByText("The system of record.")).not.toBeInTheDocument();
  });

  it("shows an error instead of an empty box", async () => {
    api.explainComponent.mockRejectedValue(new Error("No component with id 'db'"));
    const user = userEvent.setup();
    render(<Explain architecture={ARCH} requirements={{}} componentId="db" />);
    await user.click(screen.getByRole("button", { name: "Explain this component" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No component");
  });
});

describe("formatting helpers", () => {
  it("formats durations", () => {
    expect(duration(0)).toBe("0");
    expect(duration(0.5)).toBe("30 s");
    expect(duration(2)).toBe("2 min");
    expect(duration(125)).toBe("2 h 5 min");
    expect(duration(1500)).toBe("1 day 1 h");
    expect(duration(2880)).toBe("2 days");
  });

  it("formats percentages without trailing zeros", () => {
    expect(pct(99.9)).toBe("99.9%");
    expect(pct(99)).toBe("99%");
    expect(pct(99.83012)).toBe("99.83%");
  });
});
