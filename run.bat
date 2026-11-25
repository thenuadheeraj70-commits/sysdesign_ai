@echo off
rem Starts the backend and the frontend, each in its own window.
rem Dependencies are installed only the first time, and again when requirements.txt,
rem requirements-dev.txt or package-lock.json change.
rem
rem   run.bat            start both
rem   run.bat backend    start only the backend (used by the line above)
rem   run.bat frontend   start only the frontend
setlocal

if /i "%~1"=="backend" goto backend
if /i "%~1"=="frontend" goto frontend

echo Starting SysDesign AI...
echo.
echo Backend:  http://localhost:8000   (API docs: http://localhost:8000/docs)
echo Frontend: http://localhost:5173
echo.
echo No AI key yet? Put DEMO_MODE=true in backend\.env to try the app with sample data.
start "SysDesign AI Backend" cmd /k ""%~f0" backend"
start "SysDesign AI Frontend" cmd /k ""%~f0" frontend"
goto :eof

:backend
cd /d "%~dp0backend" || exit /b 1
if not exist .venv\Scripts\python.exe (
  echo Creating the Python environment...
  python -m venv .venv || goto :fail
)
call .venv\Scripts\activate
set NEED=0
fc /b requirements.txt .venv\installed-requirements.txt >nul 2>&1 || set NEED=1
fc /b requirements-dev.txt .venv\installed-requirements-dev.txt >nul 2>&1 || set NEED=1
if "%NEED%"=="1" (
  echo Installing backend dependencies...
  pip install -r requirements-dev.txt || goto :fail
  copy /y requirements.txt .venv\installed-requirements.txt >nul
  copy /y requirements-dev.txt .venv\installed-requirements-dev.txt >nul
)
if not exist .env (
  copy .env.example .env >nul
  echo Created backend\.env from the example. Add your GEMINI_API_KEY (or ANTHROPIC_API_KEY) there, or set DEMO_MODE=true.
)
python -m uvicorn app.main:app --reload
goto :eof

:frontend
cd /d "%~dp0frontend" || exit /b 1
fc /b package-lock.json node_modules\.installed-lock.json >nul 2>&1
if errorlevel 1 (
  echo Installing frontend dependencies...
  call npm install || goto :fail
  copy /y package-lock.json node_modules\.installed-lock.json >nul
)
call npm run dev
goto :eof

:fail
echo.
echo Setup failed. Read the message above, fix it, then run this again.
exit /b 1
