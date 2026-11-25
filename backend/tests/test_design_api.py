from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_simulate():
    r = client.post(
        "/api/simulate",
        json={
            "incoming_requests_per_second": 5000,
            "number_of_servers": 4,
            "capacity_per_server": 1500,
            "average_latency": 100,
        },
    )
    assert r.status_code == 200
    assert r.json()["total_capacity"] == 6000
