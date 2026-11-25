import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { login, register } from "../api/client.js";
import AuthForm from "./AuthForm.jsx";

vi.mock("../api/client.js", () => ({ login: vi.fn(), register: vi.fn() }));

const session = { token: "tok", user: { id: 1, email: "a@example.com" } };

async function fill(user, email, password) {
  await user.type(screen.getByLabelText("Email"), email);
  await user.type(screen.getByLabelText("Password"), password);
}

describe("AuthForm", () => {
  beforeEach(() => vi.clearAllMocks());

  it("logs in and hands the session to the app", async () => {
    login.mockResolvedValue(session);
    const onAuthenticated = vi.fn();
    const user = userEvent.setup();
    render(<AuthForm onAuthenticated={onAuthenticated} />);

    await fill(user, "  a@example.com ", "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(login).toHaveBeenCalledWith("a@example.com", "password123"); // email is trimmed
    expect(onAuthenticated).toHaveBeenCalledWith(session);
    expect(register).not.toHaveBeenCalled();
  });

  it("shows the server's message when the login is wrong, and stays on the form", async () => {
    login.mockRejectedValue(new Error("Incorrect email or password."));
    const onAuthenticated = vi.fn();
    const user = userEvent.setup();
    render(<AuthForm onAuthenticated={onAuthenticated} />);

    await fill(user, "a@example.com", "wrongpass1");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect email or password.");
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Log in" })).toBeEnabled(); // can try again
  });

  it("will not submit until there is an email and a password of at least 8 characters", async () => {
    const user = userEvent.setup();
    render(<AuthForm onAuthenticated={() => {}} />);
    const submit = screen.getByRole("button", { name: "Log in" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("Email"), "a@example.com");
    await user.type(screen.getByLabelText("Password"), "short");
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("Password"), "er-now");
    expect(submit).toBeEnabled();
  });

  it("switches to creating an account, and back, clearing old errors", async () => {
    login.mockRejectedValue(new Error("Incorrect email or password."));
    register.mockResolvedValue(session);
    const onAuthenticated = vi.fn();
    const user = userEvent.setup();
    render(<AuthForm onAuthenticated={onAuthenticated} />);

    await fill(user, "a@example.com", "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create an account" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Create an account" })).toBeInTheDocument();
    expect(screen.getByText("At least 8 characters.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(register).toHaveBeenCalledWith("a@example.com", "password123");
    expect(onAuthenticated).toHaveBeenCalledWith(session);

    await user.click(screen.getByRole("button", { name: "I already have an account" }));
    expect(screen.getByRole("heading", { name: "Log in" })).toBeInTheDocument();
  });

  it("shows a registration error such as an email already in use", async () => {
    register.mockRejectedValue(new Error("An account with this email already exists."));
    const user = userEvent.setup();
    render(<AuthForm onAuthenticated={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Create an account" }));
    await fill(user, "a@example.com", "password123");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
  });
});
