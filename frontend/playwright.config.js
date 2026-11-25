import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests. They start their own copies of the backend (in DEMO_MODE, so no Anthropic key is
 * needed, with a throw-away database) and the frontend, on ports that do not clash with `npm run dev`.
 *
 *   npm run e2e                      run everything (uses your installed Chrome)
 *   E2E_PYTHON=/path/to/python ...   choose the Python that has the backend installed
 *   CI=1 npm run e2e                 what CI does: bundled Chromium, fresh servers, one retry
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(here, "../backend");
const venvPython = [".venv/Scripts/python.exe", ".venv/bin/python"]
  .map((p) => path.join(backendDir, p))
  .find((p) => fs.existsSync(p));
const python = process.env.E2E_PYTHON || venvPython || "python";

const BACKEND_PORT = 8100;
const FRONTEND_PORT = 5273;
const IN_CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: IN_CI ? 1 : 0,
  forbidOnly: IN_CI,
  reporter: IN_CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    acceptDownloads: true,
  },
  projects: [
    {
      name: "chromium",
      // Locally: the Chrome that is already installed (no browser download). In CI: Playwright's Chromium.
      use: { ...devices["Desktop Chrome"], ...(IN_CI ? {} : { channel: "chrome" }) },
    },
  ],
  webServer: [
    {
      command: `"${python}" -m uvicorn app.main:app --port ${BACKEND_PORT}`,
      cwd: backendDir,
      url: `http://localhost:${BACKEND_PORT}/health`,
      reuseExistingServer: !IN_CI,
      timeout: 60_000,
      env: {
        DEMO_MODE: "true",
        DB_PATH: path.join(os.tmpdir(), `sysdesign-e2e-${process.pid}`, "e2e.db"),
        SECRET_KEY: "e2e-only-secret-key-not-for-real-use-0123456789",
        AUTH_RATE_LIMIT_PER_MINUTE: "0",
        RATE_LIMIT_PER_MINUTE: "0",
        CORS_ORIGINS: `http://localhost:${FRONTEND_PORT}`,
      },
    },
    {
      command: `npm run dev -- --port ${FRONTEND_PORT} --strictPort`,
      url: `http://localhost:${FRONTEND_PORT}`,
      reuseExistingServer: !IN_CI,
      timeout: 60_000,
      env: { VITE_API_URL: `http://localhost:${BACKEND_PORT}` },
    },
  ],
});
