import { expect, test } from "@playwright/test";
import { API, generate, register, tokenOf } from "./helpers.js";

const projectsPanel = (page) => page.locator("#projects-title").locator("xpath=ancestor::section");
// Rows of the main list only (the trash, when open, has its own rows with the same names).
const projectRow = (page, name) =>
  projectsPanel(page)
    .locator(":scope > ul.components > li", { has: page.getByText(name, { exact: true }) })
    .first();

/** Save projects straight through the API so tests can set up many quickly. */
async function seed(page, names) {
  const token = await tokenOf(page);
  const architecture = {
    project_name: "Seed",
    description: "",
    assumptions: [],
    connections: [],
    components: [{ id: "a", name: "A", type: "compute", provider: "aws", configuration: {} }],
  };
  for (const name of names) {
    const response = await page.request.post(`${API}/api/projects`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name, prompt: "", architecture },
    });
    expect(response.ok()).toBeTruthy();
  }
  await page.reload();
}

test.describe("saved projects", () => {
  test.beforeEach(async ({ page }) => {
    await register(page);
  });

  test("search, sort and page through many projects", async ({ page }) => {
    await seed(page, ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"]);
    const panel = projectsPanel(page);

    await expect(panel.getByText("Page 1 of 2 (6 projects)")).toBeVisible();
    await expect(panel.locator(":scope > ul > li")).toHaveCount(5);
    await panel.getByRole("button", { name: "Next" }).click();
    await expect(panel.getByText("Page 2 of 2 (6 projects)")).toBeVisible();
    await expect(panel.locator(":scope > ul > li")).toHaveCount(1);

    await panel.getByLabel("Search projects").fill("ga");
    await expect(panel.locator(":scope > ul > li")).toHaveCount(1);
    await expect(projectRow(page, "Gamma")).toBeVisible();
    await panel.getByLabel("Search projects").fill("zzz");
    await expect(panel.getByText("No projects match your search.")).toBeVisible();

    await panel.getByLabel("Search projects").fill("");
    await panel.getByLabel("Sort projects").selectOption("name");
    await expect(panel.locator(":scope > ul > li strong").first()).toHaveText("Alpha");
  });

  test("rename and duplicate", async ({ page }) => {
    await seed(page, ["Original"]);
    const panel = projectsPanel(page);

    await projectRow(page, "Original").getByRole("button", { name: "Rename" }).click();
    await panel.getByLabel("New project name").fill("Renamed");
    await panel.getByRole("button", { name: "Save name" }).click();
    await expect(projectRow(page, "Renamed")).toBeVisible();

    await projectRow(page, "Renamed").getByRole("button", { name: "Duplicate" }).click();
    await expect(projectRow(page, "Renamed (copy)")).toBeVisible();
  });

  test("delete moves to the trash; undo, restore and delete forever work", async ({ page }) => {
    await seed(page, ["Keep", "Remove"]);
    const panel = projectsPanel(page);

    await projectRow(page, "Remove").getByRole("button", { name: "Delete" }).click();
    await expect(projectRow(page, "Remove")).toHaveCount(0);
    await expect(panel.getByText(/Moved "Remove" to the trash/)).toBeVisible();
    await panel.getByRole("button", { name: "Undo" }).click(); // straight back
    await expect(projectRow(page, "Remove")).toBeVisible();

    await projectRow(page, "Remove").getByRole("button", { name: "Delete" }).click();
    await panel.getByText("Trash (1)").click();
    await expect(panel.getByText("30 days left")).toBeVisible();
    await panel.getByRole("button", { name: "Restore" }).click();
    await expect(projectRow(page, "Remove")).toBeVisible();

    await projectRow(page, "Remove").getByRole("button", { name: "Delete" }).click();
    await panel.getByText("Trash (1)").click();
    page.once("dialog", (d) => d.accept()); // "Delete forever? This cannot be undone."
    await panel.getByRole("button", { name: "Delete forever" }).click();
    await expect(panel.getByText(/Trash \(/)).toHaveCount(0);
    await expect(projectRow(page, "Remove")).toHaveCount(0);
    await expect(projectRow(page, "Keep")).toBeVisible();
  });

  test("opening another project warns about unsaved work, and can be declined", async ({ page }) => {
    await seed(page, ["Saved one"]);
    await generate(page);
    const messages = [];
    page.once("dialog", (d) => {
      messages.push(d.message());
      return d.dismiss();
    });
    await projectRow(page, "Saved one").getByRole("button", { name: "Open" }).click();
    await expect.poll(() => messages.length).toBe(1);
    await expect(page.getByRole("heading", { name: "Demo E-commerce Platform" })).toBeVisible(); // still here

    page.once("dialog", (d) => d.accept());
    await projectRow(page, "Saved one").getByRole("button", { name: "Open" }).click();
    await expect(page.getByRole("heading", { name: "Seed" })).toBeVisible();
  });

  test("one user's projects are never visible to another", async ({ page, browser }) => {
    await seed(page, ["Private"]);
    const other = await (await browser.newContext()).newPage();
    await register(other);
    await expect(other.getByText("No saved projects yet.")).toBeVisible();
    await expect(other.getByText("Private")).toHaveCount(0);
    await other.context().close();
  });
});
