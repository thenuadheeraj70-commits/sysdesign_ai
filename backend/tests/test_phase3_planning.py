"""Phase 3: presets, comparison, what-if, growth, the budget advisor, traffic profile and patch removal."""

import pytest

from tests.support import client, demo_arch, demo_reqs, small_arch

BODY = {"requirements": demo_reqs()}
PRESETS = ["cheap", "balanced", "highly_available", "dev", "staging", "production"]


@pytest.mark.parametrize("kind", PRESETS)
def test_every_preset_returns_a_valid_design(kind):
    r = client.post("/api/presets", json={"architecture": demo_arch(), "kind": kind, **BODY})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["kind"] == kind and data["name"] and data["architecture"]["components"]
    ids = {c["id"] for c in data["architecture"]["components"]}
    assert all(c["source"] in ids and c["target"] in ids for c in data["architecture"]["connections"])


def test_environment_presets_serve_a_fraction_of_the_traffic():
    scales = {
        k: client.post("/api/presets", json={"architecture": demo_arch(), "kind": k, **BODY}).json()["traffic_scale"]
        for k in PRESETS
    }
    assert scales["dev"] < scales["staging"] < scales["production"] == 1.0


def test_unknown_preset_kind_is_rejected():
    assert client.post("/api/presets", json={"architecture": demo_arch(), "kind": "fastest", **BODY}).status_code == 422


def test_compare_ranks_variants_and_recommends_one():
    variants = []
    for kind in ("cheap", "balanced", "highly_available"):
        preset = client.post("/api/presets", json={"architecture": demo_arch(), "kind": kind, **BODY}).json()
        variants.append({"id": kind, "name": preset["name"], "architecture": preset["architecture"]})
    r = client.post("/api/compare", json={"variants": variants, **BODY})
    assert r.status_code == 200, r.text
    data = r.json()
    rows = {v["id"]: v for v in data["variants"]}
    assert sorted(v["cost_rank"] for v in rows.values()) == [1, 2, 3]
    assert sorted(v["resilience_rank"] for v in rows.values()) == [1, 2, 3]
    assert rows["highly_available"]["monthly_cost"] >= rows["cheap"]["monthly_cost"]
    assert data["recommended_id"] in rows and data["recommendation"]


def test_compare_needs_between_one_and_six_variants():
    one = {"id": "a", "name": "A", "architecture": demo_arch()}
    assert client.post("/api/compare", json={"variants": [], **BODY}).status_code == 422
    assert client.post("/api/compare", json={"variants": [one] * 7, **BODY}).status_code == 422
    assert client.post("/api/compare", json={"variants": [one], **BODY}).status_code == 200


def test_what_if_covers_a_range_and_accepts_custom_points():
    r = client.post("/api/what-if", json={"architecture": demo_arch(), **BODY})
    data = r.json()
    assert r.status_code == 200 and len(data["points"]) >= 5
    utilization = [p["utilization_percentage"] for p in data["points"]]
    assert utilization == sorted(utilization)  # more traffic never lowers utilization
    custom = client.post(
        "/api/what-if", json={"architecture": demo_arch(), "rps_values": [10, 100, 1000], **BODY}
    ).json()
    assert [p["requests_per_second"] for p in custom["points"]] == [10, 100, 1000]


def test_what_if_rejects_negative_traffic():
    r = client.post("/api/what-if", json={"architecture": demo_arch(), "rps_values": [-5], **BODY})
    assert r.status_code == 422


def test_growth_projects_each_month_and_validates_inputs():
    r = client.post(
        "/api/growth", json={"architecture": demo_arch(), "months": 12, "monthly_growth_percent": 10, **BODY}
    )
    data = r.json()
    assert (
        r.status_code == 200 and len(data["months"]) == 13 and data["months"][0]["month"] == 0
    )  # today, then 12 months
    rps = [m["requests_per_second"] for m in data["months"]]
    assert rps == sorted(rps) and rps[-1] > rps[0]
    assert data["total_cost_if_scaled"] >= data["total_cost_unchanged"]
    for bad in ({"months": 0}, {"months": 37}, {"monthly_growth_percent": -1}, {"monthly_growth_percent": 101}):
        assert client.post("/api/growth", json={"architecture": demo_arch(), **BODY, **bad}).status_code == 422


def test_zero_growth_keeps_traffic_flat():
    data = client.post(
        "/api/growth", json={"architecture": demo_arch(), "monthly_growth_percent": 0, "months": 6, **BODY}
    ).json()
    assert len({m["requests_per_second"] for m in data["months"]}) == 1


def test_budget_advisor_with_room_to_spare_suggests_nothing():
    r = client.post("/api/budget-advisor", json={"architecture": demo_arch(), "budget": 1_000_000, **BODY})
    data = r.json()
    assert r.status_code == 200 and data["reachable"] and data["steps"] == [] and data["over_by"] <= 0


def test_budget_advisor_steps_can_be_applied_and_save_money():
    r = client.post("/api/budget-advisor", json={"architecture": demo_arch(), "budget": 50, **BODY})
    data = r.json()
    assert r.status_code == 200 and data["steps"], data
    assert data["final_total"] < data["current_total"]
    assert all(s["saving"] >= 0 for s in data["steps"])
    # Each step's cumulative patch must apply cleanly to the original design.
    for step in data["steps"]:
        applied = client.post("/api/apply-fix", json={"architecture": demo_arch(), "patch": step["cumulative_patch"]})
        assert applied.status_code == 200, applied.text


def test_patch_can_remove_a_component_and_its_connections():
    patch = {"label": "Drop the cache", "remove_components": ["cache"]}
    r = client.post("/api/apply-fix", json={"architecture": demo_arch(), "patch": patch})
    arch = r.json()
    assert r.status_code == 200
    assert "cache" not in {c["id"] for c in arch["components"]}
    assert all("cache" not in (c["source"], c["target"]) for c in arch["connections"])


def test_patch_cannot_remove_what_is_not_there():
    patch = {"label": "x", "remove_components": ["ghost"]}
    assert client.post("/api/apply-fix", json={"architecture": demo_arch(), "patch": patch}).status_code == 422


def test_traffic_scale_lowers_utilization():
    reqs = {"peak_requests_per_second": 2000}
    full = client.post("/api/analyze", json={"architecture": small_arch(), "requirements": reqs}).json()
    tenth = client.post(
        "/api/analyze", json={"architecture": small_arch(), "requirements": reqs, "traffic_scale": 0.1}
    ).json()
    assert tenth["performance"]["utilization_percentage"] < full["performance"]["utilization_percentage"]
    assert tenth["cost"]["total_monthly_cost"] >= 0
