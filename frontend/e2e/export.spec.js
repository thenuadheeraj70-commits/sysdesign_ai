import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { generate, register } from "./helpers.js";

test.describe("infrastructure code", () => {
  test.beforeEach(async ({ page }) => {
    await register(page);
    await generate(page);
  });

  const code = (page) => page.locator("#code-title").locator("xpath=ancestor::section");

  test("generates Terraform and Kubernetes files you can browse", async ({ page }) => {
    const section = code(page);
    await section.getByRole("button", { name: "Generate Code" }).click();

    const tf = section.getByRole("tab");
    await expect(tf.filter({ hasText: "main.tf" })).toBeVisible();
    await expect(section.locator(".code-body")).toContainText('resource "aws_security_group"');
    await expect(section.getByText(/Things to check/)).toBeVisible();

    await section.getByRole("tab", { name: "Kubernetes" }).click();
    for (const file of ["deployment.yaml", "service.yaml", "configmap.yaml", "hpa.yaml", "ingress.yaml"]) {
      await expect(section.getByRole("tab", { name: file })).toBeVisible();
    }
    await section.getByRole("tab", { name: "ingress.yaml" }).click();
    await expect(section.locator(".code-body")).toContainText("kind: Ingress");
    await section.getByRole("tab", { name: "hpa.yaml" }).click();
    await expect(section.locator(".code-body")).toContainText("HorizontalPodAutoscaler");
  });

  test("the region from the requirements becomes the Terraform default", async ({ page }) => {
    await page.getByLabel("Region").fill("eu-west-1");
    const section = code(page);
    await section.getByRole("button", { name: "Generate Code" }).click();
    await section.getByRole("tab", { name: "variables.tf" }).click();
    await expect(section.locator(".code-body")).toContainText('default     = "eu-west-1"');
  });

  test("an invalid region is explained instead of producing broken code", async ({ page }) => {
    await page.getByLabel("Region").fill("nowhere");
    const section = code(page);
    await section.getByRole("button", { name: "Generate Code" }).click();
    await expect(section.getByRole("alert")).toContainText("not a valid AWS region");
  });

  test("warns when the design changed after the code was generated", async ({ page }) => {
    const section = code(page);
    await section.getByRole("button", { name: "Generate Code" }).click();
    await expect(section.getByRole("tab", { name: "main.tf" })).toBeVisible();

    await page.getByRole("button", { name: "Add component" }).click();
    await page.getByLabel("Name").first().fill("Extra");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(section.getByText(/has changed since this code was generated/)).toBeVisible();
  });

  test("downloads a ZIP with the Terraform, Kubernetes and README files", async ({ page }) => {
    const section = code(page);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      section.getByRole("button", { name: "Download ZIP" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("demo-e-commerce-platform-infrastructure.zip");

    const bytes = fs.readFileSync(await download.path());
    expect(bytes.subarray(0, 2).toString()).toBe("PK"); // a real ZIP archive
    const text = bytes.toString("latin1"); // entry names are stored uncompressed in the ZIP directory
    for (const name of ["terraform/main.tf", "kubernetes/ingress.yaml", "kubernetes/hpa.yaml", "README.md"]) {
      expect(text).toContain(name);
    }
  });
});
