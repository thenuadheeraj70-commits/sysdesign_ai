"""Run every quality check the CI runs, in the same order, so a build never fails on something you could
have caught locally.

    python scripts/check.py            lint, formatting, types, tests, coverage, build, generated code
    python scripts/check.py --e2e      the same, plus the browser tests (slower)
    python scripts/check.py --fix      first auto-fix formatting and fixable lint problems

Uses the backend's virtual environment when it exists (backend/.venv), otherwise the current Python.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
NPM = shutil.which("npm") or "npm"

VENV_PYTHON = next(
    (p for p in (BACKEND / ".venv" / "Scripts" / "python.exe", BACKEND / ".venv" / "bin" / "python") if p.exists()),
    None,
)
PYTHON = str(VENV_PYTHON or sys.executable)


def run(label: str, command: list[str], cwd: Path) -> bool:
    print(f"\n=== {label}", flush=True)
    started = time.time()
    result = subprocess.run(command, cwd=cwd)
    seconds = time.time() - started
    status = "ok" if result.returncode == 0 else "FAILED"
    print(f"--- {label}: {status} ({seconds:.0f}s)", flush=True)
    return result.returncode == 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--e2e", action="store_true", help="also run the Playwright browser tests")
    parser.add_argument("--fix", action="store_true", help="auto-fix formatting and fixable lint problems first")
    args = parser.parse_args()

    cfg = ["--config", "pyproject.toml"]
    if args.fix:
        subprocess.run([PYTHON, "-m", "ruff", "format", ".", "../scripts", *cfg], cwd=BACKEND)
        subprocess.run([PYTHON, "-m", "ruff", "check", "--fix", ".", "../scripts", *cfg], cwd=BACKEND)
        subprocess.run([NPM, "run", "format"], cwd=FRONTEND)
        subprocess.run([NPM, "run", "lint:fix"], cwd=FRONTEND)

    generated = Path(tempfile.mkdtemp(prefix="sysdesign-generated-"))
    steps: list[tuple[str, list[str], Path]] = [
        ("backend: lint", [PYTHON, "-m", "ruff", "check", ".", "../scripts", *cfg], BACKEND),
        ("backend: formatting", [PYTHON, "-m", "ruff", "format", "--check", ".", "../scripts", *cfg], BACKEND),
        ("backend: types", [PYTHON, "-m", "mypy"], BACKEND),
        ("backend: tests and coverage", [PYTHON, "-m", "pytest", "-q", "--cov", "--cov-report=term"], BACKEND),
        ("frontend: lint", [NPM, "run", "lint"], FRONTEND),
        ("frontend: formatting", [NPM, "run", "format:check"], FRONTEND),
        ("frontend: tests and coverage", [NPM, "run", "coverage"], FRONTEND),
        (
            "frontend: production build",
            [NPM, "exec", "--", "vite", "build", "--outDir", str(Path(tempfile.gettempdir()) / "sysdesign-build")],
            FRONTEND,
        ),
        ("generated code: syntax", [PYTHON, str(ROOT / "scripts" / "validate_generated.py"), str(generated)], ROOT),
    ]
    if args.e2e:
        env_note = "uses your installed Chrome, or set CI=1 to use Playwright's Chromium"
        steps.append((f"end-to-end browser tests ({env_note})", [NPM, "run", "e2e"], FRONTEND))

    failed = [label for label, command, cwd in steps if not run(label, command, cwd)]

    print("\n" + "=" * 60)
    if failed:
        print("FAILED:\n  " + "\n  ".join(failed))
        return 1
    print(f"All {len(steps)} checks passed.")
    if not args.e2e:
        print("(Browser tests were skipped: add --e2e to include them.)")
    print("Not run here: terraform validate and kubeconform on the generated files (CI does that).")
    return 0


if __name__ == "__main__":
    os.chdir(ROOT)
    sys.exit(main())
