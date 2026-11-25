import itertools
import sqlite3

from fastapi.testclient import TestClient

from app import db
from app.main import app

client = TestClient(app, raise_server_exceptions=False)
_n = itertools.count()


def login():
    email = f"p1-{next(_n)}@example.com"
    token = client.post("/api/auth/register", json={"email": email, "password": "password123"}).json()["token"]
    return {"Authorization": "Bearer " + token}


def body(name="Shop", positions=None):
    data = {
        "name": name,
        "prompt": "p",
        "architecture": {
            "project_name": "S",
            "connections": [],
            "components": [{"id": "api", "name": "API", "type": "compute", "provider": "aws"}],
        },
    }
    if positions is not None:
        data["positions"] = positions
    return data


def test_positions_are_saved_and_stale_ones_dropped():
    h = login()
    pos = {"api": {"x": 10.5, "y": 20}, "ghost": {"x": 1, "y": 1}}
    pid = client.post("/api/projects", json=body(positions=pos), headers=h).json()["id"]
    got = client.get(f"/api/projects/{pid}", headers=h).json()
    assert got["positions"] == {"api": {"x": 10.5, "y": 20.0}}  # 'ghost' is not a component
    # saving without positions clears them; absurd values are rejected
    client.put(f"/api/projects/{pid}", json=body(), headers=h)
    assert client.get(f"/api/projects/{pid}", headers=h).json()["positions"] is None
    bad = body(positions={"api": {"x": 1e12, "y": 0}})
    assert client.post("/api/projects", json=bad, headers=h).status_code == 422


def test_search_sort_and_pagination():
    h = login()
    for name in ["Zebra shop", "alpha API", "Beta 100%", "Gamma_x"]:
        assert client.post("/api/projects", json=body(name), headers=h).status_code == 201
    page = client.get("/api/projects?sort=name&limit=2", headers=h).json()
    assert [p["name"] for p in page["items"]] == ["alpha API", "Beta 100%"] and page["total"] == 4
    page2 = client.get("/api/projects?sort=name&limit=2&offset=2", headers=h).json()
    assert [p["name"] for p in page2["items"]] == ["Gamma_x", "Zebra shop"]
    assert [p["name"] for p in client.get("/api/projects?q=SHOP", headers=h).json()["items"]] == ["Zebra shop"]
    # wildcard characters in the search text are literal
    assert [p["name"] for p in client.get("/api/projects?q=100%25", headers=h).json()["items"]] == ["Beta 100%"]
    assert client.get("/api/projects?q=_", headers=h).json()["total"] == 1
    assert client.get("/api/projects?limit=1000", headers=h).status_code == 422


def test_rename_and_duplicate():
    h = login()
    pid = client.post("/api/projects", json=body("Original", {"api": {"x": 1, "y": 2}}), headers=h).json()["id"]
    assert client.patch(f"/api/projects/{pid}", json={"name": "  Renamed  "}, headers=h).json()["name"] == "Renamed"
    assert client.patch(f"/api/projects/{pid}", json={"name": ""}, headers=h).status_code == 422
    copy = client.post(f"/api/projects/{pid}/duplicate", headers=h).json()
    assert copy["id"] != pid and copy["name"] == "Renamed (copy)"
    assert copy["positions"] == {"api": {"x": 1.0, "y": 2.0}}
    assert client.get("/api/projects", headers=h).json()["total"] == 2


def test_soft_delete_restore_and_permanent_delete():
    h, other = login(), login()
    pid = client.post("/api/projects", json=body("Keep me"), headers=h).json()["id"]
    assert client.delete(f"/api/projects/{pid}", headers=h).status_code == 204
    assert client.get(f"/api/projects/{pid}", headers=h).status_code == 404  # hidden from normal use
    assert client.get("/api/projects", headers=h).json()["total"] == 0
    assert [p["name"] for p in client.get("/api/projects/trash", headers=h).json()] == ["Keep me"]
    assert client.get("/api/projects/trash", headers=other).json() == []  # trash is private
    assert client.post(f"/api/projects/{pid}/restore", headers=other).status_code == 404
    assert client.post(f"/api/projects/{pid}/restore", headers=h).json()["name"] == "Keep me"
    assert client.get("/api/projects/trash", headers=h).json() == []
    client.delete(f"/api/projects/{pid}", headers=h)
    assert client.delete(f"/api/projects/{pid}?permanent=true", headers=h).status_code == 204
    assert client.get("/api/projects/trash", headers=h).json() == []


def test_old_trash_is_purged_after_30_days():
    h = login()
    pid = client.post("/api/projects", json=body("Old"), headers=h).json()["id"]
    client.delete(f"/api/projects/{pid}", headers=h)
    with db.get_conn() as conn:
        conn.execute("UPDATE projects SET deleted_at = datetime('now', '-31 days') WHERE id = ?", (pid,))
    assert client.get("/api/projects/trash", headers=h).json() == []


def test_database_created_before_this_release_is_upgraded(tmp_path):
    path = str(tmp_path / "old.db")
    old = sqlite3.connect(path)
    old.executescript("""CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, password_hash TEXT, created_at TEXT);
        CREATE TABLE projects (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, prompt TEXT,
        architecture TEXT, requirements TEXT, created_at TEXT, updated_at TEXT);""")
    old.commit()
    old.close()
    new = sqlite3.connect(path)
    db._migrate(new)
    cols = {r[1] for r in new.execute("PRAGMA table_info(projects)")}
    assert {"positions", "deleted_at"} <= cols
    db._migrate(new)  # running it again is harmless
