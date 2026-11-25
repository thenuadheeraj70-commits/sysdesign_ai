import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ComponentPanel from "./ComponentPanel.jsx";
import ConnectionPanel from "./ConnectionPanel.jsx";
import DetailsEditor from "./DetailsEditor.jsx";

const component = {
  id: "api",
  name: "API Servers",
  type: "compute",
  provider: "aws",
  configuration: { instances: 2, autoscaling: true, region_note: "eu" },
};

describe("ComponentPanel", () => {
  const setup = (props = {}) => {
    const handlers = { onChange: vi.fn(), onDelete: vi.fn(), onClose: vi.fn() };
    render(<ComponentPanel component={component} {...handlers} {...props} />);
    return { user: userEvent.setup(), ...handlers };
  };

  it("shows the component's settings as editable rows", () => {
    setup();
    expect(screen.getAllByLabelText("Setting name").map((i) => i.value)).toEqual([
      "instances",
      "autoscaling",
      "region_note",
    ]);
    expect(screen.getAllByLabelText("Setting value").map((i) => i.value)).toEqual(["2", "true", "eu"]);
  });

  it("saves edited values with numbers and booleans converted from text", async () => {
    const { user, onChange } = setup();
    const values = screen.getAllByLabelText("Setting value");
    await user.clear(values[0]);
    await user.type(values[0], "5");
    await user.clear(values[1]);
    await user.type(values[1], "false");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onChange).toHaveBeenCalledWith({
      name: "API Servers",
      type: "compute",
      provider: "aws",
      configuration: { instances: 5, autoscaling: false, region_note: "eu" },
    });
  });

  it("adds a new setting and drops rows whose name is blank", async () => {
    const { user, onChange } = setup();
    await user.click(screen.getByRole("button", { name: "Add setting" }));
    const names = screen.getAllByLabelText("Setting name");
    const values = screen.getAllByLabelText("Setting value");
    await user.type(names[3], "port");
    await user.type(values[3], "8080");
    await user.click(screen.getByRole("button", { name: "Add setting" })); // a blank one
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onChange.mock.calls[0][0].configuration).toEqual({
      instances: 2,
      autoscaling: true,
      region_note: "eu",
      port: 8080,
    });
  });

  it("can remove a setting", async () => {
    const { user, onChange } = setup();
    await user.click(screen.getAllByRole("button", { name: "Remove setting" })[2]);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onChange.mock.calls[0][0].configuration).toEqual({ instances: 2, autoscaling: true });
  });

  it("refuses to save two settings with the same name", async () => {
    const { user, onChange } = setup();
    await user.click(screen.getByRole("button", { name: "Add setting" }));
    await user.type(screen.getAllByLabelText("Setting name")[3], "instances");
    expect(screen.getByText("Setting names must be unique.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the old name if the new one is blank", async () => {
    const { user, onChange } = setup();
    await user.clear(screen.getByLabelText("Name"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onChange.mock.calls[0][0].name).toBe("API Servers");
  });

  it("offers the types from the catalog, plus the component's own unusual type", () => {
    setup({ component: { ...component, type: "custom_thing" } });
    const options = screen.getByLabelText("Type").querySelectorAll("option");
    expect(options[0]).toHaveValue("custom_thing");
    expect([...options].map((o) => o.value)).toContain("queue");
  });

  it("deletes and closes", async () => {
    const { user, onDelete, onClose } = setup();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("ConnectionPanel", () => {
  it("edits the label and deletes the connection", async () => {
    const onChange = vi.fn();
    const onDelete = vi.fn();
    const user = userEvent.setup();
    render(
      <ConnectionPanel
        connection={{ source: "a", target: "b", label: "HTTP" }}
        sourceName="API"
        targetName="DB"
        onChange={onChange}
        onDelete={onDelete}
        onClose={() => {}}
      />
    );
    expect(screen.getByText("API → DB")).toBeInTheDocument();
    const label = screen.getByLabelText("Label");
    await user.clear(label);
    await user.type(label, "  reads/writes  ");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onChange).toHaveBeenCalledWith({ label: "reads/writes" });
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalled();
  });
});

describe("DetailsEditor", () => {
  const architecture = { project_name: "Shop", description: "A shop.", assumptions: ["10k users"] };

  it("saves a trimmed name, description and cleaned-up assumptions", async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<DetailsEditor architecture={architecture} onSave={onSave} onCancel={() => {}} />);

    await user.clear(screen.getByLabelText("Project name"));
    await user.type(screen.getByLabelText("Project name"), "  New Shop ");
    await user.clear(screen.getByLabelText("Description"));
    await user.type(screen.getByLabelText("Description"), "Better.");
    await user.click(screen.getByRole("button", { name: "Add assumption" }));
    await user.click(screen.getByRole("button", { name: "Add assumption" })); // left blank on purpose
    await user.type(screen.getByLabelText("Assumption 2"), " single region ");
    await user.click(screen.getByRole("button", { name: "Save details" }));

    expect(onSave).toHaveBeenCalledWith({
      project_name: "New Shop",
      description: "Better.",
      assumptions: ["10k users", "single region"], // the blank one is dropped
    });
  });

  it("needs a project name", async () => {
    const user = userEvent.setup();
    render(<DetailsEditor architecture={architecture} onSave={vi.fn()} onCancel={() => {}} />);
    await user.clear(screen.getByLabelText("Project name"));
    expect(screen.getByRole("button", { name: "Save details" })).toBeDisabled();
    expect(screen.getByText("A project name is required.")).toBeInTheDocument();
  });

  it("removes an assumption and can be cancelled", async () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<DetailsEditor architecture={architecture} onSave={onSave} onCancel={onCancel} />);
    await user.click(screen.getByRole("button", { name: "Remove assumption 1" }));
    expect(screen.getByText("No assumptions yet.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
