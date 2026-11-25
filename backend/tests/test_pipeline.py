from fastapi.testclient import TestClient

from app.main import app
from app.services.pipeline import traffic_from_users

client = TestClient(app, raise_server_exceptions=False)

ARCH = {
    "project_name": "Shop",
    "components": [
        {"id": "lb", "name": "LB", "type": "load_balancer", "provider": "aws"},
        {"id": "api", "name": "API", "type": "compute", "provider": "aws", "configuration": {"instances": 3}},
        {"id": "db", "name": "DB", "type": "database", "provider": "aws"},
        {"id": "assets", "name": "Assets", "type": "storage", "provider": "aws", "configuration": {"storage_gb": 500}},
        {"id": "mon", "name": "Mon", "type": "monitoring", "provider": "aws"},
        {"id": "x", "name": "Weird", "type": "blockchain", "provider": "aws"},
    ],
    "connections": [{"source": "lb", "target": "api"}, {"source": "api", "target": "db"}],
}


def test_analysis_uses_architecture():
    r = client.post(
        "/api/analyze",
        json={"architecture": ARCH, "requirements": {"peak_requests_per_second": 2000, "monthly_budget": 500}},
    )
    assert r.status_code == 200
    b = r.json()
    assert b["inputs"]["number_of_servers"] == 3  # from the compute component
    assert b["performance"]["total_capacity"] == 1500  # 3 x default 500
    assert b["performance"]["utilization_percentage"] > 100
    assert {l["id"] for l in b["cost"]["breakdown"]} == {"lb", "api", "db", "assets", "mon"}
    assert any(r["id"] == "high-utilization" for r in b["optimization"]["recommendations"])
    assert any("Weird" in d for d in b["derived"])  # unpriced component is reported


def test_traffic_from_users():
    assert traffic_from_users(100_000) > 100


def test_no_budget_is_not_flagged_over_budget():
    r = client.post("/api/analyze", json={"architecture": ARCH})
    assert r.json()["cost"]["budget_status"] == "Within budget"


def test_empty_architecture_rejected():
    r = client.post("/api/analyze", json={"architecture": {"project_name": "x"}})
    assert r.status_code == 422
