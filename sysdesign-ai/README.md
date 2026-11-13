# SysDesign AI

SysDesign AI is an AI-powered system design assistant. A user describes an application in natural language and the system produces a proposed cloud architecture, a simple performance model, a transparent cost estimate, architecture recommendations, and starter Terraform/Kubernetes code.

## Features

- Natural-language architecture generation using Anthropic Claude
- Pydantic-validated architecture JSON
- Interactive React Flow architecture diagram
- Component selection/editing in the browser
- Model-based performance simulation
- Transparent monthly cost estimation using a local pricing catalog
- Rule-based architecture recommendations
- Starter Terraform and Kubernetes generation
- Infrastructure code viewer
- ZIP export endpoint
- Backend unit/API tests

## Project structure

- `backend/app/schemas` — request/response models
- `backend/app/services` — AI, analysis, cost, recommendation and infrastructure logic
- `backend/app/data` — local pricing and component catalog
- `backend/app/main.py` — FastAPI entry point
- `frontend/src` — React/Vite application

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

Open `backend/.env` and add your Anthropic API key.

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

## Important limitations

Performance is a mathematical model, not a production benchmark. Cost values are illustrative local estimates, not live cloud quotations. Terraform and Kubernetes output is starter code and is not deployed automatically. Review generated infrastructure before using it.

## Typical demo prompt

Build an e-commerce application for 100000 users with product search, payments, order tracking, caching, secure authentication, high availability, and AWS deployment.

## API endpoints

- `GET /`
- `GET /health`
- `POST /api/architecture`
- `POST /api/simulate`
- `POST /api/cost`
- `POST /api/optimize`
- `POST /api/generate-code`
- `POST /api/generate-code/zip`

## Final implementation notes

- Keep `backend/.env` local; never commit your real `ANTHROPIC_API_KEY`.
- The AI response is validated against Pydantic architecture models before it reaches the frontend.
- Performance analysis is intentionally model-based; it is not a production load test.
- Cost analysis uses the project's illustrative pricing table and should be presented as an estimate.
- Terraform and Kubernetes generators create reviewable starter code only; they do not deploy infrastructure.
