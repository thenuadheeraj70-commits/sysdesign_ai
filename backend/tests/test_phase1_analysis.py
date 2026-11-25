from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app, raise_server_exceptions=False)


def comp(cid, name, type_, **config):
    return {"id": cid, "name": name, "type": type_, "provider": "aws", "configuration": config}


def analyze(arch, **reqs):
    r = client.post("/api/analyze", json={"architecture": arch, "requirements": reqs})
    assert r.status_code == 200, r.text
    return r.json()


def rec(data, rec_id):
    return next((r for r in data["optimization"]["recommendations"] if r["id"] == rec_id), None)


def apply(arch, patch):
    r = client.post("/api/apply-fix", json={"architecture": arch, "patch": patch})
    assert r.status_code == 200, r.text
    return r.json()


# ---------- web-facing servers vs background workers ----------

SHOP = {
    "project_name": "Shop",
    "components": [
        comp("lb", "LB", "load_balancer"),
        comp("api", "API", "compute", instances=2),
        comp("q", "Order Queue", "queue"),
        comp("w", "Order Worker", "compute", instances=5),
        comp("db", "DB", "database", multi_az=True),
    ],
    "connections": [
        {"source": "lb", "target": "api"},
        {"source": "api", "target": "q"},
        {"source": "q", "target": "w"},
        {"source": "api", "target": "db"},
    ],
}


def test_workers_are_priced_but_not_counted_for_traffic():
    data = analyze(SHOP, peak_requests_per_second=2000)
    assert data["inputs"]["number_of_servers"] == 2  # not 7
    assert any("background worker" in d for d in data["derived"])
    assert {l["id"] for l in data["cost"]["breakdown"]} >= {"api", "w"}  # the worker still costs money


def test_scale_fix_changes_only_web_servers_and_resolves_the_issue():
    data = analyze(SHOP, peak_requests_per_second=2000)
    fix = rec(data, "high-utilization")["fix"]
    assert [u["id"] for u in fix["update_components"]] == ["api"]
    after = apply(SHOP, fix)
    assert next(c for c in after["components"] if c["id"] == "w")["configuration"]["instances"] == 5
    assert rec(analyze(after, peak_requests_per_second=2000), "high-utilization") is None


# ---------- budget fix ----------


def test_budget_fix_brings_cost_within_budget():
    arch = {
        "project_name": "x",
        "components": [comp("api", "API", "compute", instances=10), comp("db", "DB", "database", multi_az=True)],
        "connections": [],
    }
    data = analyze(arch, monthly_budget=500, peak_requests_per_second=10)
    fix = rec(data, "over-budget")["fix"]
    assert "save about" in fix["label"]
    after = apply(arch, fix)
    assert analyze(after, monthly_budget=500, peak_requests_per_second=10)["cost"]["budget_status"] == "Within budget"


def test_budget_fix_absent_when_nothing_can_be_reduced():
    arch = {"project_name": "x", "components": [comp("db", "DB", "database", multi_az=True)], "connections": []}
    data = analyze(arch, monthly_budget=10, peak_requests_per_second=1)
    assert rec(data, "over-budget") is not None and rec(data, "over-budget")["fix"] is None


# ---------- single point of failure on non-compute ----------


def test_spof_fix_for_load_balancer():
    arch = {
        "project_name": "x",
        "components": [comp("lb", "LB", "load_balancer", instances=1), comp("api", "API", "compute", instances=3)],
        "connections": [{"source": "lb", "target": "api"}],
    }
    data = analyze(arch, peak_requests_per_second=10)
    fix = rec(data, "single-point-of-failure")["fix"]
    assert fix["update_components"] == [{"id": "lb", "configuration": {"multi_az": True}}]
    assert rec(analyze(apply(arch, fix), peak_requests_per_second=10), "single-point-of-failure") is None


# ---------- preview ----------


def test_preview_shows_before_and_after_without_changing_anything():
    arch = {
        "project_name": "x",
        "components": [comp("api", "API", "compute"), comp("db", "DB", "database")],
        "connections": [{"source": "api", "target": "db"}],
    }
    reqs = {"peak_requests_per_second": 1500, "monthly_budget": 100000}
    fix = rec(analyze(arch, **reqs), "high-utilization")["fix"]
    r = client.post("/api/preview-fix", json={"architecture": arch, "requirements": reqs, "patch": fix})
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["before"]["utilization_percentage"] > 100 > p["after"]["utilization_percentage"]
    assert p["after"]["total_monthly_cost"] > p["before"]["total_monthly_cost"]
    assert p["after"]["number_of_servers"] > p["before"]["number_of_servers"]
    assert p["after"]["issue_count"] < p["before"]["issue_count"]
    assert arch["components"][0]["configuration"] == {}  # input untouched


def test_preview_rejects_a_fix_that_no_longer_fits():
    arch = {"project_name": "x", "components": [comp("api", "API", "compute")], "connections": []}
    patch = {"label": "x", "update_components": [{"id": "gone", "configuration": {"a": 1}}]}
    r = client.post("/api/preview-fix", json={"architecture": arch, "patch": patch})
    assert r.status_code == 422


# ---------- catalog, pricing, region, legacy endpoints ----------


def test_catalog_endpoint():
    body = client.get("/api/catalog").json()
    assert {"queue", "cache", "load_balancer", "network", "security"} <= set(body["types"])
    assert {"aws", "gcp", "azure"} <= set(body["providers"])


def test_network_and_security_components_are_priced():
    arch = {
        "project_name": "x",
        "components": [comp("n", "NAT", "network"), comp("s", "WAF", "security")],
        "connections": [],
    }
    data = analyze(arch, peak_requests_per_second=1)
    assert [l["resource_type"] for l in data["cost"]["breakdown"]] == ["network", "security"]
    assert not any("Not priced" in d for d in data["derived"])


def test_region_becomes_the_terraform_default():
    arch = {"project_name": "x", "components": [comp("api", "API", "compute")], "connections": []}
    r = client.post("/api/generate-code?region=eu-west-1", json=arch)
    variables = next(f["content"] for f in r.json()["terraform"]["files"] if f["path"].endswith("variables.tf"))
    assert 'default     = "eu-west-1"' in variables
    assert client.post("/api/generate-code?region=nowhere", json=arch).status_code == 422
    assert client.post("/api/generate-code/zip?region=bad region!", json=arch).status_code == 422
    assert client.post("/api/generate-code", json=arch).status_code == 200  # still optional


def test_legacy_building_block_endpoints_still_work():
    cost = client.post(
        "/api/cost",
        json={"monthly_budget": 100, "components": [{"id": "a", "resource_type": "compute", "quantity": 1}]},
    )
    assert cost.status_code == 200 and cost.json()["total_monthly_cost"] == 70
    opt = client.post("/api/optimize", json={"architecture": SHOP, "performance": {"utilization_percentage": 150}})
    assert opt.status_code == 200 and any(r["id"] == "high-utilization" for r in opt.json()["recommendations"])


def test_fix_labels_keep_component_names_as_written():
    arch = {
        "project_name": "x",
        "components": [
            comp("lb", "Public ALB", "load_balancer", instances=1),
            comp("api", "API", "compute", instances=3),
        ],
        "connections": [{"source": "lb", "target": "api"}],
    }
    label = rec(analyze(arch, peak_requests_per_second=10), "single-point-of-failure")["fix"]["label"]
    assert label == "Mark as highly available: Public ALB"
