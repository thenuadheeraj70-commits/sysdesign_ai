import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { analysisReady, generate, node, register } from "./helpers.js";

/** Click a tab in a tablist by its visible name. */
const tab = (page, name) => page.getByRole("tab", { name, exact: true });

/** Click a button that starts a download, and return the saved file's text (or bytes with `binary`). */
async function download(page, button, { binary = false } = {}) {
  const [file] = await Promise.all([page.waitForEvent("download"), button.click()]);
  const path = await file.path();
  return { name: file.suggestedFilename(), data: fs.readFileSync(path, binary ? undefined : "utf-8") };
}

test.beforeEach(async ({ page }) => {
  page.on("dialog", (dialog) => dialog.accept()); // confirm() questions (replace unsaved work, restore a version)
});

test.describe("Phase 3: variants and planning", () => {
  test("add presets, compare them, and use the what-if slider, growth and budget advisor", async ({
    page,
  }) => {
    await register(page);
    await generate(page);
    await analysisReady(page);

    // Add a Cheap variant from the menu and switch back and forth.
    await page.getByRole("button", { name: "Add variant" }).click();
    await page.getByRole("menuitem", { name: /Cheap/ }).click();
    await expect(page.getByRole("tablist", { name: "Variants of this design" }).getByRole("tab")).toHaveCount(
      2
    );
    await expect(page.getByRole("tab", { name: /Cheap/ })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Original" }).click();
    await expect(page.getByRole("tab", { name: "Original" })).toHaveAttribute("aria-selected", "true");

    // The comparison table has a column per variant, a recommendation and ranks.
    const planning = page.getByRole("region", { name: "Planning tools" });
    await expect(planning.locator(".compare-table th", { hasText: "Cheap" })).toBeVisible();
    await expect(planning.getByText("Suggestion.")).toBeVisible();
    await expect(planning.getByText("Rank by cost / resilience")).toBeVisible();

    // What-if: the slider changes utilization without another server call.
    await tab(page, "Traffic what-if").click();
    const before = await planning
      .locator(".card", { hasText: "Utilization" })
      .locator(".card-value")
      .innerText();
    await planning.getByRole("button", { name: "10×" }).click();
    const after = await planning
      .locator(".card", { hasText: "Utilization" })
      .locator(".card-value")
      .innerText();
    expect(parseFloat(after)).toBeGreaterThan(parseFloat(before));
    // Typing an exact number works (it used to snap to the minimum after each key press).
    const exact = planning.getByLabel("Exact req/s");
    await exact.fill("250");
    await expect(exact).toHaveValue("250");
    await expect(planning.getByRole("img").first()).toBeVisible();

    // Growth and budget advisor.
    await tab(page, "Growth").click();
    await expect(planning.getByText("Web servers").first()).toBeVisible();
    await tab(page, "Budget advisor").click();
    await planning.getByLabel("Monthly budget (USD)").fill("50");
    await expect(planning.getByRole("button", { name: /Apply this step/ })).toBeVisible();
    const nodesBefore = await page.locator(".react-flow__node").count();
    await planning.getByRole("button", { name: /Apply this step/ }).click();
    await expect(page.locator(".react-flow__node")).not.toHaveCount(0);
    await analysisReady(page);
    expect(await page.locator(".react-flow__node").count()).toBeLessThanOrEqual(nodesBefore);
  });

  test("a variant keeps its own edits and undo history", async ({ page }) => {
    await register(page);
    await generate(page);
    await page.getByRole("button", { name: "Add variant" }).click();
    await page.getByRole("menuitem", { name: /Copy of this design/ }).click();
    await page.getByRole("button", { name: "Add component" }).click();
    await page.getByLabel("Name").first().fill("Search Service");
    await page.getByLabel("Type").first().selectOption("search");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(10);
    await page.getByRole("tab", { name: "Original", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(9); // the original is untouched
    await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled(); // and has its own history
  });
});

test.describe("Phase 4: design toolkit", () => {
  test("every tab shows something useful for the generated design", async ({ page }) => {
    await register(page);
    await generate(page);
    const toolkit = page.getByRole("region", { name: "Design toolkit" });
    await expect(toolkit).toBeVisible();

    // Capacity: formulas, and an assumption you change moves the numbers.
    await expect(toolkit.getByText("How it is worked out").first()).toBeVisible();
    const users = toolkit.getByLabel(/Total users/);
    await users.fill("5000000");
    await expect(users).toHaveValue("5000000");
    await expect(toolkit.locator("td code").first()).toBeVisible();

    await tab(page, "API design").click();
    await expect(toolkit.getByText(/Application type detected: ecommerce/)).toBeVisible();
    await expect(toolkit.locator(".method").first()).toBeVisible();

    await tab(page, "Data model").click();
    await expect(toolkit.getByRole("heading", { name: /^User|Order|Product/ }).first()).toBeVisible();
    await expect(toolkit.getByText("CREATE TABLE").first()).toBeHidden(); // the SQL is inside a closed section
    await toolkit.getByText("Show the SQL").click();
    await expect(toolkit.getByText("CREATE TABLE").first()).toBeVisible();

    // Sequence diagrams: a drawn SVG, and an unavailable flow explains itself.
    await tab(page, "Sequence diagrams").click();
    await expect(toolkit.locator("svg.seq")).toBeVisible();
    expect(await toolkit.locator("svg.seq line.seq-line").count()).toBeGreaterThan(0); // horizontal lines have no height, so they are not "visible"
    await toolkit.getByRole("button", { name: /Search/ }).click();
    await expect(toolkit.getByRole("heading", { name: /Search/ })).toBeVisible();

    await tab(page, "Decisions").click();
    await expect(toolkit.getByText(/ADR-001/)).toBeVisible();

    await tab(page, "Patterns").click();
    await expect(toolkit.getByRole("heading", { name: /Already in your design/ })).toBeVisible();

    await tab(page, "Reliability").click();
    await expect(toolkit.getByText("Availability", { exact: true }).first()).toBeVisible();
    await toolkit.getByLabel(/Availability target/).fill("99.99");
    await expect(toolkit.getByText(/Against your targets/)).toBeVisible();

    await tab(page, "Learn").click();
    await toolkit.getByLabel("Search terms").fill("failover");
    await expect(toolkit.locator("dt", { hasText: "Failover" })).toBeVisible();
  });

  test("a reliability fix is applied to the diagram, and undo takes it back", async ({ page }) => {
    await register(page);
    await generate(page);
    const toolkit = page.getByRole("region", { name: "Design toolkit" });
    await tab(page, "Reliability").click();
    await toolkit.getByLabel(/Recovery time/).fill("1");
    const fix = toolkit.getByRole("button", { name: /Keep 7 days of backups|multi-zone|two copies/ }).first();
    await fix.click();
    await analysisReady(page);
    await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled();
  });

  test("multi-region: plan two regions and add the result as a variant", async ({ page }) => {
    await register(page);
    await generate(page);
    const toolkit = page.getByRole("region", { name: "Design toolkit" });
    await tab(page, "Multi-region").click();
    await toolkit.getByRole("checkbox", { name: /Ireland/ }).check();
    await toolkit.getByRole("radio", { name: /Active-active/ }).check();
    await toolkit.getByRole("button", { name: "Add where users are" }).click();
    await expect(toolkit.getByText("Add 6 component(s) in eu-west-1")).toBeVisible();
    await toolkit.getByRole("button", { name: "Add as a new variant" }).click();
    const variants = page.getByRole("tablist", { name: "Variants of this design" });
    await expect(variants.getByRole("tab", { name: /Multi-region/ })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(page.locator(".react-flow__node")).toHaveCount(15);
  });

  test("explain this component, with a glossary tip", async ({ page }) => {
    await register(page);
    await generate(page);
    await node(page, "Primary Database").click();
    await page.getByRole("button", { name: "Explain this component" }).click();
    const box = page.getByRole("region", { name: "Explanation" });
    await expect(box.getByText("The system of record", { exact: false })).toBeVisible();
    await expect(box.getByText("Common mistakes")).toBeVisible();
    await expect(box.locator(".term").first()).toHaveAttribute("data-definition", /.+/);
  });
});

test.describe("Phase 5: AI assistant (demo mode, rule-based)", () => {
  test("change the design from a sentence: review the diff, accept, and undo", async ({ page }) => {
    await register(page);
    await generate(page);
    const ai = page.getByRole("region", { name: "AI assistant" });
    await ai.getByLabel("Describe a change").fill("add a search service");
    await ai.getByRole("button", { name: "Suggest change" }).click();
    const answer = ai.getByRole("region", { name: "Suggested change" });
    await expect(answer.getByText("Rule-based (no AI key)")).toBeVisible();
    await expect(answer.getByText("Search Cluster (search)")).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(9); // nothing changes until accepted

    await answer.getByRole("button", { name: "Accept" }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(10);
    await expect(node(page, "Search Cluster")).toBeVisible();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(9);
  });

  test("a discarded suggestion changes nothing, and an unknown request says so", async ({ page }) => {
    await register(page);
    await generate(page);
    const ai = page.getByRole("region", { name: "AI assistant" });
    await ai.getByLabel("Describe a change").fill("add monitoring");
    await ai.getByRole("button", { name: "Suggest change" }).click();
    await ai.getByRole("button", { name: "Discard" }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(9);
    await ai.getByLabel("Describe a change").fill("bake me a cake");
    await ai.getByRole("button", { name: "Suggest change" }).click();
    await expect(ai.getByText("Nothing was changed.")).toBeVisible();
  });

  test("review, usage and prompt history", async ({ page }) => {
    await register(page);
    await generate(page, "Build a coffee shop app for 5000 users");
    const ai = page.getByRole("region", { name: "AI assistant" });
    await tab(page, "AI review").click();
    await ai.getByRole("button", { name: "Review my design" }).click();
    await expect(ai.getByText("Rule-based stand-in (no AI key)")).toBeVisible();
    await tab(page, "Usage and history").click();
    await expect(ai.getByText("Demo mode is on")).toBeVisible();
    await expect(ai.getByRole("button", { name: /Build a coffee shop app/ })).toBeVisible();
    await ai.getByRole("button", { name: /Build a coffee shop app/ }).click();
    await expect(page.locator("#requirements")).toHaveValue("Build a coffee shop app for 5000 users");
  });

  test("rate a design, and regenerate while keeping edits", async ({ page }) => {
    await register(page);
    await generate(page);
    await page.getByRole("button", { name: "Helpful", exact: true }).click();
    await expect(page.getByText("Thanks, saved.")).toBeVisible();
    await page.getByRole("button", { name: "Add component" }).click();
    await page.getByLabel("Name").first().fill("Search Service");
    await page.getByLabel("Type").first().selectOption("search");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(10);
    const ai = page.getByRole("region", { name: "AI assistant" });
    await ai.getByRole("button", { name: "Regenerate keeping my edits" }).click();
    await expect(ai.getByRole("button", { name: "Regenerate keeping my edits" })).toBeEnabled();
    await expect(node(page, "Search Service")).toBeVisible(); // the edit survived
  });

  test("import a text file into the requirements box", async ({ page }) => {
    await register(page);
    await page.getByLabel("Choose a file to import").setInputFiles({
      name: "brief.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Build a ticketing site\nfor 20000 users"),
    });
    await expect(page.locator("#requirements")).toHaveValue("Build a ticketing site\nfor 20000 users");
    await expect(page.getByText(/Text read from the file/)).toBeVisible();
    // An unsupported file is refused with a reason and the box is left alone.
    await page
      .getByLabel("Choose a file to import")
      .setInputFiles({ name: "a.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
    await expect(page.getByRole("alert").filter({ hasText: "Use a text" })).toBeVisible();
    await expect(page.locator("#requirements")).toHaveValue("Build a ticketing site\nfor 20000 users");
  });
});

test.describe("Phase 6: export, import, share, history", () => {
  test("download the document, cost table, diagram and design file", async ({ page }) => {
    await register(page);
    await generate(page);
    await analysisReady(page);
    const panel = page.getByRole("region", { name: "Export and share" });

    const md = await download(page, panel.getByRole("button", { name: "Document (Markdown)" }));
    expect(md.name).toBe("demo-e-commerce-platform.md");
    expect(md.data).toContain("# Demo E-commerce Platform");
    expect(md.data).toContain("```mermaid");
    expect(md.data).toContain("## Cost");

    const csv = await download(page, panel.getByRole("button", { name: "Cost table (CSV)" }));
    expect(csv.name.endsWith(".csv")).toBe(true);
    expect(csv.data.split("\r\n")[0]).toContain("Monthly cost");
    expect(csv.data).toContain("Total");

    const svg = await download(page, panel.getByRole("button", { name: "SVG image" }));
    expect(svg.data.startsWith("<svg")).toBe(true);
    expect((svg.data.match(/<rect /g) ?? []).length).toBeGreaterThanOrEqual(9);

    const png = await download(page, panel.getByRole("button", { name: "PNG image" }), { binary: true });
    expect(png.name.endsWith(".png")).toBe(true);
    expect(png.data.subarray(0, 4).toString("hex")).toBe("89504e47"); // a real PNG
    expect(png.data.length).toBeGreaterThan(2000);

    const json = await download(page, panel.getByRole("button", { name: "Design file (JSON)" }));
    const file = JSON.parse(json.data);
    expect(file.format).toBe("sysdesign-ai");
    expect(file.architecture.components).toHaveLength(9);

    await panel.getByRole("button", { name: "Copy as Mermaid" }).click();
    await expect(panel.getByText(/Mermaid text copied|Could not copy/)).toBeVisible();
  });

  test("the printable document opens in a new tab with the diagram", async ({ page, context }) => {
    await register(page);
    await generate(page);
    const [popup] = await Promise.all([
      context.waitForEvent("page"),
      page.getByRole("button", { name: "Document for PDF (print)" }).click(),
    ]);
    await popup.waitForLoadState();
    await expect(popup.getByRole("heading", { name: "Demo E-commerce Platform", level: 1 })).toBeVisible();
    await expect(popup.getByRole("img", { name: /Architecture diagram/ })).toBeVisible();
    expect(await popup.locator("img").evaluate((img) => img.naturalWidth)).toBeGreaterThan(100);
    await expect(popup.getByText(/Save as PDF/).first()).toBeVisible();
  });

  test("a design file round trips: download, change, import it back", async ({ page }) => {
    await register(page);
    await generate(page);
    const panel = page.getByRole("region", { name: "Export and share" });
    const json = await download(page, panel.getByRole("button", { name: "Design file (JSON)" }));

    await page.getByRole("button", { name: "Add component" }).click();
    await page.getByLabel("Name").first().fill("Extra");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(10);

    await panel
      .getByLabel("Choose a design file")
      .setInputFiles({ name: "design.json", mimeType: "application/json", buffer: Buffer.from(json.data) });
    await expect(page.locator(".react-flow__node")).toHaveCount(9);
    await expect(panel.getByText(/imported as a new, unsaved design/)).toBeVisible();
    await expect(page.getByText("Not saved yet")).toBeVisible();
  });

  test("a bad design file is refused with a reason and the design is untouched", async ({ page }) => {
    await register(page);
    await generate(page);
    const panel = page.getByRole("region", { name: "Export and share" });
    await panel
      .getByLabel("Choose a design file")
      .setInputFiles({ name: "x.json", mimeType: "application/json", buffer: Buffer.from("not json") });
    await expect(panel.getByRole("alert")).toContainText("not valid JSON");
    await panel.getByLabel("Choose a design file").setInputFiles({
      name: "y.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"nothing": true}'),
    });
    await expect(panel.getByRole("alert")).toContainText("no list of components");
    await expect(page.locator(".react-flow__node")).toHaveCount(9);
  });

  test("share a read-only link that works without a login, then turn it off", async ({ page, browser }) => {
    await register(page);
    await generate(page);
    const panel = page.getByRole("region", { name: "Export and share" });
    await tab(page, "Share").click();
    await expect(panel.getByText(/Save the project first/)).toBeVisible();

    await page.getByRole("button", { name: "Save project" }).click();
    await expect(page.locator('[role="status"]', { hasText: "Saved." })).toBeVisible();
    await panel.getByRole("button", { name: "Create a share link" }).click();
    const link = await panel.getByLabel("Link").inputValue();
    expect(link).toMatch(/\?shared=[A-Za-z0-9_-]{30,}/);

    // A brand-new browser profile (no login at all) can read it.
    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto(link);
    await expect(visitor.getByRole("heading", { name: "Demo E-commerce Platform", level: 1 })).toBeVisible();
    await expect(visitor.getByText("Read-only")).toBeVisible();
    await expect(visitor.getByText("Log in")).toHaveCount(0);
    await expect(visitor.getByRole("button", { name: /Generate|Save project|Add component/ })).toHaveCount(0);
    const diagram = visitor.getByRole("img", { name: /Architecture diagram/ });
    await expect(diagram).toBeVisible();
    expect(await diagram.evaluate((img) => img.naturalWidth)).toBeGreaterThan(100);
    await expect(visitor.getByRole("heading", { name: "Cost" })).toBeVisible();
    await expect(visitor.getByRole("heading", { name: "Components" })).toBeVisible();

    // Turning it off kills the link for everyone.
    await panel.getByRole("button", { name: "Turn off the link" }).click();
    await expect(panel.getByRole("button", { name: "Create a share link" })).toBeVisible();
    await visitor.reload();
    await expect(visitor.getByRole("alert")).toContainText("turned off");
    await visitor.context().close();
  });

  test("a guessed share link shows a clear message", async ({ page }) => {
    await page.goto("/?shared=" + "x".repeat(30));
    await expect(page.getByRole("alert")).toContainText("does not exist or has been turned off");
  });

  test("version history: compare with now, then restore an older version", async ({ page }) => {
    await register(page);
    await generate(page);
    await page.getByRole("button", { name: "Save project" }).click();
    await expect(page.locator('[role="status"]', { hasText: "Saved." })).toBeVisible();

    await page.getByRole("button", { name: "Add component" }).click();
    await page.getByLabel("Name").first().fill("Search Service");
    await page.getByLabel("Type").first().selectOption("search");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(10);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator('[role="status"]', { hasText: "Saved." })).toBeVisible();

    const panel = page.getByRole("region", { name: "Export and share" });
    await tab(page, "Version history").click();
    await expect(panel.getByRole("row")).toHaveCount(3); // header + two versions
    await expect(panel.getByText("Saved (latest)")).toBeVisible();

    await panel.getByRole("button", { name: "Compare with now" }).last().click();
    const diff = panel.getByRole("region", { name: "Changes since this version" });
    await expect(diff.getByText("Search Service (search)")).toBeVisible();

    await panel.getByRole("button", { name: "Restore" }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(9);
    await expect(panel.getByText(/Restored version/)).toBeVisible();
    // The state before restoring is kept, so the restore can itself be undone.
    await expect(panel.getByText("Before restoring")).toBeVisible();
  });

  test("download all my projects", async ({ page }) => {
    await register(page);
    await generate(page);
    await page.getByRole("button", { name: "Save project" }).click();
    await expect(page.locator('[role="status"]', { hasText: "Saved." })).toBeVisible();
    await tab(page, "Your data").click();
    const all = await download(page, page.getByRole("button", { name: "Download all my projects" }));
    const data = JSON.parse(all.data);
    expect(data.projects).toHaveLength(1);
    expect(data.projects[0].architecture.components).toHaveLength(9);
  });

  test("printing the shared page hides the controls", async ({ page, browser }) => {
    await register(page);
    await generate(page);
    await page.getByRole("button", { name: "Save project" }).click();
    await expect(page.locator('[role="status"]', { hasText: "Saved." })).toBeVisible();
    await tab(page, "Share").click();
    await page.getByRole("button", { name: "Create a share link" }).click();
    const link = await page.getByLabel("Link").inputValue();
    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto(link);
    await visitor.emulateMedia({ media: "print" });
    await expect(visitor.getByRole("button", { name: "Print or save as PDF" })).toBeHidden();
    await expect(visitor.getByRole("heading", { name: "Demo E-commerce Platform", level: 1 })).toBeVisible();
    await visitor.context().close();
  });
});
