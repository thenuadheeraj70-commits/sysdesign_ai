# SysDesign AI: Remaining Features

This file lists everything that is **not built yet**, split into phases. Each phase is small enough to finish on its own, builds on the one before it, and ends with a working app. Do the phases in order unless a note says otherwise.

**Revision 2** added: a loose-ends list found by re-checking the code (Phase 1), a new engineering foundation phase (Phase 2: git, CI, linting, end-to-end tests), a new system design toolkit phase (Phase 4: capacity estimation, API design, data model, sequence diagrams, decision records), and many smaller items inside the existing phases (marked **new**).

## Where the project stands today (done)

| Area | Status |
|---|---|
| Natural-language architecture generation (Claude) + keyless `DEMO_MODE` | Done |
| Requirements extraction from the prompt | Done |
| Connected analysis: performance, cost, recommendations derived from the architecture, auto-recalculated | Done |
| Editable diagram: add, connect, edit settings, delete, auto-layout, undo/redo | Done |
| One-click "Apply fix" on recommendations | Done |
| Accounts (register/login), per-user saved projects (SQLite), per-user AI rate limit | Done |
| Terraform (AWS): compute, load balancer, database, storage, cache, queue, CDN, auth, security groups | Done |
| Kubernetes: Deployment, Service, ConfigMap for compute components | Done |
| ZIP export | Done |
| Phase 1: saved diagram positions, editable details and requirements, unsaved-changes warning, fix preview, budget and redundancy fixes, web-facing scaling, Kubernetes ingress/autoscaling/limits, project search/pages/rename/duplicate/trash, catalog endpoint, run scripts, startup checks | Done |
| Phase 2: git, CI, ruff/mypy/ESLint/Prettier, Vitest, Playwright, coverage gates, pre-commit, Dependabot, hygiene files | Done |
| Phase 3: variants, comparison, presets, what-if, growth, budget advisor, traffic profile, discounts (built and tested) | Built |
| Phase 5: smarter AI (refine, review, import, resilience, usage, feedback; built and tested with a fake AI service; never run against a real AI key) | Built |
| Phase 4: design toolkit (capacity, API, data model, sequences, ADRs, patterns, reliability, multi-region, explain; built and tested) | Built |
| Tests (after Phase 6) | 319 backend (92% coverage), 277 frontend (91%), 51 browser |

## How to read each phase

- **Goal**: what the user gets.
- **Tasks**: checklist, in a sensible order. **new** = added in revision 2.
- **Touches**: main files or areas involved.
- **Done when**: how to tell it works.
- **Size**: S (a few hours), M (about a day), L (several days).

---

## Phase 1: Quick wins and loose ends (Size: M) - DONE

**Goal:** close known gaps in what already exists, with low risk.

### Gaps in current features
- [x] **Save diagram positions with a project.** Dragged positions are lost on reopen.
  - Store `positions` (`{id: {x, y}}`) with the architecture in the project record; send and restore them.
  - Touches: `schemas/projects.py`, `routes/projects.py`, `Projects.jsx`, `ArchitectureDiagram.jsx`.
- [x] **Edit project name, description and assumptions (new).** Today they are read-only in the UI; add inline editing, plus add and remove assumptions. Touches: `App.jsx` (`Results`).
- [x] **Edit every extracted requirement (new).** Only peak requests and budget are editable. Add editable users, availability target, cloud provider, region and a notes list. Editing users should recompute peak traffic. Touches: `Analysis.jsx`, `schemas/models.py` (`Requirements`).
- [x] **Unsaved-changes warning.** Show a marker when the design differs from the saved project; warn before leaving or opening another project.
- [x] **Fix preview before applying.** Show before and after cost and utilization next to the Apply fix button (call `/api/analyze` on the patched copy).
- [x] **Fixes for the remaining recommendation types.** Add patches for over-budget (smaller counts, drop optional components) and for single points of failure on non-compute components.
- [x] **Scale fix only touches web-facing servers.** It also scales background workers today. Use a role hint (for example, only components reached from a load balancer).
- [x] **Price the unpriced types (new).** `network` and `security` components are skipped by the cost estimate; add price entries or an explicit "free or not modelled" line.
- [x] **Kubernetes Ingress, autoscaling and limits.** Generate an `Ingress`, a `HorizontalPodAutoscaler`, and CPU and memory requests and limits per workload. Touches: `kubernetes_generator.py`, `zip_export.py`, tests.

### Project management (new)
- [x] **Rename, duplicate and search projects.** Add a rename action, a "Duplicate" button, a search box and sorting.
- [x] **Pagination for the project list.** `GET /api/projects` returns everything today.
- [x] **Confirmation and "undo delete".** Soft-delete projects for 30 days.

### Code cleanup (new)
- [x] **Single source for component types and providers.** The frontend hardcodes `COMPONENT_TYPES` and `PROVIDERS` in `layout.js` while the backend has `components_catalog.json`. Add `GET /api/catalog` and have the frontend load it.
- [x] **Remove or use dead code.** Done: removed `services/diagram_builder.py` (and its test), `app/templates/`, and the empty `app/utils/` package.
- [x] **Decide on the legacy endpoints.** `/api/simulate`, `/api/cost`, `/api/optimize` are not used by the UI. Keep them as documented public building blocks (and test them), or remove them.
- [x] **Better `run.bat`.** It reinstalls dependencies on every launch; make it install only when needed. Add a `run.sh` for macOS and Linux.
- [x] **Startup checks.** Print a clear message when `ANTHROPIC_API_KEY` is missing and `DEMO_MODE` is off.

**Done when:** a saved project reopens exactly as left, every requirement field is editable, and Kubernetes output includes ingress and autoscaling.

**Completed notes:** the over-budget fix lowers instance counts (and says it can raise utilization); the scale fix and the server count now ignore background workers; `region` is stored with the requirements and becomes the Terraform default; the legacy endpoints `/api/simulate`, `/api/cost` and `/api/optimize` are kept as documented building blocks and are tested; `GET /api/catalog` replaced the duplicated type lists; trash purge runs when a user lists projects or the trash.

---

## Phase 2: Engineering foundation (new, Size: M) - DONE

**Goal:** make the project safe to change. None of this exists yet: the folder is not a git repository, there is no CI, linting or frontend test setup.

- [x] **Initialise git.** Add `.gitignore` check (storage, `.env`, `dist`), first commit, branch rules.
- [x] **Continuous integration.** GitHub Actions workflow: install, backend tests, frontend build, lint, on every push and pull request.
- [x] **Backend lint, format and types.** `ruff` (lint and format), `mypy` on `app/`; add to `requirements-dev.txt` and CI.
- [x] **Frontend lint and format.** ESLint (React rules) and Prettier; add scripts to `package.json`.
- [x] **Frontend unit and component tests.** Vitest and React Testing Library: undo/redo history, add/connect/delete, apply fix, login flow, analysis auto-refresh.
- [x] **End-to-end tests.** Playwright against `DEMO_MODE`: register, generate, edit, apply fix, save, reopen, download ZIP. Run in CI.
- [x] **AI tests with a mock.** Fixture responses for the Anthropic client covering bad JSON, retry, timeout, rate limit, and prompt-injection text.
- [x] **Generated-infrastructure validation in CI.** Run `terraform fmt`/`validate` and a Kubernetes schema check (kubeconform) over the demo design and test variants; add `python-hcl2` to `requirements-dev.txt` for a fast syntax test without Terraform installed.
- [x] **Coverage report.** Fail CI under an agreed threshold (for example 80% backend).
- [x] **Pre-commit hooks and dependency updates.** `pre-commit` config; Dependabot or Renovate.
- [x] **Project hygiene files.** `LICENSE`, `CONTRIBUTING.md`, `CHANGELOG.md`, issue and pull request templates.

**Done when:** every pull request runs tests, lint and an end-to-end flow automatically, and a red build blocks merging.

**Completed notes:**
- Git is initialised on `main` with no commits and no remote, by request. Nothing has been committed or pushed.
- Branch protection (a red build blocking merges) is a GitHub setting and cannot be stored in files; the exact rules are listed in `CONTRIBUTING.md` for an admin to switch on after the repository is on GitHub.
- `terraform validate` and `kubeconform` run in CI only (they are not installed locally). `terraform fmt -check` is informational there, because generated spacing may not match the canonical style.
- Vite 5 and Vitest 3 are used because newer majors conflict with the current plugins. `npm audit` reports advisories in these dev tools only (production dependencies: none). A tooling upgrade is a good small task for later.
- The default licence is MIT with the holder "SysDesign AI contributors". Change `LICENSE` if you want another licence or name.
- The pre-commit configuration is written but was not run here (it downloads its hooks from GitHub).
- Backend coverage is about 94% (gate 90%). Frontend coverage is about 88% (gate 80%); the diagram canvas is covered by the browser tests instead.
- The new tests found and fixed three real bugs: deleting a component took two undo steps; the Analysis panel ignored requirements present on first render; the Projects panel ignored the suggested name on first render.

---

## Phase 3: Compare designs and what-if tools (Size: M) - BUILT and TESTED

**Goal:** make the numbers useful for choosing between options.

- [x] **Design variants.** Duplicate the current design into "Variant A/B/C", edit each independently, switch between them.
  - Data: a project holds a list of variants. Touches: DB schema (`variants` table or JSON column), `Projects.jsx`, `App.jsx` state.
- [x] **Comparison table.** Side by side: total cost, utilization, server count, single points of failure, component count, recommendations by severity.
- [x] **Preset generator.** Buttons to create "Cheap", "Balanced", "Highly available" variants (rules: minimum instances, multi-AZ, cache and load balancer present).
- [x] **Scaling what-if slider.** Slider for users or requests per second; cost, utilization and bottleneck update live, with a marker for "capacity runs out at N req/s".
- [x] **Growth projection (new).** Project cost and capacity over 12 or 24 months from a monthly growth rate; show when each tier needs to scale.
- [x] **Traffic profile (new).** Model peak vs average, daily spikes, and read/write ratio instead of one peak number.
- [x] **Environment presets.** Dev, staging, production profiles that scale instance counts and sizes, with a cost row for each.
- [x] **Budget advisor.** "Fit this design into $X": suggests the cheapest changes that get under budget.
- [x] **Discount options (new).** Reserved, savings plan and spot assumptions as optional percentages on cost lines.

**Done when:** a user can create three variants and see one table that ranks them by cost and resilience.

**Status:** built and tested (backend, frontend and browser tests). Everything passes lint, formatting, type checks and the production build.

**Completed notes:**
- Variants live in the project (up to 6, each with its own undo history, diagram positions and traffic share). Older saved projects open as one "Original" variant.
- Presets are rule-based (`backend/app/services/scenarios.py`): Cheap (sized for ~85% utilization), Balanced (~65%, multi-zone database, load balancer), Highly available (~50%, redundancy everywhere), plus Development (2% of traffic), Staging (25%) and Production. Environment presets are variants with a smaller traffic share, so the comparison table doubles as the cost row for each environment.
- The what-if slider covers 0.1x to 10x of today's peak. The model numbers come from the backend once; the slider applies the same formulas locally.
- Database and cache capacities in the growth tool are round planning numbers (1,000 and 20,000 req/s per instance), stated in the UI.
- The budget advisor works safest-first (right-size web servers, trim workers and caches, tighten the web tier, drop optional services, last resort). Each step carries a cumulative patch, so "Apply steps 1 to N" is one click. Patches can now remove components.
- Traffic profile and discounts are saved with the requirements and used by every analysis and planning tool.

**Still to do for this phase:** an accessibility pass on the new tables and charts.

---

## Phase 4: System design toolkit (new, Size: L) - BUILT and TESTED

**Goal:** cover the parts of system design that a component diagram alone does not answer. Each tool reads the same architecture and requirements. (Built as rule-based tools; Claude-written versions remain an option.)

- [x] **Capacity estimation calculator.** Back-of-envelope numbers from users and usage: requests per second, read/write split, storage growth per year, bandwidth, cache memory needed, number of database shards. Show every formula and editable assumption.
- [x] **API design.** Draft a list of endpoints (method, path, purpose, auth) per service, and export an OpenAPI skeleton.
- [x] **Data model.** Draft main entities, fields and relations, shown as an ER diagram, with a note on which store each entity belongs in; export SQL DDL for relational databases.
- [x] **Sequence diagrams.** Pick a flow ("place an order") and generate a sequence diagram across the components; render as Mermaid.
- [x] **Architecture decision records (ADRs).** For each key choice (database type, cache, queue) record the reason, the alternatives and trade-offs; export as Markdown.
- [x] **Pattern suggestions.** Detect and suggest patterns: CQRS, event-driven, saga, circuit breaker, CDN offload, read replicas, with a plain-language "when to use".
- [x] **Reliability targets.** Inputs for availability, RTO and RPO; check the design against them and suggest backups, multi-AZ or multi-region.
- [x] **Explain and learn mode.** Click a component for a plain-language explanation, alternatives and a glossary tooltip; useful for students and interview practice.
- [x] **Multi-region design.** Region selection per component, replication links, and failover notes; latency estimates between regions.

**Done when:** from one prompt a user gets a capacity table, an API list, a data model and one sequence diagram that all match the architecture.

**Status:** built and tested (backend, frontend and browser tests, with a fake AI service; never run against a real AI key).

**Completed notes:**
- Code: `backend/app/services/toolkit/` (one module per tool), `backend/app/api/routes/toolkit.py`, `frontend/src/components/toolkit/`.
- The application type (e-commerce, social, messaging, video, IoT, booking, generic) is guessed from the prompt and component names and picks the API and data-model templates; the guess is shown on screen.
- Latency between regions is estimated from distance (round trip = 2 x distance x 1.5 / 200 km per ms + 3 ms), and availability from a simple series/parallel model. Both list their assumptions.
- Reliability targets and capacity assumptions are saved with the requirements. Pattern and reliability fixes use the existing apply-fix path; the multi-region result is added as a variant.
- Sequence diagrams use a small custom SVG renderer (no new dependency); Mermaid text is offered for export.

**Still to do for this phase:** a hands-on review of the layout and keyboard use, and a review of the generated text for each application type. The glossary tips have no touch-device alternative.

---

## Phase 5: Smarter AI (Size: M to L) - BUILT and TESTED

**Goal:** use Claude for iteration and richer inputs, not just first-draft generation.

- [x] **Chat refinement.** A box under the diagram ("make it multi-region", "add search"). Claude returns an `ArchitecturePatch`; show it as a diff (added, removed, changed) the user accepts or rejects. Reuses the patch and undo system.
  - Touches: new `POST /api/refine`, new prompt file, `services/refine.py`, diff UI.
- [x] **Regenerate while keeping edits (new).** Re-run generation with the existing design as context, so manual edits are preserved.
- [x] **Richer inputs (new).** Upload a requirements document (PDF or text) or a hand-drawn diagram image and turn it into an architecture (image input to Claude).
- [x] **AI design reviewer.** A second Claude pass that critiques the design (risks, missing pieces, trade-offs) and returns findings in the same format as rule-based recommendations, labelled "AI".
- [x] **Structured output and retries.** Use tool use or JSON schema output instead of free-text parsing; keep the retry-with-error loop as a fallback.
- [x] **Resilience to API problems (new).** Retry with backoff on rate-limit and overload errors, a circuit breaker, clear user messages, and a fallback model setting.
- [x] **Response caching.** Cache generation by prompt hash for a short time; show "cached" in the UI.
- [x] **Streaming.** Stream progress so long calls feel responsive.
- [x] **Usage guard and visibility (new).** Per-user monthly AI quota in the database, token counts per generation, and a usage page.
- [x] **Model settings (new).** Let an admin choose the model per task (generation, extraction, review) from config.
- [x] **Prompt history and feedback (new).** Keep past prompts per project; thumbs up/down on each generation and a short comment, stored for improving prompts.
- [x] **AI evaluation set.** 10 to 20 fixed prompts with checks (valid JSON, 6 to 15 components, no orphan components); run when changing prompts or models.
- [x] **Prompt-injection hardening (new).** Tests with hostile prompts; strip control text from component names before they reach generated Terraform and Markdown.

**Status:** built and tested (backend, frontend and browser) with a fake AI service. Nothing has been run against a real AI key. Lint, format, type checks and the production build pass.

**Completed notes:**
- Code: `services/ai_core.py` (retries, fallback model, breaker, cache, usage), `ai_generator.py` (tool-use structured output), `ai_assist.py` (refine, review, documents), `ai_usage.py`, `sanitize.py`, routes in `api/routes/ai.py` and `design.py`, UI in `frontend/src/components/ai/`.
- Without an API key (demo mode) refine uses keyword rules (search, cache, CDN, queue, auth, monitoring, load balancer, multi-region, highly available, scale) and review uses the pattern and reliability checks; both say so on screen. PDFs and images need a key.
- Streaming shows characters written, not partial designs. Streaming calls skip the cache and structured tool output.
- The model-per-task setting is read from environment variables, not an admin screen (there is no admin role yet).
- Evaluation: `python backend/evals/run_evals.py` (needs a key; not run).

**Still to do for this phase:** a run of the evaluation set against a real AI key, and prompt tuning from its results.

**Done when:** typing "add a search service backed by a search cluster" produces a reviewable diff that can be applied, discarded or undone.

---

## Phase 6: Export and sharing (Size: M) - BUILT and TESTED

**Goal:** let people take the result out of the app.

- [x] **Design document export.** One click to Markdown and PDF: diagram image, assumptions, requirements, cost table, performance summary, recommendations, risks, plus the Phase 4 outputs when present.
- [x] **Diagram export.** Download as PNG and SVG; copy as Mermaid text. **new:** print-friendly stylesheet.
- [x] **Architecture import and export as JSON.** Download and upload a design (validated by `ArchitectureResult`).
- [x] **Cost export (new).** Download the cost table as CSV.
- [x] **Read-only share link.** A project can be shared by an unguessable link; visitors see the diagram and analysis without logging in. Include revoke.
  - Touches: `projects` table (`share_token`), public `GET /api/shared/{token}`, a read-only page.
- [x] **Version history.** Save a snapshot on every explicit save; list, compare and restore. Pairs with variants from Phase 3.
- [ ] **Code viewer improvements.** Syntax highlighting, per-file download, and a diff against the previous generation.
- [x] **Embeddable diagram (new).** An iframe or image URL for use in docs and wikis.
- [x] **Your data (new).** "Download all my projects" (JSON) for data portability.

**Done when:** a user can send a teammate a link to a read-only design and download a PDF of it.

**Status:** done except the code viewer item. Tested end to end, including opening the link in a separate logged-out browser, downloading and opening every file type, a design-file round trip, and restoring a version.

**Completed notes:**
- Code: `services/export_doc.py`, `services/diagram_svg.py`, `services/versions.py`, `api/routes/sharing.py`; UI in `frontend/src/components/export/`.
- "PDF" is the printable HTML page saved with the browser's Print command: there is no server-side PDF library. The page has a print stylesheet.
- Share links are public on purpose: 24 random bytes, revocable, rate-limited per address, not cached, and marked noindex. The shared page shows the last saved version.
- Versions are a full snapshot per save (30 kept); the project's variants and open variant are included.

**Not done:** the **Code viewer improvements** item (syntax highlighting, per-file download, diff against the previous generation).

---

## Phase 7: Better generators and more clouds (Size: L)

**Goal:** make the generated infrastructure closer to deployable and not AWS-only.

- [ ] **More AWS resources.** API Gateway, Lambda (serverless), OpenSearch (search), CloudWatch (monitoring), WAF (security), VPC and subnets (network).
- [ ] **Real networking.** Generate a VPC, public and private subnets and a database subnet group so users do not supply `vpc_id` and subnet lists by hand.
- [ ] **HTTPS.** ACM certificate, HTTPS listener and HTTP-to-HTTPS redirect on the load balancer.
- [ ] **Scaling groups (new).** Use Auto Scaling groups with a launch template and target-tracking policies instead of a fixed instance `count`.
- [ ] **Safer database setup (new).** Password from AWS Secrets Manager (generated, never a plain variable), automated backups with retention, final snapshot on by default for production, optional read replicas.
- [ ] **IAM (new).** Least-privilege roles and instance profiles for compute reaching storage, queues and secrets.
- [ ] **Terraform project layout.** Split output into modules or per-component files; add `terraform.tfvars.example`.
- [ ] **Remote state and environments (new).** S3 backend with locking, workspaces or per-environment folders.
- [ ] **Monitoring as code (new).** CloudWatch alarms and a dashboard for the generated resources; optional Prometheus and Grafana for Kubernetes.
- [ ] **Policy checks (new).** Run `checkov` or `tfsec` on generated Terraform and show the findings in the UI.
- [ ] **Helm chart or Kustomize (new).** Package the Kubernetes output with values per environment; add Namespace, Secret references, PersistentVolumeClaim and a Kubernetes cluster (EKS) option for container architectures.
- [ ] **GCP and Azure.** Pricing entries and a Terraform generator per provider (start with GCP: Compute Engine, Cloud SQL, Cloud Storage, Memorystore, Pub/Sub, Cloud CDN, Identity Platform).
- [ ] **Provider-aware cost.** Price table keyed by provider, region and size, with a "prices as of" date and per-line override. **new:** refresh prices from the provider price lists on a schedule.
- [ ] **Docker Compose output.** Generate a `docker-compose.yml` for local development from the same architecture.
- [ ] **CI/CD starter.** Optional GitHub Actions workflow in the ZIP that runs validate and plan.
- [ ] **Load test script (new).** Generate a k6 script from the traffic profile so the model's numbers can be checked against a real system.

**Done when:** `terraform validate` passes in CI for every generated sample, and a GCP design produces a plausible Terraform output.

---

## Phase 8: Analysis depth (Size: M to L)

**Goal:** more realistic and more useful analysis.

- [ ] **Per-tier performance model.** Capacity per tier (load balancer, app, cache, database), cache hit rate, and a p95 latency estimate from queueing math, instead of only servers times capacity.
- [ ] **Failure simulation.** "What if the database or one zone goes down?": highlight affected components and estimate impact.
- [ ] **Security review.** Separate checks for exposed databases, missing encryption, no WAF, open security groups, missing auth; severity and fixes in the same format.
- [ ] **Compliance hints.** Optional profiles ("handles payments", "personal data") that add recommendations such as audit logging and encryption.
- [ ] **Reliability estimate.** Availability from component redundancy (series and parallel math), compared with the target from Phase 4.
- [ ] **Cost breakdown extras.** Data transfer, backup and support-plan lines as explicit, editable assumptions.
- [ ] **Dependency and cycle checks.** Warn about orphan components, cycles, and a database directly reachable from the client side.
- [ ] **Cost anomaly view (new).** Flag any single component taking more than a set share of the total.
- [ ] **Carbon estimate (new, optional).** Rough energy and carbon figures per region.
- [ ] **Organisation rules (new).** Guardrails a team can define (allowed providers and component types, naming and tagging rules, maximum cost) that fail a design when broken.

**Done when:** the analysis shows a per-tier bottleneck and an availability percentage with its calculation.

---

## Phase 9: Security, accounts and production readiness (Size: L)

**Goal:** be safe to run for real users.

- [ ] **Move the token out of `localStorage`.** Use an httpOnly, SameSite cookie with CSRF protection.
- [ ] **Account basics.** Password reset by email, email verification, change password, delete account (and its projects), "log out everywhere" (token versioning). **new:** needs an email provider (SMTP or a transactional service) and templates.
- [ ] **Roles and quotas.** Admin view of users and usage; configurable limits per user.
- [ ] **Stronger rate limiting.** Shared store (Redis) so limits hold across several workers; per-IP and per-user. **new:** also limit `/api/analyze` and `/api/apply-fix`, which are open today.
- [ ] **Audit log (new).** Record sign-ins, saves, deletes and sharing changes.
- [ ] **Database upgrade path.** Alembic migrations; Postgres for multi-instance deployments; backups and restore tested. **new:** back up `storage/.secret_key` alongside the database, since losing it logs everyone out.
- [ ] **Background jobs (new).** Move slow work (AI calls, PDF export) to a worker queue so requests do not block; add job status polling.
- [ ] **Async backend (new).** Use async clients for AI calls and database access if traffic grows.
- [ ] **Logging and monitoring.** Structured logs with request IDs, an error tracker, health and readiness endpoints, metrics (request counts, AI latency, AI failures, token use).
- [ ] **Security headers and hardening.** CSP, HSTS, request size limits, stricter CORS in production, dependency scanning.
- [ ] **Production deployment.** Frontend as a static build behind a reverse proxy (not the Vite dev server); healthchecks in compose; a deployment guide; TLS.
- [ ] **Secrets management.** Document how to supply `ANTHROPIC_API_KEY` and `SECRET_KEY` safely; fail fast on weak or missing production secrets.
- [ ] **Legal and privacy (new).** Privacy policy, terms of use, cookie notice, and a data-retention policy; "export my data" and "delete my data" as in Phase 6 and above.
- [ ] **Feature flags (new).** Simple on/off switches in config for risky features.
- [ ] **Load testing the app itself (new).** A k6 or Locust run against the backend to find limits.

**Done when:** a production deploy has HTTPS, cookie auth, migrations and monitoring, and survives a restart without logging everyone out.

---

## Phase 10: Frontend quality and polish (Size: M)

**Goal:** a smoother, more accessible interface.

- [ ] **Step-based layout.** Replace the single long page with a flow or tabs: Requirements, Architecture, Analysis, Code, Projects.
- [ ] **TypeScript.** Migrate gradually; generate API types from FastAPI's OpenAPI schema.
- [ ] **Loading and error states.** Skeletons, retry buttons, offline notice. **new:** a global error boundary so one bad component does not blank the page.
- [ ] **Accessibility pass.** Keyboard-only diagram editing (add, connect, delete without a mouse), focus management for panels, screen reader labels, colour-contrast check; run an automated check (axe) in CI.
- [ ] **Responsive layout.** Proper phone and tablet layouts for the diagram and panels.
- [ ] **Dark mode** and a theme toggle.
- [ ] **Onboarding.** Example prompts, a short guided tour, and empty states that explain each section. **new:** a sample project loaded in one click.
- [ ] **Diagram upgrades.** Group components (for example VPC or "Data tier"), custom icons per type, minimap toggle, snap-to-grid, multi-select and copy/paste. **new:** connection direction, protocol and port on edges, and a legend for providers and types.
- [ ] **Keyboard shortcuts.** Undo and redo (Ctrl+Z, Ctrl+Shift+Z), save (Ctrl+S), delete, add; show a shortcut help panel.
- [ ] **Persist undo history (new).** Keep the history across a refresh for unsaved work (local storage draft).
- [ ] **Settings page (new).** Defaults for cloud provider, region, currency and theme; model choice if allowed.
- [ ] **Internationalisation (optional).** Extract UI strings for translation; currency and number formats.
- [ ] **Installable app (new, optional).** PWA manifest and offline shell for viewing saved projects.

**Done when:** the whole app can be used with a keyboard only, works on a phone, and passes an automated accessibility check.

---

## Phase 11: Collaboration, integrations and business (Size: L, optional)

**Goal:** team use, connections to other tools, and running it as a service.

- [ ] **Teams and shared projects.** Invite users to a project with viewer and editor roles.
- [ ] **Comments.** Comment threads on components.
- [ ] **Live collaboration.** Multi-user editing with presence (WebSockets, last-write-wins first, then CRDT if needed).
- [ ] **Import existing infrastructure.** Read a Terraform state or `.tf` files and draw them as an architecture.
- [ ] **Personal API keys and webhooks.** Generate architectures from scripts or CI; webhook on project change.
- [ ] **Integrations.** Export to Notion, Confluence or Slack; open a GitHub pull request with the generated code.
- [ ] **Templates gallery.** Curated starting architectures (e-commerce, video streaming, IoT, SaaS) users can fork; **new:** user-submitted templates with review.
- [ ] **Custom component library (new).** Let a team define its own approved components with defaults and prices.
- [ ] **Plans and billing (new).** Free and paid tiers with AI quotas and project limits, payments through a payment provider, invoices.
- [ ] **Product analytics (new).** Privacy-friendly usage metrics (which features are used, where users drop off), with an opt-out.
- [ ] **In-app help and support (new).** Documentation site, FAQ, in-app feedback form.

---

## Documentation (new, do alongside any phase)

- [ ] **User guide** with screenshots for each feature, and a short demo video.
- [ ] **API reference**: improve the OpenAPI descriptions and examples; add an API versioning plan (`/api/v1`).
- [ ] **Architecture guide for contributors**: how the pipeline, patch system, generators and recommendation rules fit together, and how to add a new component type or a new recommendation rule step by step.
- [ ] **Troubleshooting page**: common setup errors (missing key, port in use, Windows script policy).

## Cross-cutting tasks (do alongside any phase)

- Keep `README.md`, `.env.example` and the API endpoint list up to date with every feature.
- Add or extend backend tests with each backend change, and frontend tests from Phase 2 onwards.
- Keep the "limitations" language honest: performance is a model, cost is an estimate, generated code is a starting point.
- Review every new endpoint for authentication, input size limits and rate limits.
- Update this file when a task is finished: tick the box and move finished items into the "done" table.

## Suggested order

1. **Phase 1** first: small, and it removes the rough edges users hit now.
2. **Phase 2** right after: tests, CI and git make every later phase safer.
3. **Phase 3** and **Phase 4**: give the analysis decision value and cover the system design topics the app is named for.
4. **Phase 5**: the biggest improvement to how the AI is used.
5. **Phase 6** and **Phase 7** in either order, depending on whether sharing or deployable output matters more.
6. **Phase 8** to deepen the analysis, **Phase 9** before real users, **Phase 10** for polish, **Phase 11** only if team use or a paid service is wanted.
