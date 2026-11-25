# SysDesign AI

SysDesign AI is an AI-powered system design assistant. A user describes an application in natural language and the system produces a proposed cloud architecture, a simple performance model, a transparent cost estimate, architecture recommendations, and starter Terraform/Kubernetes code.

## Features

- Natural-language architecture generation using Google Gemini or Anthropic Claude (your choice, one key is enough)
- Pydantic-validated architecture JSON
- Interactive React Flow architecture diagram
- Design variants (original, Cheap, Balanced, Highly available, dev, staging, production), compared in one table with a recommendation
- Planning tools: traffic what-if slider, growth projection, budget advisor, traffic profile and discount options
- Design toolkit (rule-based, no AI call): capacity estimate with visible formulas, REST API design with an OpenAPI skeleton, data model with ER diagram and SQL, sequence diagrams, architecture decision records, pattern suggestions, reliability (availability, RTO, RPO) against targets, multi-region planning, and "Explain this component" with glossary tips
- AI assistant: change the design from a sentence and review it as a diff before accepting, AI design review, regenerate while keeping edits, import a text/PDF/diagram image, streaming progress, retries with a fallback model, response cache, monthly token allowance, usage page, prompt history and feedback (rule-based fallbacks when no AI key is set)
- Export and share: design document (Markdown, or a printable page for PDF), diagram as SVG/PNG/Mermaid, cost table as CSV, design file (JSON) export and import, read-only share links that work without a login (with an image URL for embedding), version history with compare and restore, and download of all your projects
- Editable diagram: add components, drag to connect, edit names/types/settings and connection labels, delete, auto-layout, undo/redo
- One-click "Apply fix" on recommendations (enable multi-AZ, add a cache or load balancer, scale servers) that changes the architecture and re-runs the analysis
- Connected analysis: requirements are extracted from the prompt, and performance, cost and recommendations are derived from the architecture and recalculated automatically when it changes
- Model-based performance simulation
- Transparent monthly cost estimation using a local pricing catalog
- Rule-based architecture recommendations
- Starter Terraform (AWS: compute, load balancer, database, storage, cache, queue, CDN, auth, with security groups) and Kubernetes (Deployment with resource limits, Service, ConfigMap, autoscaler and Ingress) generation
- Infrastructure code viewer
- ZIP export endpoint
- Backend unit/API tests

## Project structure

- `backend/app/schemas` — request/response models
- `backend/app/services` — AI, analysis, cost, recommendation and infrastructure logic
- `backend/app/data` — local pricing and component catalog
- `backend/app/main.py` — FastAPI entry point
- `frontend/src` — React/Vite application

## Quick start

Windows: double-click or run `run.bat`. macOS, Linux or Git Bash: `./run.sh`. Both start the backend and the frontend, install dependencies only when they changed, and create `backend/.env` for you. No AI key yet? Put `DEMO_MODE=true` in `backend/.env` to try everything with a sample architecture.

## Run locally in VS Code

> **Recommended:** use the two-terminal method below so you can see backend and frontend errors separately. `run.bat` is also included for Windows, but it installs dependencies each time it is launched.

### 1. Backend

Open a terminal:

```powershell
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

Open `backend/.env` and add one AI key: `GEMINI_API_KEY` (Google Gemini, free keys at aistudio.google.com) or `ANTHROPIC_API_KEY` (Claude). The provider is chosen from the key you set, or force it with `AI_PROVIDER=gemini` or `anthropic`. `AI_MODEL` picks the model, and `AI_FALLBACK_MODEL` (for example `gemini-3.5-flash`; which models you can use depends on your key) is tried when the main model is overloaded.

Then:

```powershell
python -m uvicorn app.main:app --reload
```

Backend:
- http://localhost:8000
- Swagger: http://localhost:8000/docs
- Health: http://localhost:8000/health

### 2. Frontend

Open a second terminal:

```powershell
cd frontend
npm install
npm run dev
```

Open the Vite URL, normally:
http://localhost:5173

## Docker

Create `backend/.env` first, then from the project root:

```powershell
docker compose up --build
```

## Accounts and storage

Users register and log in; generating an architecture requires a login and is rate limited per user. Projects are saved per user in SQLite (`backend/storage/sysdesign.db`, or the `db-data` volume in Docker). Set `SECRET_KEY` in `backend/.env` (see `.env.example`), otherwise a random key is used and everyone is logged out on each restart.

## Development and testing

```bash
pip install -r backend/requirements-dev.txt     # test and lint tools (the run scripts do this for you)
python scripts/check.py                         # everything CI runs: lint, formatting, types, tests, coverage, build
python scripts/check.py --e2e                   # plus the browser tests
```

- Backend: `pytest` (156 tests, 90% coverage gate), `ruff` for lint and formatting, `mypy` for types.
- Frontend: `npm test` (Vitest and Testing Library, 118 tests), `npm run lint`, `npm run format`, `npm run coverage`.
- Browser tests: `npm run e2e` in `frontend/` (Playwright, 31 tests). They start their own demo-mode backend and
  frontend on ports 8100 and 5273, so they never touch your data.
- Tests never call a real AI service (they ignore any key in `backend/.env`), so no key is needed to run any of them.
- CI (`.github/workflows/ci.yml`) runs all of the above, plus `terraform validate` and `kubeconform` on generated
  sample infrastructure. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and
  [CHANGELOG.md](CHANGELOG.md) for what changed.

## Important limitations

Performance is a mathematical model, not a production benchmark. Cost values are illustrative local estimates, not live cloud quotations. Terraform and Kubernetes output is starter code and is not deployed automatically. Review generated infrastructure before using it.

## Typical demo prompt

Build an e-commerce application for 100000 users with product search, payments, order tracking, caching, secure authentication, high availability, and AWS deployment.

## API endpoints

- `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me` — accounts (bearer token)
- `GET/POST /api/projects` (search, sort, pages), `GET/PUT/PATCH/DELETE /api/projects/{id}`, `POST /api/projects/{id}/duplicate|restore`, `GET /api/projects/trash` — saved projects (per user; deleted ones stay in the trash 30 days)
- `GET /`
- `GET /health`
- `POST /api/architecture`
- `POST /api/requirements` — extract users, traffic, budget, provider from the prompt
- `POST /api/apply-fix` — apply a recommendation's fix to an architecture
- `POST /api/preview-fix` — cost, utilization, servers and issue count before and after a fix
- `POST /api/compare` — several design variants side by side, ranked by cost and resilience, with a suggestion
- `POST /api/presets` — rebuild a design as Cheap, Balanced, Highly available, dev, staging or production
- `POST /api/what-if` — utilization, servers needed and cost across traffic levels
- `POST /api/growth` — month-by-month growth projection and when each tier must scale
- `POST /api/budget-advisor` — the cheapest changes that fit a budget, safest first
- `POST /api/capacity` — traffic, bandwidth, storage, cache, database and server estimates with formulas
- `POST /api/api-design` — endpoints grouped by service, plus an OpenAPI skeleton
- `POST /api/data-model` — entities, relations, Mermaid ER diagram and SQL
- `POST /api/sequences` — request flows (read, sign-in, write, upload, search) as Mermaid and structured steps
- `POST /api/decisions` — architecture decision records (JSON and Markdown)
- `POST /api/patterns` — patterns that fit, are in place or are not needed, some with an applicable fix
- `POST /api/reliability` — estimated availability, RTO and RPO against targets, with fixes
- `POST /api/multi-region` — latency, replication and failover for several regions, and a multi-region variant
- `POST /api/explain` — plain-language explanation of one component
- `GET /api/glossary` — definitions of the terms the tools use
- `POST /api/architecture/stream` — the same as `/api/architecture`, streamed as progress lines then the result
- `POST /api/refine` — a change from a sentence: patch plus a plain-language diff
- `POST /api/regenerate` — generate again with the current design as context (keeps edits)
- `POST /api/review` — AI (or rule-based stand-in) critique of the design
- `POST /api/import-document` — requirements text from a text file, PDF or diagram image
- `GET /api/ai/usage`, `GET /api/ai/history`, `POST /api/ai/feedback` — usage against the allowance, past prompts, ratings
- `POST /api/export/document?format=markdown|html`, `POST /api/export/diagram?format=svg|mermaid`, `POST /api/export/cost-csv`, `POST /api/export/design-file` — downloads
- `POST /api/import/design` — check and clean a design file (nothing is stored)
- `GET|POST|DELETE /api/projects/{id}/share` — turn the read-only link on, off, or read its state
- `GET /api/shared/{token}`, `GET /api/shared/{token}/diagram.svg` — the public read-only design and its image (no login)
- `GET /api/projects/{id}/versions`, `GET .../versions/{vid}/compare`, `POST .../versions/{vid}/restore` — version history
- `GET /api/projects/export-all` — every project of the logged-in user as one JSON file
- `GET /api/catalog` — component types and providers
- `POST /api/analyze` — connected pipeline: architecture + requirements → performance, cost, recommendations
- `POST /api/simulate`, `POST /api/cost`, `POST /api/optimize` — standalone building blocks
- `POST /api/generate-code`
- `POST /api/generate-code/zip`

## Final implementation notes

- Keep `backend/.env` local; never commit your real `GEMINI_API_KEY` or `ANTHROPIC_API_KEY`.
- The AI response is validated against Pydantic architecture models before it reaches the frontend.
- Performance analysis is intentionally model-based; it is not a production load test.
- Cost analysis uses the project's illustrative pricing table and should be presented as an estimate.
- Terraform and Kubernetes generators create reviewable starter code only; they do not deploy infrastructure.
