import { expect, test } from "@playwright/test";
import { analysisReady, generate, register } from "./helpers.js";

const card = (page, issue) => page.locator(".rec-card", { hasText: issue });
const utilization = (page) => page.locator(".card", { hasText: "Utilization" }).first();

test.describe("recommendations and fixes", () => {
  test.beforeEach(async ({ page }) => {
    await register(page);
    await generate(page);
    await analysisReady(page);
    await page.getByLabel("Peak requests per second").fill("5000");
    await expect(card(page, "Servers are over capacity")).toBeVisible();
  });

  test("previews a fix, applies it, and the issue goes away", async ({ page }) => {
    const over = card(page, "Servers are over capacity");
    await expect(over).toContainText("set instances");

    await over.getByRole("button", { name: "Preview impact" }).click();
    const table = over.locator(".fix-preview");
    await expect(table).toContainText("Utilization");
    await expect(table.locator("tr", { hasText: "Utilization" }).locator("td.tone-good")).toBeVisible();
    await expect(table.locator("tr", { hasText: "Monthly cost" }).locator("td.tone-worse")).toBeVisible();
    await expect(table.locator("tr", { hasText: "Open issues" })).toBeVisible();

    await over.getByRole("button", { name: "Apply fix" }).click();
    await expect(card(page, "Servers are over capacity")).toHaveCount(0);
    await expect(utilization(page)).toContainText("66.67%");
  });

  test("an applied fix can be undone from the diagram toolbar", async ({ page }) => {
    await card(page, "Servers are over capacity").getByRole("button", { name: "Apply fix" }).click();
    await expect(card(page, "Servers are over capacity")).toHaveCount(0);

    await page.locator(".toolbar-row").getByRole("button", { name: "Undo" }).click();
    await expect(card(page, "Servers are over capacity")).toBeVisible();
  });

  test("scaling only changes web-facing servers, never background workers", async ({ page }) => {
    await card(page, "Servers are over capacity").getByRole("button", { name: "Apply fix" }).click();
    const worker = page.locator(".component", { hasText: "Order Worker" });
    await expect(worker.locator("dd").first()).toHaveText("2"); // unchanged
    const api = page.locator(".component", { hasText: "API Servers" });
    await expect(api.locator("dd").first()).not.toHaveText("4"); // scaled up
  });

  test("the budget fix lowers instance counts to fit the budget", async ({ page }) => {
    await page.getByLabel("Peak requests per second").fill("100");
    await page.getByLabel("Monthly budget (USD)").fill("600");
    const over = card(page, "Estimated cost exceeds the budget");
    await expect(over).toContainText("Reduce instance counts");
    await over.getByRole("button", { name: "Apply fix" }).click();
    await expect(page.locator(".badge", { hasText: "Within budget" })).toBeVisible();
    await expect(card(page, "Estimated cost exceeds the budget")).toHaveCount(0);
  });

  test("a redundancy fix keeps component names as written", async ({ page }) => {
    const spof = card(page, "Possible single points of failure");
    await expect(spof).toContainText("Mark as highly available: Application Load Balancer");
    await spof.getByRole("button", { name: "Apply fix" }).click();
    await expect(card(page, "Possible single points of failure")).toHaveCount(0);
  });
});
