import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client.js";
import InfrastructureCode from "./InfrastructureCode.jsx";

vi.mock("../api/client.js", () => ({
  generateInfrastructureCode: vi.fn(),
  downloadInfrastructureZip: vi.fn(),
}));

const architecture = { project_name: "Shop", components: [{ id: "api" }], connections: [] };

const generated = {
  project_name: "Shop",
  notice: "Nothing is deployed.",
  terraform: {
    files: [
      { path: "terraform/outputs.tf", content: "# outputs\n" },
      { path: "terraform/main.tf", content: 'resource "aws_instance" "api" {\n  ami = "x"\n}\n' },
    ],
    generated_components: [],
    warnings: ["Databases are created with skip_final_snapshot = true."],
    skipped_components: [{ id: "q", name: "Order Queue", reason: "Not supported yet." }],
    notice: "Starter code only.",
  },
  kubernetes: {
    available: true,
    message: "Kubernetes YAML generated for 1 application service(s).",
    files: [
      { path: "kubernetes/service.yaml", content: "kind: Service\n" },
      { path: "kubernetes/deployment.yaml", content: "kind: Deployment\n" },
    ],
    warnings: [],
    skipped_components: [],
    notice: "",
  },
};

describe("InfrastructureCode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.generateInfrastructureCode.mockResolvedValue(generated);
    api.downloadInfrastructureZip.mockResolvedValue(undefined);
  });

  it("needs an architecture before anything can be generated", () => {
    render(<InfrastructureCode architecture={null} />);
    expect(screen.getByRole("button", { name: "Generate Code" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Download ZIP" })).toBeDisabled();
    expect(screen.getByText("Generate an architecture first.")).toBeInTheDocument();
  });

  it("generates the code for the architecture and region, showing the main file first", async () => {
    const user = userEvent.setup();
    render(<InfrastructureCode architecture={architecture} region="eu-west-1" />);
    await user.click(screen.getByRole("button", { name: "Generate Code" }));

    expect(api.generateInfrastructureCode).toHaveBeenCalledWith(architecture, "eu-west-1");
    const tabs = await screen.findAllByRole("tab");
    // Terraform / Kubernetes, then the files with main.tf ahead of outputs.tf
    expect(tabs.map((t) => t.textContent)).toEqual(["Terraform", "Kubernetes", "main.tf", "outputs.tf"]);
    expect(screen.getByText("terraform/main.tf")).toBeInTheDocument();
    expect(screen.getByText(/resource "aws_instance"/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate Again" })).toBeInTheDocument();
    expect(screen.getByText("Nothing is deployed.")).toBeInTheDocument();
  });

  it("switches between Terraform and Kubernetes and between files", async () => {
    const user = userEvent.setup();
    render(<InfrastructureCode architecture={architecture} />);
    await user.click(screen.getByRole("button", { name: "Generate Code" }));
    await screen.findAllByRole("tab");

    await user.click(screen.getByRole("tab", { name: "outputs.tf" }));
    expect(screen.getByText("terraform/outputs.tf")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Kubernetes" }));
    expect(screen.getByText("Kubernetes YAML generated for 1 application service(s).")).toBeInTheDocument();
    // deployment.yaml is ordered ahead of service.yaml
    const files = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(files.slice(-2)).toEqual(["deployment.yaml", "service.yaml"]);
    expect(screen.getByText(/kind: Deployment/)).toBeInTheDocument();
  });

  it("lists warnings and components that were not generated", async () => {
    const user = userEvent.setup();
    render(<InfrastructureCode architecture={architecture} />);
    await user.click(screen.getByRole("button", { name: "Generate Code" }));
    expect(await screen.findByText(/Things to check \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/skip_final_snapshot/)).toBeInTheDocument();
    expect(screen.getByText(/Not generated \(1\)/)).toBeInTheDocument();
  });

  it("copies the file to the clipboard", async () => {
    const user = userEvent.setup();
    render(<InfrastructureCode architecture={architecture} />);
    await user.click(screen.getByRole("button", { name: "Generate Code" }));
    await screen.findAllByRole("tab");
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();

    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith('resource "aws_instance" "api" {\n  ami = "x"\n}\n');
    expect(await screen.findByText("Copied to clipboard")).toBeInTheDocument();
  });

  it("explains when copying is not possible", async () => {
    const user = userEvent.setup();
    render(<InfrastructureCode architecture={architecture} />);
    await user.click(screen.getByRole("button", { name: "Generate Code" }));
    await screen.findAllByRole("tab");
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    document.execCommand = vi.fn().mockReturnValue(false); // the fallback fails too

    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByText(/Couldn't copy/)).toBeInTheDocument();
  });

  it("warns when the architecture changed after the code was generated", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<InfrastructureCode architecture={architecture} />);
    await user.click(screen.getByRole("button", { name: "Generate Code" }));
    await screen.findAllByRole("tab");
    expect(screen.queryByText(/has changed since this code was generated/)).not.toBeInTheDocument();

    rerender(<InfrastructureCode architecture={{ ...architecture, project_name: "Shop v2" }} />);
    expect(screen.getByText(/has changed since this code was generated/)).toBeInTheDocument();
  });

  it("also warns when only the region changed", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<InfrastructureCode architecture={architecture} region="us-east-1" />);
    await user.click(screen.getByRole("button", { name: "Generate Code" }));
    await screen.findAllByRole("tab");
    rerender(<InfrastructureCode architecture={architecture} region="eu-west-1" />);
    expect(screen.getByText(/has changed since this code was generated/)).toBeInTheDocument();
  });

  it("shows the server's message when generation fails, such as an invalid region", async () => {
    api.generateInfrastructureCode.mockRejectedValue(new Error("'nowhere' is not a valid AWS region name"));
    const user = userEvent.setup();
    render(<InfrastructureCode architecture={architecture} region="nowhere" />);
    await user.click(screen.getByRole("button", { name: "Generate Code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not a valid AWS region");
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("downloads the ZIP for the architecture and region", async () => {
    const user = userEvent.setup();
    render(<InfrastructureCode architecture={architecture} region="eu-west-1" />);
    await user.click(screen.getByRole("button", { name: "Download ZIP" }));
    await waitFor(() =>
      expect(api.downloadInfrastructureZip).toHaveBeenCalledWith(architecture, "eu-west-1")
    );
  });

  it("shows an error if the ZIP download fails", async () => {
    api.downloadInfrastructureZip.mockRejectedValue(new Error("Download failed (500)."));
    const user = userEvent.setup();
    render(<InfrastructureCode architecture={architecture} />);
    await user.click(screen.getByRole("button", { name: "Download ZIP" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Download failed (500).");
  });

  it("supports keyboard navigation between the Terraform and Kubernetes tabs", async () => {
    const user = userEvent.setup();
    render(<InfrastructureCode architecture={architecture} />);
    await user.click(screen.getByRole("button", { name: "Generate Code" }));
    await screen.findAllByRole("tab");
    screen.getByRole("tab", { name: "Terraform" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Kubernetes" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Terraform" })).toHaveAttribute("aria-selected", "true");
  });
});
