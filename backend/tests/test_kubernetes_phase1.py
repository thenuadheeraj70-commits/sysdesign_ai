import yaml

from app.schemas.models import ArchitectureResult
from app.services.demo import demo_architecture
from app.services.kubernetes_generator import generate_kubernetes


def build(components, connections=()):
    arch = ArchitectureResult.model_validate(
        {
            "project_name": "Shop",
            "components": components,
            "connections": [{"source": a, "target": b} for a, b in connections],
        }
    )
    result = generate_kubernetes(arch)
    docs = {f.path.split("/")[-1]: [d for d in yaml.safe_load_all(f.content) if d] for f in result.files}
    return result, docs


def comp(cid, name, type_, **config):
    return {"id": cid, "name": name, "type": type_, "provider": "aws", "configuration": config}


def test_demo_design_produces_five_valid_yaml_files():
    result = generate_kubernetes(demo_architecture())
    assert [f.path.split("/")[-1] for f in result.files] == [
        "deployment.yaml",
        "service.yaml",
        "configmap.yaml",
        "hpa.yaml",
        "ingress.yaml",
    ]
    for f in result.files:
        list(yaml.safe_load_all(f.content))  # every file parses


def test_deployment_has_requests_and_limits_that_can_be_overridden():
    _, docs = build([comp("api", "API", "compute", cpu_request="250m", memory_limit="1Gi")])
    c = docs["deployment.yaml"][0]["spec"]["template"]["spec"]["containers"][0]["resources"]
    assert c["requests"] == {"cpu": "250m", "memory": "128Mi"}
    assert c["limits"] == {"cpu": "500m", "memory": "1Gi"}


def test_invalid_resource_value_falls_back_with_a_warning():
    result, docs = build([comp("api", "API", "compute", cpu_limit="lots")])
    assert (
        docs["deployment.yaml"][0]["spec"]["template"]["spec"]["containers"][0]["resources"]["limits"]["cpu"] == "500m"
    )
    assert any("cpu_limit" in w for w in result.warnings)


def test_hpa_scales_between_replicas_and_max_and_can_be_turned_off():
    _, docs = build(
        [
            comp("api", "API", "compute", instances=2),
            comp("w", "Worker", "compute", autoscaling=False, instances=1),
            comp("big", "Big", "compute", instances=4, max_replicas=9),
        ]
    )
    hpas = {h["metadata"]["name"]: h["spec"] for h in docs["hpa.yaml"]}
    assert set(hpas) == {"api", "big"}  # the worker opted out
    assert (hpas["api"]["minReplicas"], hpas["api"]["maxReplicas"]) == (2, 6)
    assert (hpas["big"]["minReplicas"], hpas["big"]["maxReplicas"]) == (4, 9)
    assert hpas["api"]["metrics"][0]["resource"]["target"]["averageUtilization"] == 70
    assert hpas["api"]["scaleTargetRef"] == {"apiVersion": "apps/v1", "kind": "Deployment", "name": "api"}


def test_single_exposed_service_gets_root_path_and_is_cluster_ip():
    result, docs = build([comp("lb", "LB", "load_balancer"), comp("api", "API", "compute", port=8080)], [("lb", "api")])
    ingress = docs["ingress.yaml"][0]
    path = ingress["spec"]["rules"][0]["http"]["paths"][0]
    assert path["path"] == "/" and path["backend"]["service"] == {"name": "api", "port": {"number": 8080}}
    assert docs["service.yaml"][0]["spec"]["type"] == "ClusterIP"  # exposed only through the Ingress
    assert any("ingress controller" in w for w in result.warnings)


def test_several_exposed_services_share_one_ingress_with_prefixes():
    _, docs = build(
        [comp("lb", "LB", "load_balancer"), comp("web", "Web", "compute"), comp("api", "API", "compute")],
        [("lb", "web"), ("lb", "api")],
    )
    assert len(docs["ingress.yaml"]) == 1
    assert [p["path"] for p in docs["ingress.yaml"][0]["spec"]["rules"][0]["http"]["paths"]] == ["/web", "/api"]


def test_no_load_balancer_means_no_ingress_and_empty_files_are_valid():
    _, docs = build([comp("api", "API", "compute")])
    assert docs["ingress.yaml"] == []
    _, docs = build([comp("db", "DB", "database")])
    assert docs["deployment.yaml"] == [] and docs["hpa.yaml"] == []


def test_generated_resource_names_include_new_kinds():
    result, _ = build([comp("lb", "LB", "load_balancer"), comp("api", "API", "compute")], [("lb", "api")])
    assert result.generated_components[0].kubernetes_resources == [
        "Deployment/api",
        "Service/api",
        "ConfigMap/api-config",
        "HorizontalPodAutoscaler/api",
        "Ingress/shop-ingress",
    ]
