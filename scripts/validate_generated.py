"""Write sample generated infrastructure to disk so real tools can check it.

    python scripts/validate_generated.py <output-dir>

Creates <output-dir>/<sample>/terraform/*.tf and <output-dir>/<sample>/kubernetes/*.yaml for a set of
representative designs. CI then runs `terraform validate` and `kubeconform` over them (see
.github/workflows/ci.yml). Nothing is deployed and no cloud account is needed.

The files are also parsed here (HCL and YAML syntax), so a broken generator fails fast even without
Terraform installed. Run it from the repository root with the backend's Python environment.
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import hcl2  # noqa: E402
import yaml  # noqa: E402

from app.schemas.models import ArchitectureResult  # noqa: E402
from app.services.demo import demo_architecture  # noqa: E402
from app.services.kubernetes_generator import generate_kubernetes  # noqa: E402
from app.services.terraform_generator import generate_terraform  # noqa: E402


def comp(cid: str, name: str, kind: str, **config) -> dict:
    return {"id": cid, "name": name, "type": kind, "provider": "aws", "configuration": config}


def design(name: str, components: list[dict], links: list[tuple[str, str]] = ()) -> ArchitectureResult:
    return ArchitectureResult.model_validate(
        {
            "project_name": name,
            "components": components,
            "connections": [{"source": a, "target": b} for a, b in links],
        }
    )


SAMPLES: dict[str, ArchitectureResult] = {
    "demo-shop": demo_architecture(),
    "web-and-database": design(
        "Web And Database",
        [
            comp("lb", "Load Balancer", "load_balancer"),
            comp("api", "API", "compute", instances=3, instance_type="t3.small", port=8080),
            comp("db", "Database", "database", engine="mysql", multi_az=True, storage_gb=100),
        ],
        [("lb", "api"), ("api", "db")],
    ),
    "static-site-cdn": design(
        "Static Site",
        [comp("cdn", "CDN", "cdn"), comp("assets", "Assets", "storage")],
        [("cdn", "assets")],
    ),
    "memcached-and-queue": design(
        "Cache And Queue",
        [
            comp("api", "API", "compute"),
            comp("cache", "Cache", "cache", engine="memcached", nodes=3),
            comp("jobs", "Jobs", "queue", fifo=True),
            comp("auth", "Auth", "auth"),
        ],
        [("api", "cache"), ("api", "jobs")],
    ),
    "single-compute": design("One Server", [comp("api", "API", "compute")]),
    "hostile-names": design(
        'Name ${with} "quotes" and %{directives}',
        [
            comp("a", 'API "primary" ${x}', "compute", env={"LOG": 'say "hi"'}),
            comp("b", "line one\nline two", "database"),
        ],
        [("a", "b")],
    ),
}


def main(out_dir: Path) -> int:
    failures: list[str] = []
    for name, architecture in SAMPLES.items():
        target = out_dir / name
        for generated in (generate_terraform(architecture).files, generate_kubernetes(architecture).files):
            for f in generated:
                path = target / f.path
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(f.content, encoding="utf-8")
                try:
                    if path.suffix == ".tf":
                        hcl2.load(io.StringIO(f.content))
                    else:
                        list(yaml.safe_load_all(f.content))
                except Exception as exc:  # noqa: BLE001 - report every bad file, not just the first
                    failures.append(f"{name}/{f.path}: {exc}")
        print(f"wrote {target}")
    if failures:
        print("\nSyntax errors in generated files:")
        print("\n".join(f"  {line}" for line in failures))
        return 1
    print(f"\n{len(SAMPLES)} samples written to {out_dir} and parsed successfully.")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sys.exit(main(Path(sys.argv[1])))
