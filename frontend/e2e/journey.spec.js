import { expect, test } from "@playwright/test";
import { analysisReady, dragNode, generate, node, register } from "./helpers.js";

test("the whole journey: generate, analyze, edit, save, reload, reopen", async ({ page }) => {
  await register(page);
  await generate(page);

  // The analysis appears on its own, derived from the architecture.
  await analysisReady(page);
  await expect(page.locator(".card-label", { hasText: "Total monthly cost" })).toBeVisible();
  await expect(page.getByLabel("Expected users")).toHaveValue("100000");
  await expect(page.getByText(/4 web-facing server\(s\)/)).toBeVisible(); // workers are excluded
  await expect(page.getByText("Not saved yet")).toBeVisible();

  // Edit the details and add a component.
  await page.getByRole("button", { name: "Edit details" }).click();
  await page.locator("#d-name").fill("My E2E Shop"); // the details form (the Projects panel has a "Project name" box too)
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByRole("heading", { name: "My E2E Shop" })).toBeVisible();

  await page.getByRole("button", { name: "Add component" }).click();
  await page.getByLabel("Name").first().fill("Search Service");
  await page.getByLabel("Type").first().selectOption("search");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(10);
  await expect(node(page, "Search Service")).toBeVisible();

  // The analysis follows the edit (the new component is priced).
  await analysisReady(page);
  await expect(page.locator(".cost-cards .card", { hasText: "Search Service" })).toBeVisible();

  // Save, reload the whole page, and open the project again.
  await page.getByLabel("Project name").fill("E2E Shop");
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.locator('[role="status"]', { hasText: "Saved." })).toBeVisible();
  await expect(page.getByText("Not saved yet")).toHaveCount(0);

  await page.reload();
  await expect(page.getByText("E2E Shop", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("heading", { name: "My E2E Shop" })).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(10);
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);
  await analysisReady(page);
});

test("a saved design remembers where the components were moved", async ({ page }) => {
  await register(page);
  await generate(page);
  await page.waitForTimeout(500); // the diagram reports positions 300 ms after it settles; a save needs them
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.locator('[role="status"]', { hasText: "Saved." })).toBeVisible();

  const cache = node(page, "Session Cache");
  await cache.scrollIntoViewIfNeeded();
  const before = await cache.boundingBox();
  await dragNode(page, "Session Cache", -120, 60);
  await expect.poll(async () => (await cache.boundingBox()).x).not.toBe(before.x);
  await expect(page.getByText("Unsaved changes")).toBeVisible(); // moving counts as a change

  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator('[role="status"]', { hasText: "Saved." })).toBeVisible();
  // Compare against another node: the whole view is re-fitted after a reload, so absolute screen
  // positions change but the distance between two components must not.
  const offsetFromApi = async () => {
    const [c, a] = [
      await node(page, "Session Cache").boundingBox(),
      await node(page, "API Servers").boundingBox(),
    ];
    return { x: c.x - a.x, y: c.y - a.y };
  };
  const moved = await offsetFromApi();

  await page.reload();
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(9);
  await expect(page.getByText("Unsaved changes")).toHaveCount(0); // a reopened project starts clean
  await node(page, "Session Cache").scrollIntoViewIfNeeded();
  const reopened = await offsetFromApi();
  expect(Math.abs(reopened.x - moved.x)).toBeLessThan(8);
  expect(Math.abs(reopened.y - moved.y)).toBeLessThan(8);
});

test("requirements are editable and feed the analysis", async ({ page }) => {
  await register(page);
  await generate(page);
  await analysisReady(page);

  await page.getByLabel("Monthly budget (USD)").fill("300");
  await expect(page.locator(".badge", { hasText: "Over budget" })).toBeVisible();
  await expect(page.getByText("Estimated cost exceeds the budget")).toBeVisible();

  await page.getByLabel("Monthly budget (USD)").fill("5000");
  await expect(page.locator(".badge", { hasText: "Within budget" })).toBeVisible();

  // changing the user count re-estimates the peak traffic
  await page.getByLabel("Expected users").fill("2000000");
  await expect(page.getByText(/Peak traffic of .* estimated from 2,000,000 users/)).toBeVisible();

  // an invalid value is explained and nothing is sent
  await page.getByLabel("Capacity per server (req/s)").fill("-3");
  await expect(page.getByText("Capacity per server must be greater than 0.")).toBeVisible();
});

test("generating again over unsaved work asks first", async ({ page }) => {
  await register(page);
  await generate(page);
  const dialogs = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    return d.dismiss();
  });
  await page.getByRole("button", { name: "Generate Architecture" }).click();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toContain("not saved");
  await expect(page.getByRole("heading", { name: "Demo E-commerce Platform" })).toBeVisible(); // kept
});
