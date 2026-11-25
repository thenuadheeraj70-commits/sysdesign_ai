from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app, raise_server_exceptions=False)


def comp(cid, name, type_, **config):
    return {"id": cid, "name": name, "type": type_, "provider": "aws", "configuration": config}


# one app server, one database, no cache, no load balancer, heavy traffic
ARCH = {
    "project_name": "Shop",
    "components": [comp("api", "API", "compute"), comp("db", "DB", "database")],
    "connections": [{"source": "api", "target": "db"}],
}
REQS = {"peak_requests_per_second": 1500, "monthly_budget": 100000}


def analyze(arch):
    r = client.post("/api/analyze", json={"architecture": arch, "requirements": REQS})
    assert r.status_code == 200, r.text
    return r.json()


def rec_ids(data):
    return {r["id"] for r in data["optimization"]["recommendations"]}


def apply(arch, fix):
    r = client.post("/api/apply-fix", json={"architecture": arch, "patch": fix})
    assert r.status_code == 200, r.text
    return r.json()


def test_each_fix_resolves_its_recommendation():
    arch = ARCH
    data = analyze(arch)
    assert {"single-database", "missing-cache", "missing-load-balancer", "high-utilization"} <= rec_ids(data)
    for rec_id in ["single-database", "missing-cache", "missing-load-balancer", "high-utilization"]:
        rec = next(r for r in analyze(arch)["optimization"]["recommendations"] if r["id"] == rec_id)
        assert rec["fix"], rec_id
        arch = apply(arch, rec["fix"])
        assert rec_id not in rec_ids(analyze(arch)), rec_id


def test_fix_changes_are_visible():
    rec = next(r for r in analyze(ARCH)["optimization"]["recommendations"] if r["id"] == "missing-cache")
    out = apply(ARCH, rec["fix"])
    cache = next(c for c in out["components"] if c["type"] == "cache")
    assert {"source": "api", "target": cache["id"], "label": "cached reads"} in out["connections"]
    assert len(out["components"]) == 3 and len(ARCH["components"]) == 2  # original untouched


def test_scaling_fix_targets_about_70_percent():
    rec = next(r for r in analyze(ARCH)["optimization"]["recommendations"] if r["id"] == "high-utilization")
    arch = apply(ARCH, rec["fix"])
    util = analyze(arch)["performance"]["utilization_percentage"]
    assert util <= 80


def test_stale_fix_is_rejected():
    rec = next(r for r in analyze(ARCH)["optimization"]["recommendations"] if r["id"] == "single-database")
    no_db = {"project_name": "x", "components": [comp("api", "API", "compute")], "connections": []}
    assert client.post("/api/apply-fix", json={"architecture": no_db, "patch": rec["fix"]}).status_code == 422


def test_added_id_collision_is_rejected():
    patch = {"label": "x", "add_components": [comp("api", "Dup", "compute")]}
    assert client.post("/api/apply-fix", json={"architecture": ARCH, "patch": patch}).status_code == 422


def test_cache_fix_picks_a_free_id():
    arch = {
        "project_name": "x",
        "components": [
            comp("api", "API", "compute"),
            comp("db", "DB", "database"),
            comp("cache", "Some other thing", "monitoring"),
        ],
        "connections": [],
    }
    rec = next(r for r in analyze(arch)["optimization"]["recommendations"] if r["id"] == "missing-cache")
    assert rec["fix"]["add_components"][0]["id"] == "cache-2"
