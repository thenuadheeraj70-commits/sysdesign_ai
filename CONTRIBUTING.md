# Contributing to SysDesign AI

Thanks for helping. This page covers how to set up, what the checks are, and how changes get merged.

## Set up

You need Python 3.12 or newer and Node 22 or newer.

```bash
# Backend
cd backend
python -m venv .venv
.venv/Scripts/activate            # macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env              # then set DEMO_MODE=true to work without an AI key

# Frontend
cd ../frontend
npm install
```

Run the app with `run.bat` (Windows) or `./run.sh`. With `DEMO_MODE=true` in `backend/.env`, generating an
architecture returns a sample design, so you do not need an API key to work on anything except the AI itself.

## The checks

One command runs everything CI runs, in the same order:

```bash
python scripts/check.py            # lint, formatting, types, tests, coverage, build, generated-code syntax
python scripts/check.py --e2e      # the same, plus the browser tests (about 90 seconds more)
python scripts/check.py --fix      # auto-fix formatting and fixable lint problems first
```

Or run the pieces yourself:

| What | Command | Where |
|---|---|---|
| Backend lint and formatting | `ruff check .` and `ruff format .` | `backend/` |
| Backend types | `mypy` | `backend/` |
| Backend tests and coverage | `pytest --cov` (fails under 90%) | `backend/` |
| Frontend lint and formatting | `npm run lint` and `npm run format` | `frontend/` |
| Frontend tests and coverage | `npm test` and `npm run coverage` (fails under 80%) | `frontend/` |
| Browser tests | `npm run e2e` | `frontend/` |

Browser tests start their own backend (demo mode, throw-away database) on port 8100 and frontend on 5273, so
they do not touch your normal data. Locally they use the Chrome you already have installed; CI uses Playwright's
Chromium.

Terraform and Kubernetes validation of the generated files (`terraform validate`, `kubeconform`) runs in CI only,
because it needs those tools installed. Locally, `scripts/validate_generated.py` checks the syntax of the same samples.

## Writing tests

- Every behaviour change needs a test. A bug fix needs a test that fails without the fix.
- Backend tests live in `backend/tests`. Use a fake AI client (see `tests/test_ai_generation.py`); tests
  never call the real API and must not need a key.
- Frontend unit and component tests sit next to the code (`*.test.js`, `*.test.jsx`) and use Vitest and Testing
  Library. The diagram canvas needs a real browser, so it is covered by the Playwright tests in `frontend/e2e`.
- Do not lower a coverage threshold to make a build pass. Add the missing tests, or raise the threshold when
  coverage improves.

## Making a change

1. Branch from `main` (`feature/short-name` or `fix/short-name`).
2. Make the change, with tests, and run `python scripts/check.py`.
3. Open a pull request using the template. Say what changed and why, and how you tested it.
4. CI must be green, and someone else must review. Merge with a squash.

Commit messages: a short summary line in the imperative ("Add region to Terraform defaults"), then a blank
line and a paragraph on the reason if it is not obvious.

### Branch protection (set this once in GitHub)

These rules live in the GitHub repository settings, not in files, so someone with admin access has to switch them
on: *Settings, Branches, Add rule* for `main`:

- Require a pull request before merging, with at least 1 approval.
- Require status checks to pass: `Backend`, `Frontend`, `End-to-end`, `Generated Terraform and Kubernetes validate`, `Docker images build`.
- Require branches to be up to date before merging.
- Do not allow force pushes or deletion.

## Common tasks

**Add a component type.** Add it to `backend/app/data/components_catalog.json` (the UI reads it from
`GET /api/catalog`), add a price entry in `backend/app/data/pricing.json`, and if it should produce Terraform,
add a template and a branch in `backend/app/services/terraform_generator.py` with a test that parses the output.

**Add a recommendation rule.** Add a `check_*` function in `backend/app/services/recommendation_engine.py`
that returns `Recommendation` objects, include a `fix` (an `ArchitecturePatch`) when a safe automatic change
exists, call it from `analyze_architecture`, and add a test in `backend/tests/test_apply_fix.py` style that applies
the fix and checks the recommendation goes away.

**Change the AI prompts.** Edit `backend/app/prompts/*.txt`. The tests use a fake client, so also try the change
against the real model by hand before merging.

## Security

Never commit `.env` files, API keys or tokens. If you find a security problem, do not open a public issue;
contact the maintainers privately.
