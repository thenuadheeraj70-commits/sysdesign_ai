"""Phase 6: exports (document, diagram, cost CSV, design file), import, share links, version history, my data."""

import csv
import io
import json
import re
import sqlite3
import xml.etree.ElementTree as ET

import pytest

from app import db
from app.services import export_doc
from tests.support import arch_of, client, component, demo_arch, demo_reqs, login, project_body, small_arch

BODY = {"architecture": demo_arch(), "requirements": demo_reqs()}
EVIL = '=cmd|"/c calc"!A1 <script>alert(1)</script> [x](javascript:alert(1)) | & "quoted"'


def evil_arch():
    return arch_of(
        [component("api", "compute", EVIL, instances=2), component("db", "database", "+SUM(A1)", engine="postgres")],
        [("api", "db", "<img src=x onerror=alert(1)>")],
        name=EVIL,
    )


# ---------- document ----------


def test_the_markdown_document_has_every_section():
    r = client.post("/api/export/document?format=markdown", json=BODY)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/markdown")
    assert 'attachment; filename="demo-e-commerce-platform.md"' == r.headers["content-disposition"]
    for heading in (
        "# Demo E-commerce Platform",
        "## Requirements",
        "## Diagram",
        "## Components",
        "## Cost",
        "## Recommendations",
    ):
        assert heading in r.text, heading
    assert "```mermaid\nflowchart LR" in r.text and "Total: $" in r.text


def test_the_printable_document_embeds_the_diagram_and_explains_how_to_save_a_pdf():
    r = client.post("/api/export/document?format=html", json=BODY)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/html")
    assert "data:image/svg+xml;base64," in r.text and "Save as PDF" in r.text and "@media print" in r.text


def test_document_formats_are_limited():
    assert client.post("/api/export/document?format=pdf", json=BODY).status_code == 422


def test_hostile_text_is_escaped_in_every_document_format():
    body = {"architecture": evil_arch(), "requirements": {}}
    html = client.post("/api/export/document?format=html", json=body).text
    assert "<script>" not in html and "onerror=alert" not in html.replace("&lt;img src=x onerror=alert(1)&gt;", "")
    md = client.post("/api/export/document?format=markdown", json=body).text
    assert not re.search(r"(?<!\\)<", md)  # every angle bracket is escaped (or replaced inside the Mermaid block)
    assert "[x](javascript" not in md  # the link syntax is escaped


def test_the_document_works_for_a_tiny_design():
    r = client.post("/api/export/document?format=markdown", json={"architecture": small_arch(), "requirements": {}})
    assert r.status_code == 200 and "## Components" in r.text


# ---------- diagram ----------


def test_the_svg_is_well_formed_and_draws_every_component():
    r = client.post("/api/export/diagram?format=svg", json=demo_arch())
    assert r.headers["content-type"].startswith("image/svg+xml")
    root = ET.fromstring(r.text)
    texts = " ".join("".join(t.itertext()) for t in root.iter("{http://www.w3.org/2000/svg}text"))
    for c in demo_arch()["components"]:
        assert c["name"][:20] in texts
    assert len(list(root.iter("{http://www.w3.org/2000/svg}path"))) >= len(demo_arch()["connections"])


def test_svg_text_is_escaped_so_a_name_cannot_add_elements():
    r = client.post("/api/export/diagram?format=svg", json=evil_arch())
    root = ET.fromstring(r.text)  # parses: nothing broke out of the text
    assert not [e for e in root.iter() if e.tag.endswith("script") or e.tag.endswith("img")]
    assert "<script>" not in r.text


def test_svg_handles_cycles_and_an_empty_design():
    cyc = arch_of([component("a", "compute"), component("b", "compute")], [("a", "b", ""), ("b", "a", "")])
    ET.fromstring(client.post("/api/export/diagram?format=svg", json=cyc).text)
    ET.fromstring(client.post("/api/export/diagram?format=svg", json=arch_of([])).text)


def test_mermaid_text_names_each_component_once_and_quotes_labels():
    text = client.post("/api/export/diagram?format=mermaid", json=evil_arch()).text
    assert text.startswith("flowchart LR") and text.count('["') == 2
    assert "|" not in text.split("-->")[1].split("n1")[0].replace('|"', "").replace('"|', "")


# ---------- cost CSV ----------


def test_the_cost_csv_has_a_row_per_line_and_a_total():
    r = client.post("/api/export/cost-csv", json=BODY)
    rows = list(csv.reader(io.StringIO(r.text)))
    assert r.headers["content-type"].startswith("text/csv") and rows[0][0] == "Item" and rows[-1][0] == "Total"
    assert len(rows) > 3
    total = float(rows[-1][7])
    assert abs(total - sum(float(x[7]) for x in rows[1:-1])) < 0.05


def test_spreadsheet_formulas_in_names_are_neutralised():
    r = client.post("/api/export/cost-csv", json={"architecture": evil_arch(), "requirements": {}})
    for row in list(csv.reader(io.StringIO(r.text)))[1:]:
        assert not row[0].startswith(("=", "+", "-", "@")), row[0]


# ---------- design file: export, import ----------


def test_a_design_file_round_trips():
    exported = client.post("/api/export/design-file", json=BODY)
    assert exported.status_code == 200 and "sysdesign.json" in exported.headers["content-disposition"]
    file = json.loads(exported.text)
    assert file["format"] == "sysdesign-ai" and file["version"] == 1
    back = client.post("/api/import/design", json={"data": file}).json()
    assert back["architecture"]["components"] == demo_arch()["components"] and back["notes"] == []
    assert back["requirements"]["application_type"] == demo_reqs()["application_type"]


def test_a_bare_architecture_can_be_imported_too():
    r = client.post("/api/import/design", json={"data": small_arch()})
    assert r.status_code == 200 and r.json()["requirements"] is None


def test_import_cleans_and_reports_what_it_dropped():
    messy = small_arch()
    messy["components"].append(messy["components"][0])  # duplicate id
    messy["connections"].append({"source": "api", "target": "ghost", "label": ""})
    messy["components"][1]["name"] = "DB\nwith a line break"
    r = client.post("/api/import/design", json={"data": messy}).json()
    assert len(r["architecture"]["components"]) == 2 and "\n" not in r["architecture"]["components"][1]["name"]
    assert any("component" in n for n in r["notes"]) and any("connection" in n for n in r["notes"])


@pytest.mark.parametrize(
    "data,why",
    [
        ({}, "no list of components"),
        ({"components": "nope"}, "no list of components"),
        ({"components": []}, "usable design"),
        ({"format": "other-app", "architecture": small_arch()}, "not a SysDesign AI export"),
    ],
)
def test_bad_design_files_are_refused_with_a_reason(data, why):
    r = client.post("/api/import/design", json={"data": data})
    assert r.status_code == 422 and why in json.dumps(r.json())


def test_a_file_with_nonsense_in_a_field_is_repaired_not_a_crash():
    r = client.post(
        "/api/import/design", json={"data": {"components": [{"id": "a"}], "connections": 5, "assumptions": 7}}
    )
    assert r.status_code == 200 and [c["id"] for c in r.json()["architecture"]["components"]] == ["a"]


def test_import_refuses_an_enormous_file():
    huge = {
        "components": [{"id": f"c{i}", "name": "x" * 1000, "type": "compute", "provider": "aws"} for i in range(2500)]
    }
    assert client.post("/api/import/design", json={"data": huge}).status_code == 422


def test_bad_requirements_in_a_file_are_left_out_not_fatal():
    data = {"format": "sysdesign-ai", "architecture": small_arch(), "requirements": {"expected_users": "lots"}}
    r = client.post("/api/import/design", json={"data": data}).json()
    assert r["requirements"] is None and any("requirements" in n for n in r["notes"])


def test_export_file_helper_is_json_serialisable():
    from app.schemas.models import ArchitectureResult

    json.dumps(export_doc.export_file(ArchitectureResult(**small_arch()), None))


# ---------- share links ----------


def make_project(headers, **kw):
    r = client.post("/api/projects", json=project_body(**kw), headers=headers)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_a_share_link_can_be_created_read_without_login_and_revoked():
    h = login("share")
    pid = make_project(h)
    assert client.get(f"/api/projects/{pid}/share", headers=h).json() == {"shared": False, "token": None, "path": None}
    created = client.post(f"/api/projects/{pid}/share", headers=h).json()
    token = created["token"]
    assert created["shared"] and len(token) >= 30 and created["path"] == f"/?shared={token}"
    assert client.post(f"/api/projects/{pid}/share", headers=h).json()["token"] == token  # same link every time

    public = client.get(f"/api/shared/{token}")  # no Authorization header
    assert (
        public.status_code == 200
        and public.headers["cache-control"] == "no-store"
        and public.headers["x-robots-tag"] == "noindex"
    )
    data = public.json()
    assert data["name"] == "Shop" and data["document"]["title"] and data["architecture"]["components"]
    assert client.get(f"/api/shared/{token}/diagram.svg").headers["content-type"].startswith("image/svg+xml")

    assert client.delete(f"/api/projects/{pid}/share", headers=h).json()["shared"] is False
    assert client.get(f"/api/shared/{token}").status_code == 404
    assert client.get(f"/api/shared/{token}/diagram.svg").status_code == 404
    assert client.post(f"/api/projects/{pid}/share", headers=h).json()["token"] != token  # a new link, not the old one


def test_the_shared_page_exposes_nothing_about_the_owner_or_other_projects():
    h = login("priv")
    pid = make_project(h, name="Visible")
    make_project(h, name="Secret other project")
    token = client.post(f"/api/projects/{pid}/share", headers=h).json()["token"]
    text = client.get(f"/api/shared/{token}").text
    assert "Secret other project" not in text and "@example.com" not in text and '"user_id"' not in text


def test_the_share_diagram_has_locked_down_headers():
    h = login("hdr")
    token = client.post(f"/api/projects/{make_project(h)}/share", headers=h).json()["token"]
    headers = client.get(f"/api/shared/{token}/diagram.svg").headers
    assert headers["x-content-type-options"] == "nosniff" and "default-src 'none'" in headers["content-security-policy"]


@pytest.mark.parametrize("token", ["short", "x" * 24, "../../etc/passwd", "a" * 200, "%00" * 10])
def test_guessed_or_malformed_tokens_are_a_404(token):
    assert client.get(f"/api/shared/{token}").status_code == 404


def test_only_the_owner_can_manage_a_share_link():
    owner, other = login("own"), login("oth")
    pid = make_project(owner)
    assert client.post(f"/api/projects/{pid}/share", headers=other).status_code == 404
    token = client.post(f"/api/projects/{pid}/share", headers=owner).json()["token"]
    assert client.delete(f"/api/projects/{pid}/share", headers=other).status_code == 404
    assert client.get(f"/api/projects/{pid}/share", headers=other).status_code == 404
    assert client.get(f"/api/shared/{token}").status_code == 200  # the failed revoke changed nothing
    assert client.post(f"/api/projects/{pid}/share").status_code == 401


def test_a_deleted_project_stops_being_shared_and_a_restored_one_resumes():
    h = login("del")
    pid = make_project(h)
    token = client.post(f"/api/projects/{pid}/share", headers=h).json()["token"]
    client.delete(f"/api/projects/{pid}", headers=h)
    assert client.get(f"/api/shared/{token}").status_code == 404
    client.post(f"/api/projects/{pid}/restore", headers=h)
    assert client.get(f"/api/shared/{token}").status_code == 200


def test_the_shared_page_follows_later_saves():
    h = login("follow")
    pid = make_project(h)
    token = client.post(f"/api/projects/{pid}/share", headers=h).json()["token"]
    client.put(f"/api/projects/{pid}", json=project_body(small_arch(), name="Renamed"), headers=h)
    data = client.get(f"/api/shared/{token}").json()
    assert data["name"] == "Renamed" and len(data["architecture"]["components"]) == 2


def test_the_public_endpoints_are_rate_limited(monkeypatch):
    from app.api.routes import sharing
    from app.rate_limit import RateLimiter

    monkeypatch.setattr(sharing, "_public_limiter", RateLimiter(3))
    codes = [client.get("/api/shared/" + "a" * 30).status_code for _ in range(5)]
    assert codes[:3] == [404] * 3 and codes[3:] == [429, 429]


# ---------- version history ----------


def versions(h, pid):
    return client.get(f"/api/projects/{pid}/versions", headers=h).json()["items"]


def test_every_save_keeps_a_version_newest_first():
    h = login("ver")
    pid = make_project(h)
    assert [v["label"] for v in versions(h, pid)] == ["Created"]
    client.put(f"/api/projects/{pid}", json=project_body(small_arch(), name="Two"), headers=h)
    client.put(f"/api/projects/{pid}", json=project_body(small_arch(), name="Three"), headers=h)
    items = versions(h, pid)
    assert [v["label"] for v in items] == ["Saved", "Saved", "Created"]
    assert [v["component_count"] for v in items] == [2, 2, len(demo_arch()["components"])]


def test_renaming_alone_does_not_add_a_version_but_a_duplicate_starts_its_own_history():
    h = login("ver2")
    pid = make_project(h)
    client.patch(f"/api/projects/{pid}", json={"name": "Renamed"}, headers=h)
    assert len(versions(h, pid)) == 1
    copy = client.post(f"/api/projects/{pid}/duplicate", headers=h).json()["id"]
    assert [v["label"] for v in versions(h, copy)] == ["Created (copy)"]


def test_only_the_latest_30_versions_are_kept():
    h = login("ver3")
    pid = make_project(h)
    for i in range(35):
        client.put(f"/api/projects/{pid}", json=project_body(name=f"v{i}"), headers=h)
    assert len(versions(h, pid)) == 30


def test_comparing_a_version_with_now_lists_what_changed():
    h = login("cmp")
    pid = make_project(h)
    first = versions(h, pid)[0]["id"]
    same = client.get(f"/api/projects/{pid}/versions/{first}/compare", headers=h).json()
    assert same["identical"] and same["added"] == same["removed"] == same["changed"] == []
    client.put(f"/api/projects/{pid}", json=project_body(small_arch(), name="Smaller"), headers=h)
    diff = client.get(f"/api/projects/{pid}/versions/{first}/compare", headers=h).json()
    assert not diff["identical"] and diff["removed"] and diff["renamed"] == "Shop → Smaller"


def test_restoring_a_version_brings_the_design_back_and_can_itself_be_undone():
    h = login("rest")
    pid = make_project(h)
    original = versions(h, pid)[0]["id"]
    client.put(f"/api/projects/{pid}", json=project_body(small_arch(), name="Smaller"), headers=h)
    assert len(client.get(f"/api/projects/{pid}", headers=h).json()["architecture"]["components"]) == 2

    assert client.post(f"/api/projects/{pid}/versions/{original}/restore", headers=h).json() == {"restored": original}
    now = client.get(f"/api/projects/{pid}", headers=h).json()
    assert now["name"] == "Shop" and len(now["architecture"]["components"]) == len(demo_arch()["components"])
    labels = [v["label"] for v in versions(h, pid)]
    assert labels[0] == f"Restored version {original}" and "Before restoring" in labels  # the "smaller" state is kept
    smaller = next(v["id"] for v in versions(h, pid) if v["label"] == "Before restoring")
    client.post(f"/api/projects/{pid}/versions/{smaller}/restore", headers=h)
    assert client.get(f"/api/projects/{pid}", headers=h).json()["name"] == "Smaller"


def test_restoring_keeps_variants_and_the_open_variant():
    h = login("restv")
    variants = [
        {"id": "a", "name": "Original", "architecture": demo_arch(), "traffic_scale": 1},
        {"id": "b", "name": "Cheap", "architecture": small_arch(), "traffic_scale": 0.5},
    ]
    pid = make_project(h, variants=variants, active_variant_id="b")
    first = versions(h, pid)[0]
    assert first["variant_count"] == 2
    client.put(f"/api/projects/{pid}", json=project_body(name="Plain"), headers=h)
    client.post(f"/api/projects/{pid}/versions/{first['id']}/restore", headers=h)
    back = client.get(f"/api/projects/{pid}", headers=h).json()
    assert [v["id"] for v in back["variants"]] == ["a", "b"] and back["active_variant_id"] == "b"


def test_versions_are_private_and_missing_ones_are_a_404():
    owner, other = login("vown"), login("voth")
    pid = make_project(owner)
    vid = versions(owner, pid)[0]["id"]
    for method, path in (
        ("get", f"/api/projects/{pid}/versions"),
        ("get", f"/api/projects/{pid}/versions/{vid}/compare"),
        ("post", f"/api/projects/{pid}/versions/{vid}/restore"),
    ):
        assert getattr(client, method)(path, headers=other).status_code == 404, path
        assert getattr(client, method)(path).status_code == 401, path
    assert client.get(f"/api/projects/{pid}/versions/99999/compare", headers=owner).status_code == 404
    assert client.post(f"/api/projects/{pid}/versions/99999/restore", headers=owner).status_code == 404
    other_pid = make_project(other)
    assert (
        client.get(f"/api/projects/{other_pid}/versions/{vid}/compare", headers=other).status_code == 404
    )  # not by id guessing


def test_versions_go_when_the_project_is_deleted_for_good():
    h = login("vdel")
    pid = make_project(h)
    client.delete(f"/api/projects/{pid}?permanent=true", headers=h)
    with db.get_conn() as conn:
        assert conn.execute("SELECT COUNT(*) FROM project_versions WHERE project_id = ?", (pid,)).fetchone()[0] == 0


# ---------- my data ----------


def test_download_all_my_projects_has_only_my_projects():
    mine, theirs = login("mine"), login("theirs")
    make_project(mine, name="Mine one")
    gone = make_project(mine, name="Mine in the trash")
    client.delete(f"/api/projects/{gone}", headers=mine)
    make_project(theirs, name="Not mine")
    r = client.get("/api/projects/export-all", headers=mine)
    assert r.status_code == 200 and "my-sysdesign-projects.json" in r.headers["content-disposition"]
    data = json.loads(r.text)
    names = {p["name"] for p in data["projects"]}
    assert names == {"Mine one", "Mine in the trash"} and data["format"] == "sysdesign-ai-projects"
    assert next(p for p in data["projects"] if p["name"] == "Mine in the trash")["deleted_at"]
    assert "Not mine" not in r.text and "token" not in r.text.lower().replace("tokens", "")
    assert client.get("/api/projects/export-all").status_code == 401


def test_export_all_does_not_clash_with_a_project_id_route():
    assert client.get("/api/projects/export-all", headers=login("route")).status_code == 200


# ---------- database upgrade ----------


def test_an_older_database_gets_the_share_column_and_version_table(tmp_path):
    path = str(tmp_path / "old.db")
    conn = sqlite3.connect(path)
    conn.executescript(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, password_hash TEXT, created_at TEXT);"
        "CREATE TABLE projects (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, prompt TEXT, architecture TEXT, "
        "requirements TEXT, created_at TEXT, updated_at TEXT);"
        "INSERT INTO users VALUES (1, 'a@b.co', 'x', '');"
        "INSERT INTO projects VALUES (1, 1, 'Old', '', '{}', NULL, '', '');"
    )
    conn.commit()
    conn.close()
    db._init(path)
    conn = sqlite3.connect(path)
    columns = {r[1] for r in conn.execute("PRAGMA table_info(projects)")}
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"share_token", "variants", "deleted_at"} <= columns and "project_versions" in tables
    assert conn.execute("SELECT name FROM projects").fetchone()[0] == "Old"  # nothing was lost
    conn.close()


def test_share_tokens_are_unique_across_projects():
    h = login("uniq")
    tokens = {client.post(f"/api/projects/{make_project(h)}/share", headers=h).json()["token"] for _ in range(5)}
    assert len(tokens) == 5 and all(re.fullmatch(r"[A-Za-z0-9_-]{20,64}", t) for t in tokens)
