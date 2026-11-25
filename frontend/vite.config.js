import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  test: {
    environment: "jsdom",
    globals: true, // lets Testing Library clean up after every test on its own
    setupFiles: ["./src/test/setup.js"],
    include: ["src/**/*.test.{js,jsx}"],
    css: false,
    testTimeout: 15000, // app-level tests wait for a 500 ms debounce
    maxWorkers: 3, // many jsdom files at once starve each other on small machines and cause timing failures
    coverage: {
      provider: "v8",
      include: ["src/**/*.{js,jsx}"],
      exclude: ["src/main.jsx", "src/test/**", "src/**/*.test.{js,jsx}"],
      reporter: ["text-summary", "text"],
      // `npm run coverage` fails below these. The diagram canvas (ArchitectureDiagram.jsx) needs a real
      // browser, so it is covered by the end-to-end tests instead. Raise these as coverage grows.
      thresholds: { statements: 80, lines: 80, branches: 80, functions: 70 },
    },
  },
});
