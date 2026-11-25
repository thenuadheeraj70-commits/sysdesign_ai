# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added (Phase 6: export and sharing)

- **Design document** (`POST /api/export/document`): requirements, assumptions, diagram (Mermaid in Markdown, an
  embedded image in the printable page), components, performance, cost table, recommendations, risks and the
  toolkit results. The printable page is saved as PDF with the browser's Print command.
- **Diagram export**: SVG (drawn on the server, text escaped), PNG (drawn in the browser from the SVG) and Mermaid.
- **Design files**: download a design as JSON and import it again. Imports go through the same cleaning as AI
  output, report what was dropped, and load as a new unsaved design.
- **Cost table as CSV**, with spreadsheet formulas in names neutralised.
- **Read-only share links**: an unguessable link shows the saved design, diagram and analysis without a login;
  it can be turned off at any time, and also provides an image URL for documents and wikis.
- **Version history**: a version is kept on every save (latest 30); compare with the current design in words,
  restore (the state before restoring is kept too).
- **Your data**: download all projects, including the trash, as one JSON file.
- Print stylesheet for the shared page.
- Not built from this phase: syntax highlighting, per-file download and a diff against the previous generation in
  the infrastructure code viewer.

### Fixed (found by the Phase 3 to 6 tests)

- A non-list `connections` or `assumptions` field in an AI answer or an imported file crashed with a 500; it is now
  repaired like any other bad field.
- The AI response cache could store an invalid answer; answers are now cached only after they have been checked.
- API keys could appear in error messages (the Gemini adapter put the key in the request URL). The key is now sent
  in a header, and every error message is redacted.
- The saved-projects list jumped back to page 1 300 ms after loading, undoing paging the user had already done.
- Typing in the traffic what-if "Exact req/s" box snapped to the slider limit after each key press.
- Glossary tips did not match simple plurals ("indexes"), and the Explain panel's list of mistakes had no tips.
- The "Choose a file" input's label clashed with the Requirements box's label for screen readers and tests.

### Tested

- Backend: 319 tests, 92% coverage. Frontend: 277 tests, 91% statement coverage. Browser: 51 end-to-end tests that
  drive the real UI against a real backend, including the share link opened in a separate, logged-out browser.
- Tests never reach a real AI service: they ignore any key in `backend/.env`, and use a fake client.

### Added (Phase 5: smarter AI)

- **Change the design from a sentence** (`POST /api/refine`): the AI (or, without a key, the app's own rules)
  proposes a patch, shown as adds, removes and changes to accept or discard. Accepting is one undo step.
- **Regenerate keeping my edits** (`POST /api/regenerate`): generation with the current design as context.
- **AI review** (`POST /api/review`): a critique in the same form as the recommendations, labelled by source.
- **Import a file** (`POST /api/import-document`): text and Markdown directly; PDFs and diagram images are read
  by Claude into requirements text you check before generating.
- **Structured output**: generation, refine and review answer by calling a tool with a JSON schema; plain JSON
  text and the retry-with-error loop remain as fallbacks.
- **Resilience** (`services/ai_core.py`): retries with backoff on rate-limit, overload and connection errors, an
  optional fallback model (`AI_FALLBACK_MODEL`), and a circuit breaker that pauses calls after repeated failures.
- **Cache, streaming, usage**: identical requests are answered from a short cache (`AI_CACHE_SECONDS`, shown as
  "cached"); generation streams progress (`POST /api/architecture/stream`); tokens are counted per user and task
  with a monthly allowance (`AI_MONTHLY_TOKEN_QUOTA`) and a usage tab; models are set per task
  (`AI_MODEL_GENERATION`, `AI_MODEL_EXTRACTION`, `AI_MODEL_REVIEW`, `AI_MODEL_REFINE`, `AI_MODEL_DOCUMENT`).
- **Prompt history and feedback**: recent prompts per user, thumbs up/down and a comment on each generation.
- **Hardening and evaluation**: control characters and line breaks are removed from all AI text before it is
  stored or reaches Terraform, YAML or Markdown (`services/sanitize.py`); `backend/evals/` holds 15 fixed prompts
  (3 hostile) and a checker to run after changing a prompt or model.

### Changed (Phase 5)

- Two new tables (`ai_usage`, `ai_generations`); existing databases get them on startup.
- `generateArchitecture` in the frontend client takes optional `{ onProgress, meta }`; the App test mock lists the
  new client functions. No tests were added or run for this phase.

### Added (Phase 4: system design toolkit)

- **Design toolkit section** with nine tabs; only the open tab calculates, nothing calls the AI, and no login is
  needed. Everything is worked out by stated rules from the design and requirements.
- **Capacity estimate** (`POST /api/capacity`): requests per second, bandwidth, storage growth, cache memory,
  database shards and servers, each with its formula and an editable assumption (saved with the requirements as
  `capacity_inputs`), compared with the current design.
- **API design** (`POST /api/api-design`): endpoints per service for the detected application type, and an
  OpenAPI 3 skeleton to download.
- **Data model** (`POST /api/data-model`): entities, fields, relations, the store each belongs in, a Mermaid ER
  diagram and Postgres or MySQL DDL.
- **Sequence diagrams** (`POST /api/sequences`): read, sign-in, write, upload and search flows through the real
  components, drawn as SVG and exportable as Mermaid.
- **Decision records** (`POST /api/decisions`): context, decision, alternatives and consequences for each major
  choice, as Markdown.
- **Patterns** (`POST /api/patterns`): 11 patterns marked recommended, consider, in place or not needed, with the
  evidence, when to use and not use them, and one-click fixes where the diagram would change.
- **Reliability** (`POST /api/reliability`): availability from series and parallel redundancy, RTO and RPO,
  checked against targets (saved as `reliability` in the requirements), with fixes.
- **Multi-region** (`POST /api/multi-region`): distance-based latency, replication links, failover steps, and a
  ready-made multi-region variant to compare.
- **Explain and learn**: "Explain this component" in the component panel (`POST /api/explain`), glossary tips on
  terms across the tools, and a Learn tab (`GET /api/glossary`).

### Added (Phase 3: compare designs and what-if tools)

- **Design variants.** A project holds up to six designs, each with its own undo history, diagram positions and
  share of the traffic. Tabs above the diagram switch between them; add a copy or a preset, rename, duplicate
  and delete. Saved with the project; older projects open as a single "Original" variant.
- **Presets.** Cheap, Balanced and Highly available, plus Development, Staging and Production variants, built by
  explainable rules (`POST /api/presets`). Each lists exactly what it changed.
- **Comparison table.** Cost, utilization, servers, issues by severity, single points of failure, a resilience
  score and ranks for every variant, with a suggestion (`POST /api/compare`).
- **Traffic what-if.** A slider from a tenth to ten times today's peak, with utilization, servers needed and cost
  that follow, a chart, and where capacity runs out (`POST /api/what-if`).
- **Growth projection.** Month-by-month traffic growth, when the web servers, database and cache each need to
  scale, and the cost of keeping up (`POST /api/growth`).
- **Budget advisor.** The cheapest changes that fit a budget, safest first, each with its risk and a one-click
  "apply up to this step" (`POST /api/budget-advisor`). Patches can now remove components.
- **Traffic profile and discounts.** Peak-to-average ratio, surge multiplier, read share and cache hit rate;
  reserved/savings-plan and spot discounts on the cost lines. Saved with the requirements.

### Changed (Phase 3)

- Analysis requests accept a `traffic_scale` (used by dev and staging variants). Cost responses report
  `discount_savings`, and each line its `discount_percent`.
- The Analysis section's capacity and latency overrides are shared with the planning tools.
- The existing App test's API mock lists the new client functions; no tests were added or run for this phase.

### Added (Phase 2: engineering foundation)

- Backend linting, formatting and type checking with ruff and mypy, configured in `backend/pyproject.toml`.
- Backend coverage gate (90%), currently about 94%.
- AI integration tests with a fake Anthropic client: bad JSON, retries, empty output, API failures (rate limit,
  timeout, connection), blank and oversized prompts, per-user rate limiting, and hostile prompt text.
- Tests that feed hostile names and settings (template, quote, newline, YAML and Markdown tricks) into the Terraform,
  Kubernetes and ZIP generators and check the output stays valid and inert.
- Frontend ESLint, Prettier, Vitest and Testing Library with a coverage gate (80%), plus 118 unit and component tests.
- Playwright end-to-end tests (31) covering sign-in, the whole generate, edit, save and reopen journey, diagram
  editing with real mouse input, fixes, code export and project management.
- `scripts/check.py`: runs every CI check locally. `scripts/validate_generated.py`: writes sample generated
  infrastructure and checks its syntax.
- GitHub Actions workflow (backend, frontend, end-to-end, generated infrastructure with `terraform validate` and
  `kubeconform`, Docker builds), Dependabot, and an optional pre-commit configuration.
- `.dockerignore` files, `.gitattributes`, `.editorconfig`, `LICENSE`, `CONTRIBUTING.md`, and issue and pull
  request templates.

### Changed

- User text sent to Claude has any `<requirement>` tags defanged, so it cannot close the data block early.
- Undo history moved out of `App.jsx` into a small tested module (`history.js`).
- Frontend Docker image uses Node 22.

### Fixed

- Pressing Delete on a component took two undo steps (the component and its connections were removed separately).
  It is now one step. Found by the end-to-end tests.
- The Analysis panel ignored requirements that already existed when it first appeared; the Projects panel ignored
  the suggested project name on first render. Found by the component tests.
- Formatting and lint findings across the codebase, including exceptions raised inside `except` blocks now
  being chained, and a type error where a missing price could reach a multiplication.

### Known limits

- Vite 5 and Vitest 3 are used. Newer major versions conflict with the current plugin set; upgrading is a separate
  task. `npm audit` reports advisories only in these development tools (production dependencies: none).
- `terraform validate` and `kubeconform` run only in CI, not locally.

## Earlier work

### Phase 1

Saved diagram positions; editable project details and requirements; unsaved-changes warning; fix preview;
budget and redundancy fixes; scaling that ignores background workers; Kubernetes limits, autoscaler and Ingress;
project search, pages, rename, duplicate and a 30-day trash; `GET /api/catalog`; improved run scripts and startup
checks.

### Before Phase 1

AI architecture generation with demo mode; requirements extraction; connected performance, cost and
recommendation analysis; editable diagram with undo and redo; one-click fixes; accounts and saved projects;
Terraform (AWS, with security groups, cache, queue, CDN and auth) and Kubernetes generation; ZIP export.
