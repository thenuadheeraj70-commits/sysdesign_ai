@echo off
setlocal
echo Starting SysDesign AI...
echo.
echo Backend: http://localhost:8000
echo Frontend: http://localhost:5173
echo.
start "SysDesign AI Backend" cmd /k "cd /d %~dp0backend && if not exist .venv\Scripts\python.exe python -m venv .venv && call .venv\Scripts\activate && pip install -r requirements.txt && if not exist .env copy .env.example .env && python -m uvicorn app.main:app --reload"
start "SysDesign AI Frontend" cmd /k "cd /d %~dp0frontend && npm install && npm run dev"
endlocal
