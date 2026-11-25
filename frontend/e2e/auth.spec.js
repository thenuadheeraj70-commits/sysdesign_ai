import { expect, test } from "@playwright/test";
import { newAccount, register } from "./helpers.js";

test.describe("accounts", () => {
  test("someone who is not signed in sees only the login form", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Generate Architecture" })).toHaveCount(0);
  });

  test("register, stay signed in after a reload, then log out and back in", async ({ page }) => {
    const account = await register(page);

    await page.reload();
    await expect(page.getByText(`Signed in as ${account.email}`)).toBeVisible();

    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible(); // still signed out

    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password").fill(account.password);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.getByText(`Signed in as ${account.email}`)).toBeVisible();
  });

  test("a wrong password is refused with a clear message", async ({ page }) => {
    const account = await register(page);
    await page.getByRole("button", { name: "Log out" }).click();

    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.getByRole("alert")).toHaveText("Incorrect email or password.");
    await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
  });

  test("registering twice with one email is refused", async ({ page }) => {
    const account = await register(page);
    await page.getByRole("button", { name: "Log out" }).click();

    await page.getByRole("button", { name: "Create an account" }).click();
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password").fill(account.password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("alert")).toHaveText("An account with this email already exists.");
  });

  test("a bad email or short password is rejected", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Create an account" }).click();
    await page.getByLabel("Password").fill("longenoughpw");

    // No "@": the browser's own email check stops the form before any request is made.
    await page.getByLabel("Email").fill("not-an-email");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect.poll(() => page.getByLabel("Email").evaluate((el) => el.validity.typeMismatch)).toBe(true);
    await expect(page.getByRole("alert")).toHaveCount(0);

    // Looks fine to the browser but has no domain suffix: the server refuses it with a message.
    await page.getByLabel("Email").fill("someone@localhost");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("alert")).toContainText("valid email");

    await page.getByLabel("Email").fill(newAccount().email);
    await page.getByLabel("Password").fill("short");
    await expect(page.getByRole("button", { name: "Create account" })).toBeDisabled();
  });

  test("an invalid saved session sends you back to the login form", async ({ page }) => {
    await register(page);
    await page.evaluate(() => localStorage.setItem("sysdesign_token", "garbage.token"));
    await page.reload();
    await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
  });
});
