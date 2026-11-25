"""Helpers shared by the Phase 3 to 6 tests."""

import itertools

from fastapi.testclient import TestClient

from app.main import app
from app.services.demo import demo_architecture, demo_requirements

client = TestClient(app, raise_server_exceptions=False)
_accounts = itertools.count()


def login(label: str = "t"):
    """Headers for a fresh account, so tests never share data."""
    email = f"{label}-{next(_accounts)}@example.com"
    token = client.post("/api/auth/register", json={"email": email, "password": "password123"}).json()["token"]
    return {"Authorization": "Bearer " + token}


def demo_arch() -> dict:
    return demo_architecture().model_dump()


def demo_reqs() -> dict:
    return demo_requirements().model_dump()


def component(id_, type_, name=None, provider="aws", **config) -> dict:
    return {"id": id_, "name": name or id_.title(), "type": type_, "provider": provider, "configuration": config}


def arch_of(components, connections=(), name="Test Design") -> dict:
    return {
        "project_name": name,
        "description": "A test design.",
        "components": list(components),
        "connections": [{"source": s, "target": t, "label": label} for s, t, label in connections],
        "assumptions": ["10k users"],
    }


def small_arch() -> dict:
    """One web tier and one single-zone database: the simplest design that has something to improve."""
    return arch_of(
        [
            component("api", "compute", "API Servers", instances=2),
            component("db", "database", "Database", engine="postgres"),
        ],
        [("api", "db", "sql")],
    )


def project_body(arch=None, name="Shop", **extra) -> dict:
    return {"name": name, "prompt": "a shop", "architecture": arch or demo_arch(), "requirements": demo_reqs(), **extra}
