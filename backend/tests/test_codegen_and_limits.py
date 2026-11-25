import io
import zipfile

from fastapi.testclient import TestClient

from app.main import app
from app.rate_limit import RateLimiter
from app.schemas.models import ArchitectureComponent
from app.services.terraform_generator import categorise

client = TestClient(app, raise_server_exceptions=False)

ARCH = {
    "project_name": "Demo",
    "components": [
        {"id": "lb", "name": "LB", "type": "load_balancer", "provider": "aws"},
        {"id": "api", "name": "API", "type": "compute", "provider": "aws", "configuration": {"instances": 2}},
        {"id": "q", "name": "Order Queue Service", "type": "queue", "provider": "aws"},
        {"id": "db", "name": "DB", "type": "database", "provider": "aws"},
    ],
    "connections": [{"source": "lb", "target": "api"}],
}


def test_generate_code_works():
    r = client.post("/api/generate-code", json=ARCH)
    assert r.status_code == 200
    body = r.json()
    assert {f["path"] for f in body["terraform"]["files"]} >= {"terraform/main.tf"}
    assert len(body["kubernetes"]["files"]) == 5
    # the queue becomes an SQS queue, never an EC2 instance or a Kubernetes workload
    tf = {c["id"]: c["terraform_resources"] for c in body["terraform"]["generated_components"]}
    assert tf["q"] == ["aws_sqs_queue.q"]
    assert any(k["id"] == "q" for k in body["kubernetes"]["skipped_components"])


def test_zip_download():
    r = client.post("/api/generate-code/zip", json=ARCH)
    assert r.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
    assert "README.md" in names and "terraform/main.tf" in names


def test_simulate_extreme_values_rejected_not_500():
    r = client.post(
        "/api/simulate",
        json={
            "incoming_requests_per_second": 1e308,
            "number_of_servers": 2,
            "capacity_per_server": 1e-308,
            "average_latency": 1,
        },
    )
    assert r.status_code == 422


def test_cost_supports_queue():
    r = client.post(
        "/api/cost", json={"monthly_budget": 100, "components": [{"id": "q", "resource_type": "queue", "quantity": 2}]}
    )
    assert r.status_code == 200
    assert r.json()["total_monthly_cost"] == 20


def test_oversized_architecture_rejected():
    big = {
        "project_name": "x",
        "components": [{"id": f"c{i}", "name": "n", "type": "compute", "provider": "aws"} for i in range(101)],
    }
    assert client.post("/api/generate-code", json=big).status_code == 422


def test_categorise_trusts_type():
    mk = lambda t, n: ArchitectureComponent(id="x", name=n, type=t, provider="aws")
    assert categorise(mk("queue", "Order Queue Service")) == "queue"  # not compute, despite "Service"
    assert categorise(mk("auth", "Auth Service")) == "auth"
    assert categorise(mk("search", "Search Service")) == "other"
    assert categorise(mk("compute", "Anything")) == "compute"


def test_rate_limiter():
    rl = RateLimiter(2)
    assert rl.allow("a") and rl.allow("a") and not rl.allow("a")
    assert rl.allow("b")
