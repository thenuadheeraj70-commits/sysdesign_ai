import { expect } from "@playwright/test";

/** A new account for every test, so tests never see each other's projects. */
export function newAccount() {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return { email: `e2e-${id}@example.com`, password: `E2e-${id}-pw` };
}

/** Create an account through the UI and land in the workspace. */
export async function register(page, account = newAccount()) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(`Signed in as ${account.email}`)).toBeVisible();
  return account;
}

/** Generate the sample architecture (the backend runs in DEMO_MODE) and wait until it is drawn. */
export async function generate(page, prompt = "Build an e-commerce app for 100000 users on AWS") {
  await page.getByLabel("Requirements").fill(prompt);
  await page.getByRole("button", { name: "Generate Architecture" }).click();
  await expect(page.getByRole("heading", { name: "Demo E-commerce Platform" })).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(9);
}

/** The diagram's node for a component, found by its visible name. */
export const node = (page, name) => page.locator(".react-flow__node", { hasText: name });

/** The Analysis section has finished calculating. */
export async function analysisReady(page) {
  await expect(page.getByText("Up to date.")).toBeVisible();
}

/** Drag from one node's connection handle to another's, with real mouse movement. */
export async function connect(page, fromName, toName) {
  const from = await node(page, fromName).locator(".react-flow__handle.source").boundingBox();
  const to = await node(page, toName).locator(".react-flow__handle.target").boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
}

/** The token the app keeps after login, for calling the API directly in a test. */
export const tokenOf = (page) => page.evaluate(() => localStorage.getItem("sysdesign_token"));

export const API = "http://localhost:8100";

/** Move a node by (dx, dy) pixels with real, stepwise mouse movement (the canvas ignores a single jump). */
export async function dragNode(page, name, dx, dy) {
  const box = await node(page, name).boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
}
