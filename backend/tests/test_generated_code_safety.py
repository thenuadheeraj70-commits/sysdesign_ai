"""Whatever the AI (or a user) puts in names and settings, the generated files must stay valid and inert."""

import io
import re
import zipfile

import hcl2
import pytest
import yaml

from app.schemas.models import ArchitectureResult
from app.services.demo import demo_architecture
from app.services.kubernetes_generator import generate_kubernetes
from app.services.terraform_generator import generate_terraform
from app.services.zip_export import build_infrastructure_zip

# Names and values chosen to break out of strings, comments, YAML scalars and Markdown.
NASTY = [
    '${evil.thing} and "quotes" and \\backslash',
    '"; rm -rf / #',
    'name"\n}\nresource "aws_iam_user" "pwn" {\n',
    "line1\nline2\r\nline3",
    "%{ if true }inject%{ endif }",
    "null",
    "true",
    "12345",
    "key: value # comment",
    "- list item",
    "*alias &anchor !tag",
    "<script>alert(1)</script> [link](http://x) `tick` | pipe",
    "‮right-to-left‭ override",
    "日本語のコンポーネント",
    "emoji 🚀 name",
    "a" * 300,
    "   ",
    "../../etc/passwd",
]


def hostile_architecture(name: str) -> ArchitectureResult:
    kinds = [
        ("compute", {"instances": 2, "image": "Org/App:1", "env": {"LOG": name, "bad key!": "x"}, "port": 8080}),
        ("load_balancer", {}),
        ("database", {"engine": name}),
        ("storage", {}),
        ("cache", {"engine": name, "nodes": 2}),
        ("queue", {"fifo": True}),
        ("auth", {}),
        ("cdn", {}),
    ]
    components = [
        {
            "id": f"{kind}-{name}"[:90] or kind,
            "name": (name or "x")[:200],
            "type": kind,
            "provider": "aws",
            "configuration": {**config, "note": name},
        }
        for kind, config in kinds
    ]
    ids = [c["id"] for c in components]
    connections = [{"source": ids[1], "target": ids[0], "label": name[:300]}, {"source": ids[7], "target": ids[1]}]
    return ArchitectureResult.model_validate(
        {
            "project_name": name or "x",
            "description": name,
            "components": components,
            "connections": connections,
            "assumptions": [name],
        }
    )


def parses_as_hcl(text: str) -> None:
    hcl2.load(io.StringIO(text))


@pytest.mark.parametrize("name", NASTY)
def test_terraform_stays_valid_and_inert(name):
    result = generate_terraform(hostile_architecture(name))
    for f in result.files:
        parses_as_hcl(f.content)
        # No real interpolation or directive made it through from the text. (Comment lines are skipped:
        # Terraform never evaluates anything inside a "#" comment.)
        code = "\n".join(line for line in f.content.splitlines() if not line.lstrip().startswith("#"))
        assert not re.search(r"(?<!\$)\$\{evil", code), f.path
        assert not re.search(r"(?<!%)%\{ if", code), f.path
        # The injected resource must not exist as a block of its own.
        assert not re.search(r'^resource "aws_iam_user"', f.content, re.MULTILINE), f.path
    main = next(f.content for f in result.files if f.path.endswith("main.tf"))
    resources = set(re.findall(r'^resource "(\w+)"', main, re.MULTILINE))
    assert "aws_iam_user" not in resources


@pytest.mark.parametrize("name", NASTY)
def test_kubernetes_yaml_stays_valid_and_values_round_trip(name):
    arch = hostile_architecture(name)
    result = generate_kubernetes(arch)
    for f in result.files:
        docs = [d for d in yaml.safe_load_all(f.content) if d]
        assert all(isinstance(d, dict) for d in docs), f.path
    configmap = next(f for f in result.files if f.path.endswith("configmap.yaml"))
    data = next(d for d in yaml.safe_load_all(configmap.content) if d)["data"]
    assert data["PROJECT_NAME"] == " ".join(str(name or "x").split())
    assert data["APP_NAME"]  # never blank
    assert "bad key!" not in data  # invalid environment variable names are skipped, not emitted


@pytest.mark.parametrize("name", NASTY)
def test_zip_contains_only_expected_files_and_a_safe_readme(name):
    data, filename = build_infrastructure_zip(hostile_architecture(name))
    names = zipfile.ZipFile(io.BytesIO(data)).namelist()
    assert all(re.fullmatch(r"(terraform|kubernetes)/[\w.-]+|README\.md", n) for n in names), names
    assert re.fullmatch(r"[a-z0-9-]+-infrastructure\.zip", filename), filename
    readme = zipfile.ZipFile(io.BytesIO(data)).read("README.md").decode()
    # HTML in names is either escaped or inside an inline code span (where Markdown shows it as plain text).
    outside_code_spans = re.sub(r"`[^`\n]*`", "", readme)
    assert "<script>" not in outside_code_spans
    prose = re.sub(r"```.*?```", "", readme, flags=re.DOTALL)  # the README's own shell block has "# comment" lines
    assert len(re.findall(r"^# ", prose, re.MULTILINE)) == 1  # the text cannot add a top-level heading


def test_every_generated_file_for_the_demo_design_parses():
    arch = demo_architecture()
    for f in generate_terraform(arch).files:
        parses_as_hcl(f.content)
    for f in generate_kubernetes(arch).files:
        list(yaml.safe_load_all(f.content))


def test_unusual_but_legal_ids_become_valid_terraform_labels():
    ids = ["123abc", "UPPER-case", "with space", "dots.and.more", "日本", "-", "a" * 90, "var", "count"]
    arch = ArchitectureResult.model_validate(
        {
            "project_name": "x",
            "components": [{"id": i, "name": i, "type": "compute", "provider": "aws"} for i in ids],
        }
    )
    result = generate_terraform(arch)
    for f in result.files:
        parses_as_hcl(f.content)
    labels = re.findall(r'^resource "aws_instance" "(\w+)"', result.files[0].content, re.MULTILINE)
    assert len(labels) == len(set(labels)) == len(ids)  # unique, none dropped
