import { expect, test } from "@playwright/test";
import { analysisReady, connect, dragNode, generate, node, register } from "./helpers.js";

const edgeCount = (page) => page.locator(".connections li");
const undo = (page) => page.locator(".toolbar-row").getByRole("button", { name: "Undo" });
const redo = (page) => page.locator(".toolbar-row").getByRole("button", { name: "Redo" });

test.describe("editing the diagram", () => {
  test.beforeEach(async ({ page }) => {
    await register(page);
    await generate(page);
    await page.locator(".diagram").scrollIntoViewIfNeeded();
  });

  test("connects two components by dragging, then edits and deletes the connection", async ({ page }) => {
    await expect(edgeCount(page)).toHaveCount(9);
    await connect(page, "Order Worker", "Authentication Service");
    await expect(edgeCount(page)).toHaveCount(10);
    await expect(page.locator(".connections li", { hasText: "Order Worker" }).last()).toContainText(
      "Authentication Service"
    );

    // click the new line, give it a label
    await page.locator('.react-flow__edge[data-id="worker->auth"]').click({ force: true });
    await expect(page.getByText("Edit connection")).toBeVisible();
    await page.getByLabel("Label").fill("token checks");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".connections li", { hasText: "token checks" })).toBeVisible();

    // delete it from the panel
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(edgeCount(page)).toHaveCount(9);
  });

  test("dragging the same connection twice does not create a duplicate", async ({ page }) => {
    await connect(page, "Order Worker", "Authentication Service");
    await expect(edgeCount(page)).toHaveCount(10);
    await connect(page, "Order Worker", "Authentication Service");
    await expect(edgeCount(page)).toHaveCount(10);
  });

  test("selecting a component opens its editor, and settings changes reach the analysis", async ({
    page,
  }) => {
    await analysisReady(page);
    await node(page, "API Servers").click();
    await expect(page.getByText("Edit component")).toBeVisible();

    const rows = page.locator(".config-row");
    await expect(rows.first().getByLabel("Setting name")).toHaveValue("instances");
    await rows.first().getByLabel("Setting value").fill("1");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await expect(page.locator(".component", { hasText: "API Servers" }).locator("dd").first()).toHaveText(
      "1"
    );
    await expect(page.getByText(/1 web-facing server\(s\)/)).toBeVisible();
  });

  test("adding a component of a type from the catalog, then deleting it with the keyboard", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Add component" }).click();
    await expect(page.locator(".add-form select").first().locator("option")).not.toHaveCount(0);
    await page.getByLabel("Name").first().fill("Metrics");
    await page.getByLabel("Type").first().selectOption("monitoring");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(10);

    await node(page, "Metrics").click();
    await page.keyboard.press("Delete");
    await expect(page.locator(".react-flow__node")).toHaveCount(9);
  });

  test("undo and redo step through every kind of edit", async ({ page }) => {
    await expect(undo(page)).toBeDisabled();

    await connect(page, "Order Worker", "Authentication Service");
    await expect(edgeCount(page)).toHaveCount(10);
    await node(page, "Product Images").click();
    await page.keyboard.press("Delete");
    await expect(page.locator(".react-flow__node")).toHaveCount(8);

    await undo(page).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(9);
    await undo(page).click();
    await expect(edgeCount(page)).toHaveCount(9);
    await expect(undo(page)).toBeDisabled();

    await redo(page).click();
    await expect(edgeCount(page)).toHaveCount(10);
    await redo(page).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(8);
    await expect(redo(page)).toBeDisabled();
  });

  test("auto-layout puts a moved component back in its column", async ({ page }) => {
    const cache = node(page, "Session Cache");
    await cache.scrollIntoViewIfNeeded();
    const original = await cache.boundingBox();
    await dragNode(page, "Session Cache", -80, 40);
    await expect.poll(async () => (await cache.boundingBox()).x).not.toBe(original.x);

    await page.getByRole("button", { name: "Auto-layout" }).click();
    await expect.poll(async () => Math.abs((await cache.boundingBox()).x - original.x)).toBeLessThan(60);
  });
});
