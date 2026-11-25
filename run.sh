#!/usr/bin/env bash
# Starts the backend and the frontend (macOS / Linux / Git Bash). Press Ctrl+C to stop both.
# Dependencies are installed only the first time, and again when requirements*.txt or
# package-lock.json change.
#
#   ./run.sh            start both
#   ./run.sh backend    start only the backend
#   ./run.sh frontend   start only the frontend
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

backend() {
  cd "$ROOT/backend"
  if [ ! -x .venv/bin/python ] && [ ! -x .venv/Scripts/python.exe ]; then
    echo "Creating the Python environment..."
    python3 -m venv .venv 2>/dev/null || python -m venv .venv
  fi
  # shellcheck disable=SC1091
  source .venv/bin/activate 2>/dev/null || source .venv/Scripts/activate
  if ! cmp -s requirements.txt .venv/installed-requirements.txt \
     || ! cmp -s requirements-dev.txt .venv/installed-requirements-dev.txt; then
    echo "Installing backend dependencies..."
    pip install -r requirements-dev.txt
    cp requirements.txt .venv/installed-requirements.txt
    cp requirements-dev.txt .venv/installed-requirements-dev.txt
  fi
  if [ ! -f .env ]; then
    cp .env.example .env
    echo "Created backend/.env from the example. Add your GEMINI_API_KEY (or ANTHROPIC_API_KEY) there, or set DEMO_MODE=true."
  fi
  exec python -m uvicorn app.main:app --reload
}

frontend() {
  cd "$ROOT/frontend"
  if ! cmp -s package-lock.json node_modules/.installed-lock.json; then
    echo "Installing frontend dependencies..."
    npm install
    cp package-lock.json node_modules/.installed-lock.json
  fi
  exec npm run dev
}

case "${1:-both}" in
  backend)  backend ;;
  frontend) frontend ;;
  both)
    echo "Backend:  http://localhost:8000   (API docs: /docs)"
    echo "Frontend: http://localhost:5173"
    echo "No AI key yet? Put DEMO_MODE=true in backend/.env to try the app with sample data."
    trap 'kill 0' INT TERM EXIT
    "$0" backend &
    "$0" frontend &
    wait
    ;;
  *) echo "Usage: $0 [backend|frontend]"; exit 1 ;;
esac
