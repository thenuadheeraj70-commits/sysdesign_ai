import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api/client.js";
import AiAssistant from "./AiAssistant.jsx";
import { GenerationFeedback, ImportDocument } from "./PromptTools.jsx";

vi.mock("../../api/client.js", () => ({
  refineArchitecture: vi.fn(),
  reviewArchitecture: vi.fn(),
  getAiUsage: vi.fn(),
  getAiHistory: vi.fn(),
  importDocument: vi.fn(),
  sendFeedback: vi.fn(),
}));

const ARCH = {
  project_name: "Shop",
  description: "",
  components: [{ id: "api", name: "API", type: "compute", provider: "aws", configuration: {} }],
  connections: [],
  assumptions: [],
};
const PATCH = {
  label: "Add search",
  add_components: [{ id: "s", name: "Search", type: "search", provider: "aws" }],
};
const ANSWER = {
  summary: "Add a search cluster.",
  patch: PATCH,
  diff: { added: ["Search (search)"], removed: ["Old cache"], changed: ["API: instances 2 → 4"] },
  source: "ai",
  cached: false,
};

function setup(props = {}) {
  const handlers = {
    onApplyPatch: vi.fn().mockResolvedValue(undefined),
    onRegenerate: vi.fn(),
    onUsePrompt: vi.fn(),
  };
  const user = userEvent.setup();
  render(
    <AiAssistant
      architecture={ARCH}
      requirements={{ expected_users: 10 }}
      prompt="a shop"
      applying={false}
      regenerating={false}
      regenError=""
      {...handlers}
      {...props}
    />
  );
  return { user, ...handlers };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.getAiUsage.mockResolvedValue({
    month: "2026-11",
    requests: 4,
    cached_requests: 1,
    input_tokens: 1000,
    output_tokens: 500,
    tokens_used: 1500,
    quota: 3000,
    by_task: [{ task: "generation", requests: 4, cached: 1, input_tokens: 1000, output_tokens: 500 }],
    models: { generation: "gemini-x", review: "gemini-x" },
    fallback_model: "backup-y",
    demo_mode: false,
  });
  api.getAiHistory.mockResolvedValue({
    items: [
      {
        id: 2,
        prompt: "a coffee shop app",
        project_name: "Coffee",
        rating: 1,
        comment: "nice",
        created_at: "2026-11-18 10:00:00",
      },
      {
        id: 1,
        prompt: "x".repeat(200),
        project_name: "",
        rating: -1,
        comment: "",
        created_at: "2026-11-18 09:00:00",
      },
    ],
  });
});

describe("AI assistant: change the design", () => {
  it("asks for an architecture first", () => {
    render(<AiAssistant architecture={null} />);
    expect(screen.getByText(/Generate an architecture first/)).toBeInTheDocument();
  });

  it("will not send an empty request", () => {
    setup();
    expect(screen.getByRole("button", { name: "Suggest change" })).toBeDisabled();
  });

  it("fills the box from an example", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Add monitoring" }));
    expect(screen.getByLabelText("Describe a change")).toHaveValue("Add monitoring");
  });

  it("shows the suggested change as adds, removes and changes, with where it came from", async () => {
    api.refineArchitecture.mockResolvedValue(ANSWER);
    const { user } = setup();
    await user.type(screen.getByLabelText("Describe a change"), "add search");
    await user.click(screen.getByRole("button", { name: "Suggest change" }));
    const region = await screen.findByRole("region", { name: "Suggested change" });
    expect(api.refineArchitecture).toHaveBeenCalledWith(ARCH, { expected_users: 10 }, "add search");
    expect(within(region).getByText("Add a search cluster.")).toBeInTheDocument();
    expect(within(region).getByText("AI")).toBeInTheDocument();
    expect(within(region).getByText("Search (search)")).toBeInTheDocument();
    expect(within(region).getByText("Old cache")).toBeInTheDocument();
    expect(within(region).getByText("API: instances 2 → 4")).toBeInTheDocument();
  });

  it("applies the patch only when accepted, then clears the box", async () => {
    api.refineArchitecture.mockResolvedValue(ANSWER);
    const { user, onApplyPatch } = setup();
    await user.type(screen.getByLabelText("Describe a change"), "add search");
    await user.click(screen.getByRole("button", { name: "Suggest change" }));
    await screen.findByRole("region", { name: "Suggested change" });
    expect(onApplyPatch).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Accept" }));
    expect(onApplyPatch).toHaveBeenCalledWith(PATCH);
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Suggested change" })).not.toBeInTheDocument()
    );
    expect(screen.getByLabelText("Describe a change")).toHaveValue("");
  });

  it("discards a suggestion without changing anything", async () => {
    api.refineArchitecture.mockResolvedValue(ANSWER);
    const { user, onApplyPatch } = setup();
    await user.type(screen.getByLabelText("Describe a change"), "add search");
    await user.click(screen.getByRole("button", { name: "Suggest change" }));
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    expect(onApplyPatch).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Suggested change" })).not.toBeInTheDocument();
  });

  it("says so when nothing can be changed, and labels rule-based answers", async () => {
    api.refineArchitecture.mockResolvedValue({
      summary: "I could not match that.",
      patch: null,
      diff: { added: [], removed: [], changed: [] },
      source: "rules",
      cached: true,
    });
    const { user } = setup();
    await user.type(screen.getByLabelText("Describe a change"), "bake a cake");
    await user.click(screen.getByRole("button", { name: "Suggest change" }));
    expect(await screen.findByText("Nothing was changed.")).toBeInTheDocument();
    expect(screen.getByText("Rule-based (no AI key)")).toBeInTheDocument();
    expect(screen.getByText("cached")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
  });

  it("shows the server's message when the request fails", async () => {
    api.refineArchitecture.mockRejectedValue(new Error("You have used this month's AI allowance."));
    const { user } = setup();
    await user.type(screen.getByLabelText("Describe a change"), "add search");
    await user.click(screen.getByRole("button", { name: "Suggest change" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("allowance");
    expect(screen.getByRole("button", { name: "Suggest change" })).toBeEnabled();
  });

  it("regenerates while keeping edits, and needs requirements text first", async () => {
    const { user, onRegenerate } = setup();
    await user.click(screen.getByRole("button", { name: "Regenerate keeping my edits" }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it("disables regenerate with no requirements text and shows a regenerate error", () => {
    setup({ prompt: "  ", regenError: "AI service is busy" });
    expect(screen.getByRole("button", { name: "Regenerate keeping my edits" })).toBeDisabled();
    expect(screen.getByText(/Write the requirements first/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("AI service is busy");
  });
});

describe("AI assistant: review", () => {
  const review = {
    summary: "Two problems found.",
    source: "demo",
    cached: false,
    findings: [
      {
        id: "1",
        severity: "high",
        title: "Single database",
        detail: "One failure is an outage.",
        recommendation: "Add a standby.",
        affected_components: ["db"],
        fix: { label: "Make DB multi-zone", update_components: [] },
      },
      {
        id: "2",
        severity: "low",
        title: "No monitoring",
        detail: "Blind.",
        recommendation: "Add alerts.",
        affected_components: [],
        fix: null,
      },
    ],
  };

  it("reviews on demand and applies a finding's fix", async () => {
    api.reviewArchitecture.mockResolvedValue(review);
    const { user, onApplyPatch } = setup();
    await user.click(screen.getByRole("tab", { name: "AI review" }));
    expect(api.reviewArchitecture).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Review my design" }));
    expect(await screen.findByText("Single database")).toBeInTheDocument();
    expect(screen.getByText("Rule-based stand-in (no AI key)")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /multi-zone/ })).toHaveLength(1); // only the finding that has a fix
    await user.click(screen.getByRole("button", { name: "Make DB multi-zone" }));
    expect(onApplyPatch).toHaveBeenCalledWith(review.findings[0].fix);
    expect(screen.getByRole("button", { name: "Review again" })).toBeInTheDocument();
  });

  it("shows a review failure", async () => {
    api.reviewArchitecture.mockRejectedValue(new Error("AI returned an invalid review"));
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "AI review" }));
    await user.click(screen.getByRole("button", { name: "Review my design" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid review");
  });
});

describe("AI assistant: usage and history", () => {
  it("shows the month's usage against the allowance and the models", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "Usage and history" }));
    expect(await screen.findByText("1,500")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /monthly allowance/ })).toHaveAttribute("value", "50");
    expect(screen.getByText(/1 answered from cache/)).toBeInTheDocument();
    expect(screen.getByText("backup-y")).toBeInTheDocument();
  });

  it("shows 'No limit' and the demo note when there is no allowance", async () => {
    api.getAiUsage.mockResolvedValue({ ...(await api.getAiUsage()), quota: 0, demo_mode: true, by_task: [] });
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "Usage and history" }));
    expect(await screen.findByText("No limit")).toBeInTheDocument();
    expect(screen.getByText(/Demo mode is on/)).toBeInTheDocument();
  });

  it("lists past prompts with ratings and reuses one", async () => {
    const { user, onUsePrompt } = setup();
    await user.click(screen.getByRole("tab", { name: "Usage and history" }));
    await user.click(await screen.findByRole("button", { name: "a coffee shop app" }));
    expect(onUsePrompt).toHaveBeenCalledWith("a coffee shop app");
    expect(screen.getByText(/👍/)).toBeInTheDocument();
    expect(screen.getByText(/👎/)).toBeInTheDocument();
    expect(screen.getByText(/“nice”/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^x{110}…$/ })).toBeInTheDocument(); // long prompts are shortened
  });

  it("says when nothing has been generated yet", async () => {
    api.getAiHistory.mockResolvedValue({ items: [] });
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "Usage and history" }));
    expect(await screen.findByText("No designs generated yet.")).toBeInTheDocument();
  });

  it("moves between tabs with the keyboard", async () => {
    const { user } = setup();
    screen.getByRole("tab", { name: "Change the design" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "AI review" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("Import a file", () => {
  async function pick(file) {
    const onText = vi.fn();
    const user = userEvent.setup({ applyAccept: false }); // the picker can be switched to All files;
    render(<ImportDocument onText={onText} />);
    await user.upload(screen.getByLabelText("Choose a file to import"), file);
    return onText;
  }

  it("fills the requirements from a file and says where the text came from", async () => {
    api.importDocument.mockResolvedValue({
      text: "Build a shop",
      source: "file",
      truncated: false,
      note: "",
    });
    const onText = await pick(new File(["Build a shop"], "brief.txt", { type: "text/plain" }));
    await waitFor(() => expect(onText).toHaveBeenCalledWith("Build a shop"));
    expect(api.importDocument).toHaveBeenCalledWith("brief.txt", "text/plain", btoa("Build a shop"));
    expect(await screen.findByText(/Text read from the file/)).toBeInTheDocument();
  });

  it("warns that AI-written text should be checked", async () => {
    api.importDocument.mockResolvedValue({
      text: "T",
      source: "ai",
      truncated: false,
      note: "Check the text before generating.",
    });
    await pick(new File(["%PDF"], "req.pdf", { type: "application/pdf" }));
    expect(await screen.findByText(/Written by AI from your file\. Check the text/)).toBeInTheDocument();
  });

  it("refuses a file over 5 MB without sending it", async () => {
    const big = new File(["x"], "big.pdf", { type: "application/pdf" });
    Object.defineProperty(big, "size", { value: 5 * 1024 * 1024 + 1 });
    const onText = await pick(big);
    expect(await screen.findByRole("alert")).toHaveTextContent("larger than 5 MB");
    expect(api.importDocument).not.toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
  });

  it("shows the server's reason and leaves the text alone", async () => {
    api.importDocument.mockRejectedValue(new Error("Use a text, Markdown or PDF file."));
    const onText = await pick(new File(["MZ"], "a.exe", { type: "application/octet-stream" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Use a text");
    expect(onText).not.toHaveBeenCalled();
  });
});

describe("Feedback on a generation", () => {
  it("sends a rating with the comment", async () => {
    api.sendFeedback.mockResolvedValue(null);
    const user = userEvent.setup();
    render(<GenerationFeedback prompt="a shop" projectName="Shop" cached={false} />);
    await user.type(screen.getByLabelText("Comment (optional)"), "too big");
    await user.click(screen.getByRole("button", { name: "Not helpful" }));
    expect(api.sendFeedback).toHaveBeenCalledWith("a shop", "Shop", -1, "too big");
    expect(await screen.findByText("Thanks, saved.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not helpful" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Helpful" })).toHaveAttribute("aria-pressed", "false");
  });

  it("saves a comment typed after rating when the box loses focus", async () => {
    api.sendFeedback.mockResolvedValue(null);
    const user = userEvent.setup();
    render(<GenerationFeedback prompt="p" projectName="" cached />);
    expect(screen.getByText("cached result")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Helpful" }));
    await user.type(screen.getByLabelText("Comment (optional)"), "great");
    await user.tab();
    await waitFor(() => expect(api.sendFeedback).toHaveBeenLastCalledWith("p", "", 1, "great"));
  });

  it("shows the error if saving fails", async () => {
    api.sendFeedback.mockRejectedValue(new Error("Request failed (500)."));
    const user = userEvent.setup();
    render(<GenerationFeedback prompt="p" projectName="" />);
    await user.click(screen.getByRole("button", { name: "Helpful" }));
    expect(await screen.findByText("Request failed (500).")).toBeInTheDocument();
  });
});
