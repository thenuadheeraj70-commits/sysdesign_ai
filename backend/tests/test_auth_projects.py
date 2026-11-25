from fastapi.testclient import TestClient

from app.main import app
from app.security import create_token, decode_token

client = TestClient(app, raise_server_exceptions=False)
ARCH = {
    "project_name": "Shop",
    "components": [{"id": "api", "name": "API", "type": "compute", "provider": "aws"}],
    "connections": [],
}


def register(email, password="password123"):
    r = client.post("/api/auth/register", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + r.json()["token"]}


def test_register_login_me():
    h = register("a@example.com")
    assert client.get("/api/auth/me", headers=h).json()["email"] == "a@example.com"
    assert client.post("/api/auth/login", json={"email": "A@Example.com", "password": "password123"}).status_code == 200
    assert client.post("/api/auth/login", json={"email": "a@example.com", "password": "wrongpass1"}).status_code == 401
    assert (
        client.post("/api/auth/register", json={"email": "a@example.com", "password": "password123"}).status_code == 409
    )


def test_validation():
    assert client.post("/api/auth/register", json={"email": "nope", "password": "password123"}).status_code == 422
    assert client.post("/api/auth/register", json={"email": "b@example.com", "password": "short"}).status_code == 422


def test_ai_endpoints_require_login():
    assert client.post("/api/architecture", json={"prompt": "x"}).status_code == 401
    assert client.post("/api/requirements", json={"prompt": "x"}).status_code == 401
    assert client.get("/api/projects").status_code == 401


def test_token_tamper_and_expiry():
    t = create_token(1)
    assert decode_token(t) == 1
    assert decode_token(t[:-2] + "xx") is None
    assert decode_token("garbage") is None


def test_project_crud_and_isolation():
    h1, h2 = register("c@example.com"), register("d@example.com")
    body = {"name": "My shop", "prompt": "build a shop", "architecture": ARCH, "requirements": {"expected_users": 1000}}
    created = client.post("/api/projects", json=body, headers=h1)
    assert created.status_code == 201
    pid = created.json()["id"]
    assert client.get(f"/api/projects/{pid}", headers=h1).json()["architecture"]["project_name"] == "Shop"
    assert [p["name"] for p in client.get("/api/projects", headers=h1).json()["items"]] == ["My shop"]
    # another user can neither see, change nor delete it
    assert client.get("/api/projects", headers=h2).json()["items"] == []
    assert client.get(f"/api/projects/{pid}", headers=h2).status_code == 404
    assert client.put(f"/api/projects/{pid}", json=body, headers=h2).status_code == 404
    assert client.delete(f"/api/projects/{pid}", headers=h2).status_code == 404
    body["name"] = "Renamed"
    assert client.put(f"/api/projects/{pid}", json=body, headers=h1).json()["name"] == "Renamed"
    assert client.delete(f"/api/projects/{pid}", headers=h1).status_code == 204
    assert client.get(f"/api/projects/{pid}", headers=h1).status_code == 404


def test_login_attempts_are_rate_limited(monkeypatch):
    from app.api.routes import auth as auth_routes
    from app.rate_limit import RateLimiter

    monkeypatch.setattr(auth_routes, "_limiter", RateLimiter(3))
    codes = [
        client.post("/api/auth/login", json={"email": "nobody@example.com", "password": "password123"}).status_code
        for _ in range(5)
    ]
    assert codes[:3] == [401, 401, 401] and codes[3:] == [429, 429]
