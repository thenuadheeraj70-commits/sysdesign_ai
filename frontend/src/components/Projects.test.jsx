import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client.js";
import Projects from "./Projects.jsx";

vi.mock("../api/client.js", () => ({
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  duplicateProject: vi.fn(),
  getProject: vi.fn(),
  listProjects: vi.fn(),
  listTrash: vi.fn(),
  renameProject: vi.fn(),
  restoreProject: vi.fn(),
  updateProject: vi.fn(),
}));

const architecture = { project_name: "Generated Name", components: [], connections: [] };
const snapshot = { prompt: "p", architecture, requirements: null, positions: null };
const page = (items, total = items.length) => ({ items, total, limit: 5, offset: 0 });
const item = (id, name) => ({ id, name, updated_at: "2026-11-15 10:00:00", deleted_at: null });

function setup(props = {}) {
  const handlers = {
    onSaved: vi.fn(),
    onOpen: vi.fn(),
    onDeleted: vi.fn(),
    confirmDiscard: vi.fn().mockReturnValue(true),
  };
  render(<Projects snapshot={snapshot} currentId={null} dirty={false} {...handlers} {...props} />);
  return { user: userEvent.setup(), ...handlers };
}

const row = async (name) => (await screen.findByText(name, { selector: "strong" })).closest("li");

describe("Projects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listProjects.mockResolvedValue(page([item(1, "Alpha"), item(2, "Beta")]));
    api.listTrash.mockResolvedValue([]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("lists saved projects", async () => {
    setup();
    expect(await row("Alpha")).toBeInTheDocument();
    expect(await row("Beta")).toBeInTheDocument();
  });

  it("says when there are none, and when a search finds none", async () => {
    api.listProjects.mockResolvedValue(page([]));
    const { user } = setup();
    expect(await screen.findByText("No saved projects yet.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Search projects"), "zzz");
    expect(await screen.findByText("No projects match your search.")).toBeInTheDocument();
  });

  it("suggests the generated name and saves a new project", async () => {
    api.createProject.mockResolvedValue({ id: 9 });
    const { user, onSaved } = setup();
    const name = screen.getByLabelText("Project name");
    expect(name).toHaveValue("Generated Name");
    await user.clear(name);
    await user.type(name, "  My Shop ");
    await user.click(screen.getByRole("button", { name: "Save project" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(9));
    expect(api.createProject).toHaveBeenCalledWith({ name: "My Shop", ...snapshot });
    expect(await screen.findByText(/Saved\./)).toBeInTheDocument();
  });

  it("updates the open project instead of creating another", async () => {
    api.updateProject.mockResolvedValue({ id: 1 });
    const { user, onSaved } = setup({ currentId: 1 });
    await user.type(screen.getByLabelText("Project name"), "Shop");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(1));
    expect(api.updateProject).toHaveBeenCalledWith(1, expect.objectContaining({ prompt: "p" }));
    expect(api.createProject).not.toHaveBeenCalled();
  });

  it("shows a tag when the design is new or has unsaved changes", async () => {
    const { rerender } = render(
      <Projects
        snapshot={snapshot}
        currentId={null}
        dirty={false}
        onSaved={() => {}}
        onOpen={() => {}}
        onDeleted={() => {}}
        confirmDiscard={() => true}
      />
    );
    expect(screen.getByText("Not saved yet")).toBeInTheDocument();
    rerender(
      <Projects
        snapshot={snapshot}
        currentId={3}
        dirty={true}
        onSaved={() => {}}
        onOpen={() => {}}
        onDeleted={() => {}}
        confirmDiscard={() => true}
      />
    );
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    rerender(
      <Projects
        snapshot={snapshot}
        currentId={3}
        dirty={false}
        onSaved={() => {}}
        onOpen={() => {}}
        onDeleted={() => {}}
        confirmDiscard={() => true}
      />
    );
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    expect(screen.queryByText("Not saved yet")).not.toBeInTheDocument();
    await row("Alpha"); // let the list finish loading before the test ends
  });

  it("cannot save before there is a design", async () => {
    setup({ snapshot: null });
    expect(screen.getByRole("button", { name: "Save project" })).toBeDisabled();
    expect(screen.getByText("Generate an architecture to save it.")).toBeInTheDocument();
    await row("Alpha");
  });

  it("opens a project, after asking about unsaved work", async () => {
    const project = { ...item(1, "Alpha"), prompt: "x", architecture, requirements: null, positions: null };
    api.getProject.mockResolvedValue(project);
    const { user, onOpen, confirmDiscard } = setup();

    confirmDiscard.mockReturnValue(false);
    await user.click(within(await row("Alpha")).getByRole("button", { name: "Open" }));
    expect(api.getProject).not.toHaveBeenCalled();

    confirmDiscard.mockReturnValue(true);
    await user.click(within(await row("Alpha")).getByRole("button", { name: "Open" }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(project));
    expect(screen.getByLabelText("Project name")).toHaveValue("Alpha");
  });

  it("does not ask when re-opening the project that is already open", async () => {
    api.getProject.mockResolvedValue({ ...item(1, "Alpha"), prompt: "", architecture });
    const { user, confirmDiscard } = setup({ currentId: 1 });
    await user.click(within(await row("Alpha")).getByRole("button", { name: "Open" }));
    await waitFor(() => expect(api.getProject).toHaveBeenCalled());
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it("renames a project", async () => {
    api.renameProject.mockResolvedValue({});
    const { user } = setup();
    await user.click(within(await row("Alpha")).getByRole("button", { name: "Rename" }));
    const input = screen.getByLabelText("New project name");
    await user.clear(input);
    await user.type(input, "Alpha Prime");
    await user.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(api.renameProject).toHaveBeenCalledWith(1, "Alpha Prime"));
  });

  it("can cancel a rename, and will not save a blank name", async () => {
    const { user } = setup();
    await user.click(within(await row("Alpha")).getByRole("button", { name: "Rename" }));
    await user.clear(screen.getByLabelText("New project name"));
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("New project name")).not.toBeInTheDocument();
    expect(api.renameProject).not.toHaveBeenCalled();
  });

  it("duplicates a project", async () => {
    api.duplicateProject.mockResolvedValue({});
    const { user } = setup();
    await user.click(within(await row("Beta")).getByRole("button", { name: "Duplicate" }));
    await waitFor(() => expect(api.duplicateProject).toHaveBeenCalledWith(2));
    expect(await screen.findByText(/Duplicated "Beta"/)).toBeInTheDocument();
  });

  it("moves a project to the trash and offers Undo", async () => {
    api.deleteProject.mockResolvedValue(null);
    api.restoreProject.mockResolvedValue({});
    const { user, onDeleted } = setup();
    await user.click(within(await row("Beta")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(2));
    expect(api.deleteProject).toHaveBeenCalledWith(2);
    expect(await screen.findByText(/to the trash/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(api.restoreProject).toHaveBeenCalledWith(2));
  });

  it("shows the trash with days left, restores, and deletes for good after confirming", async () => {
    const deletedAt = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 19).replace("T", " ");
    api.listTrash.mockResolvedValue([{ ...item(7, "Old one"), deleted_at: deletedAt }]);
    api.restoreProject.mockResolvedValue({});
    api.deleteProject.mockResolvedValue(null);
    const { user } = setup();

    const summary = await screen.findByText("Trash (1)");
    await user.click(summary);
    const trashed = (await screen.findByText("Old one", { selector: "strong" })).closest("li");
    expect(within(trashed).getByText("25 days left")).toBeInTheDocument();

    await user.click(within(trashed).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(api.restoreProject).toHaveBeenCalledWith(7));

    window.confirm.mockReturnValue(false);
    await user.click(within(trashed).getByRole("button", { name: "Delete forever" }));
    expect(api.deleteProject).not.toHaveBeenCalled();
    window.confirm.mockReturnValue(true);
    await user.click(within(trashed).getByRole("button", { name: "Delete forever" }));
    await waitFor(() => expect(api.deleteProject).toHaveBeenCalledWith(7, { permanent: true }));
  });

  it("searches after typing pauses, and starts again from the first page", async () => {
    const { user } = setup();
    await row("Alpha");
    await user.type(screen.getByLabelText("Search projects"), "alp");
    await waitFor(() =>
      expect(api.listProjects).toHaveBeenLastCalledWith(expect.objectContaining({ q: "alp", offset: 0 }))
    );
  });

  it("changes the sort order", async () => {
    const { user } = setup();
    await row("Alpha");
    await user.selectOptions(screen.getByLabelText("Sort projects"), "name");
    await waitFor(() =>
      expect(api.listProjects).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "name" }))
    );
  });

  it("pages through a long list", async () => {
    api.listProjects.mockImplementation(({ offset }) =>
      Promise.resolve({ items: [item(offset + 1, `Project ${offset + 1}`)], total: 12, limit: 5, offset })
    );
    const { user } = setup();
    expect(await screen.findByText("Page 1 of 3 (12 projects)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Page 2 of 3 (12 projects)")).toBeInTheDocument();
    expect(api.listProjects).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 5 }));

    // The buttons are disabled while a page is loading: wait until Next can be pressed again.
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Page 3 of 3 (12 projects)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("shows an error when the list cannot be loaded", async () => {
    api.listProjects.mockRejectedValue(new Error("Can't reach the backend"));
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("Can't reach the backend");
  });

  it("shows an error when saving fails and keeps the form usable", async () => {
    api.createProject.mockRejectedValue(new Error("You can save up to 50 projects."));
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Save project" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("up to 50 projects");
    expect(screen.getByRole("button", { name: "Save project" })).toBeEnabled();
  });
});
