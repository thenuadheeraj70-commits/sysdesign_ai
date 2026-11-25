import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import ai, auth, design, export, health, planning, projects, sharing, toolkit
from app.config import APP_NAME, CORS_ORIGINS, VERSION, startup_messages


@asynccontextmanager
async def lifespan(_app: FastAPI):
    log = logging.getLogger("uvicorn.error")
    for level, text in startup_messages():
        getattr(log, level)(text)
    yield


app = FastAPI(title=APP_NAME, description="AI-powered system design assistant", version=VERSION, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)

app.include_router(health.router)
app.include_router(auth.router)
app.include_router(sharing.router)  # before projects: /api/projects/export-all must not match /{project_id}
app.include_router(projects.router)
app.include_router(design.router)
app.include_router(planning.router)
app.include_router(toolkit.router)
app.include_router(ai.router)
app.include_router(export.router)
