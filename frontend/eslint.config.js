import js from "@eslint/js";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default [
  { ignores: ["dist", "node_modules", "coverage", "playwright-report", "test-results"] },
  js.configs.recommended,
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { react, "react-hooks": reactHooks },
    settings: { react: { version: "detect" } },
    rules: {
      ...react.configs.recommended.rules,
      ...react.configs["jsx-runtime"].rules,
      ...reactHooks.configs.flat.recommended.rules,
      "react/prop-types": "off", // the project does not use PropTypes
      "react/no-unescaped-entities": "off", // apostrophes in JSX text ("Couldn't ...") are valid
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Unit and component tests (Vitest, with globals switched on in vite.config.js)
    files: ["src/**/*.test.{js,jsx}", "src/test/**"],
    languageOptions: { globals: { ...globals.vitest, ...globals.node } },
  },
  {
    // Node-side files: config and end-to-end tests
    files: ["*.config.js", "e2e/**"],
    languageOptions: { globals: { ...globals.node } },
  },
  prettier, // last: turns off rules that only argue about formatting
];
