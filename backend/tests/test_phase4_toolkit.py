"""Phase 4: the design toolkit (capacity, API, data model, sequences, decisions, patterns, reliability, regions)."""

import pytest

from app.services.toolkit.regions import distance_km, rtt_ms
from app.services.toolkit.reliability import parse_target
from tests.support import arch_of, client, component, demo_arch, demo_reqs, small_arch

BODY = {"architecture": demo_arch(), "requirements": demo_reqs()}
SMALL = {"architecture": small_arch(), "requirements": {}}


def post(path, body=BODY):
    r = client.post(path, json=body)
    assert r.status_code == 200, f"{path}: {r.text}"
    return r.json()


# ---------- capacity ----------


def test_capacity_has_every_section_with_formulas():
    data = post("/api/capacity")
    sections = {line["section"] for line in data["lines"]}
    assert {"Traffic", "Storage", "Servers"} <= sections or len(sections) >= 4
    assert all(line["formula"] for line in data["lines"])
    assert data["headlines"] and data["inputs"]


def test_capacity_inputs_override_and_are_reported_as_yours():
    reqs = {**demo_reqs(), "capacity_inputs": {"total_users": 5_000_000}}
    data = post("/api/capacity", {"architecture": demo_arch(), "requirements": reqs})
    users = next(i for i in data["inputs"] if i["key"] == "total_users")
    assert users["value"] == 5_000_000 and users["source"] == "yours"
    base = post("/api/capacity")
    peak = lambda d: next(
        x["value"] for x in d["lines"] if "peak" in x["label"].lower() and x["unit"].startswith("req")
    )  # noqa: E731
    assert peak(data) > peak(base)


@pytest.mark.parametrize("field,value", [("read_ratio", 2), ("cache_hit_ratio", -0.1), ("peak_to_average", 0.5)])
def test_capacity_rejects_impossible_assumptions(field, value):
    reqs = {**demo_reqs(), "capacity_inputs": {field: value}}
    assert client.post("/api/capacity", json={"architecture": demo_arch(), "requirements": reqs}).status_code == 422


# ---------- API design ----------


def test_api_design_lists_endpoints_and_an_openapi_document():
    data = post("/api/api-design")
    assert data["domain"] == "ecommerce"
    endpoints = [e for g in data["groups"] for e in g["endpoints"]]
    assert endpoints and all(e["method"] in {"GET", "POST", "PUT", "PATCH", "DELETE"} for e in endpoints)
    assert data["openapi"]["openapi"].startswith("3.")
    assert data["openapi"]["paths"]


def test_api_design_for_an_unknown_kind_of_app_is_generic_but_not_empty():
    data = post("/api/api-design", SMALL)
    assert data["domain"] == "generic" and data["groups"]


# ---------- data model ----------


def test_data_model_produces_consistent_entities_sql_and_er_diagram():
    data = post("/api/data-model")
    names = {e["name"] for e in data["entities"]}
    assert data["dialect"] == "postgres" and data["sql"].count("CREATE TABLE") >= 3
    assert data["mermaid"].lstrip().startswith("erDiagram")
    for e in data["entities"]:
        for f in e["fields"]:
            if f["references"]:
                assert f["references"] in names, (e["name"], f)
    assert all(r["source"] in names and r["target"] in names for r in data["relations"])


def test_data_model_without_a_relational_database_has_no_sql():
    arch = arch_of([component("api", "compute"), component("kv", "database", engine="dynamodb")], [("api", "kv", "")])
    data = post("/api/data-model", {"architecture": arch, "requirements": {}})
    assert data["sql"] == ""


# ---------- sequences, decisions, patterns ----------


def test_sequence_flows_reference_only_their_own_participants():
    data = post("/api/sequences")
    available = [f for f in data["flows"] if f["available"]]
    assert available
    for flow in available:
        ids = {p["id"] for p in flow["participants"]}
        for step in flow["steps"]:
            if step["kind"] in {"call", "return", "async", "note"}:
                assert step["source"] in ids and step["target"] in ids
        assert flow["mermaid"].startswith("sequenceDiagram")


def test_a_flow_that_needs_a_missing_component_says_why():
    data = post("/api/sequences", SMALL)
    unavailable = [f for f in data["flows"] if not f["available"]]
    assert unavailable and all(f["reason"] for f in unavailable)


def test_decisions_have_unique_ids_and_markdown():
    data = post("/api/decisions")
    ids = [r["id"] for r in data["records"]]
    assert ids and len(ids) == len(set(ids)) and ids[0] == "ADR-001"
    assert "ADR-001" in data["markdown"] and all(r["alternatives"] for r in data["records"])


def test_hostile_component_names_cannot_break_out_of_the_markdown():
    evil = component("db", "database", "x | <script>alert(1)</script> [link](javascript:1)", engine="postgres")
    arch = arch_of([component("api", "compute"), evil], [("api", "db", "")])
    md = post("/api/decisions", {"architecture": arch, "requirements": {}})["markdown"]
    assert "<script>" not in md and "\\<script\\>" in md


def test_patterns_use_known_statuses_and_their_fixes_apply():
    data = post("/api/patterns", SMALL)
    assert {p["status"] for p in data["patterns"]} <= {"recommended", "consider", "in place", "not needed"}
    fixes = [p["fix"] for p in data["patterns"] if p["fix"]]
    assert fixes
    for fix in fixes:
        r = client.post("/api/apply-fix", json={"architecture": small_arch(), "patch": fix})
        assert r.status_code == 200, (fix["label"], r.text)


def test_a_cache_that_exists_is_reported_in_place():
    patterns = {p["id"]: p for p in post("/api/patterns")["patterns"]}
    assert patterns["cache-aside"]["status"] == "in place"


# ---------- reliability ----------


@pytest.mark.parametrize(
    "text,expected",
    [
        ("99.9%", 99.9),
        ("99.95", 99.95),
        ("five nines", 99.999),
        ("high availability", 99.9),
        ("fast", None),
        ("", None),
    ],
)
def test_availability_targets_are_read_from_text(text, expected):
    assert parse_target(text) == expected


def test_more_copies_and_a_standby_database_raise_availability():
    single = arch_of(
        [component("api", "compute", instances=1), component("db", "database", engine="postgres")], [("api", "db", "")]
    )
    better = arch_of(
        [component("api", "compute", instances=3), component("db", "database", engine="postgres", multi_az=True)],
        [("api", "db", "")],
    )
    a = post("/api/reliability", {"architecture": single, "requirements": {}})
    b = post("/api/reliability", {"architecture": better, "requirements": {}})
    assert b["estimated_availability_percent"] > a["estimated_availability_percent"]
    assert b["estimated_rto_minutes"] < a["estimated_rto_minutes"]
    assert b["estimated_rpo_minutes"] < a["estimated_rpo_minutes"]


def test_targets_are_checked_and_the_fix_closes_the_gap():
    reqs = {"reliability": {"availability_percent": 99.99, "rto_minutes": 5, "rpo_minutes": 1}}
    data = post("/api/reliability", {"architecture": small_arch(), "requirements": reqs})
    assert data["availability_gap_percent"] < 0
    assert any("short of" in v or "longer than" in v for v in data["verdicts"])
    fix = next(a["fix"] for a in data["advice"] if a["fix"] and "multi" in a["title"].lower())
    fixed = client.post("/api/apply-fix", json={"architecture": small_arch(), "patch": fix}).json()
    after = post("/api/reliability", {"architecture": fixed, "requirements": reqs})
    assert after["estimated_availability_percent"] > data["estimated_availability_percent"]


def test_reliability_targets_are_validated():
    for bad in ({"availability_percent": 100}, {"availability_percent": 0}, {"rto_minutes": -1}):
        reqs = {"reliability": bad}
        assert (
            client.post("/api/reliability", json={"architecture": small_arch(), "requirements": reqs}).status_code
            == 422
        )


# ---------- multi-region ----------


def test_region_distances_and_round_trip_times_make_sense():
    assert rtt_ms("eu-west-1", "eu-west-1") == 2.0
    assert rtt_ms("us-east-1", "eu-west-1") == rtt_ms("eu-west-1", "us-east-1")
    assert rtt_ms("us-east-1", "eu-west-1") < rtt_ms("us-east-1", "ap-southeast-2")
    assert 5000 < distance_km("us-east-1", "eu-west-1") < 6000


def region_request(**kw):
    return {**BODY, "primary_region": "us-east-1", "secondary_regions": ["eu-west-1"], **kw}


def test_active_active_improves_latency_for_far_users_but_passive_does_not():
    users = [{"region": "eu-central-1", "percent": 70}, {"region": "us-east-1", "percent": 30}]
    active = post("/api/multi-region", region_request(mode="active-active", user_regions=users))
    passive = post("/api/multi-region", region_request(mode="active-passive", user_regions=users))
    assert active["average_latency_after_ms"] < active["average_latency_before_ms"]
    assert passive["average_latency_after_ms"] == passive["average_latency_before_ms"]


def test_the_multi_region_variant_is_a_valid_bigger_design_with_a_replica():
    data = post("/api/multi-region", region_request())
    variant = data["architecture"]
    assert len(variant["components"]) > len(demo_arch()["components"])
    ids = {c["id"] for c in variant["components"]}
    assert all(c["source"] in ids and c["target"] in ids for c in variant["connections"])
    assert any(c["configuration"].get("replica_of") for c in variant["components"])
    assert any(link["what"].startswith("Database") for link in data["links"])


def test_multi_region_rejects_bad_input():
    assert client.post("/api/multi-region", json=region_request(primary_region="mars-1")).status_code == 422
    assert client.post("/api/multi-region", json=region_request(secondary_regions=["x"] * 5)).status_code == 422
    assert client.post("/api/multi-region", json=region_request(mode="sideways")).status_code == 422
    bad_user = region_request(user_regions=[{"region": "us-east-1", "percent": 150}])
    assert client.post("/api/multi-region", json=bad_user).status_code == 422


def test_with_no_secondary_region_there_is_no_variant():
    data = post("/api/multi-region", region_request(secondary_regions=[]))
    assert data["architecture"] is None and data["changes"]


# ---------- explain and glossary ----------


def test_explain_describes_a_component_in_its_context():
    data = post("/api/explain", {**BODY, "component_id": "db"})
    assert data["name"] and data["what_it_is"] and data["alternatives"] and data["pitfalls"]
    assert data["receives_from"] and data["sends_to"] == []  # the database only answers


def test_explaining_a_missing_component_is_a_404():
    r = client.post("/api/explain", json={**BODY, "component_id": "ghost"})
    assert r.status_code == 404


def test_glossary_lists_terms_with_definitions():
    terms = client.get("/api/glossary").json()["terms"]
    assert len(terms) > 40 and all(t["term"] and t["definition"] for t in terms)
    assert {"RTO", "RPO", "CDN"} <= {t["term"] for t in terms}
