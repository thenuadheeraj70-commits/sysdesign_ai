"""Kubernetes generator: turns an ArchitectureResult into basic Kubernetes YAML.

Scope (deliberately small): application services only. Every COMPUTE component
becomes standard objects, one file per kind:

    deployment.yaml   Deployment  (runs the containers, with CPU/memory requests and limits)
    service.yaml      Service     (gives them a stable, cluster-internal address)
    configmap.yaml    ConfigMap   (plain-text settings, loaded as environment variables)
    hpa.yaml          HorizontalPodAutoscaler (scales on CPU; off with configuration autoscaling=false)
    ingress.yaml      Ingress     (one, for the services that sit behind a load balancer)

Nothing else is generated: no namespaces, secrets, volumes or databases. Components
that are not application services (databases, caches, storage, load balancers, ...)
are listed in `skipped_components` with the reason.

Rules, kept simple on purpose:
  * Replicas come from the component configuration (instances / replicas / count), default 1.
  * The container image comes from configuration["image"]. Real image names are not
    known to the architecture, so otherwise a PLACEHOLDER is used and a warning is
    added. Replace it before applying.
  * The container port comes from configuration["port"], default 80.
  * Every Service is ClusterIP. A service connected to a load balancer component is
    exposed through the Ingress instead (a placeholder 'nginx' class, no host, no TLS).
  * Requests and limits default to 100m/128Mi and 500m/512Mi; override per component
    with cpu_request, memory_request, cpu_limit, memory_limit.
  * The autoscaler runs from the replica count up to max_replicas (default 3x).
  * The ConfigMap holds APP_NAME, PROJECT_NAME, CONNECTS_TO (the names of the
    components it connects to, if any), and any simple values in configuration["env"].

The result is returned as structured data. Nothing is written to disk, applied,
or sent to a cluster. This is STARTING-POINT YAML: review it before use.

Try it from the backend folder:  python -m services.kubernetes_generator
"""

import json
import re
from string import Template

from pydantic import BaseModel

from app.schemas.models import ArchitectureComponent, ArchitectureResult, SkippedComponent
from app.services.terraform_generator import categorise

# ---------- Configuration ----------

OUTPUT_DIR = "kubernetes"
DEFAULT_REPLICAS = 1
DEFAULT_PORT = 80
PLACEHOLDER_IMAGE_REGISTRY = "your-registry"  # placeholder image: your-registry/<name>:latest
MAX_NAME_LENGTH = 63  # Kubernetes limit for resource names
CONFIGMAP_SUFFIX = "-config"
ENV_KEY_PATTERN = r"[A-Za-z_][A-Za-z0-9_]*"
IMAGE_PATTERN = r"[a-z0-9][a-z0-9._\-/:@]*"

# Resource requests and limits (overridable per component with cpu_request, memory_limit, ...).
DEFAULT_RESOURCES = {"cpu_request": "100m", "memory_request": "128Mi", "cpu_limit": "500m", "memory_limit": "512Mi"}
CPU_PATTERN = r"[0-9]+m|[0-9]+(\.[0-9]+)?"
MEMORY_PATTERN = r"[0-9]+(Mi|Gi)"
HPA_CPU_TARGET = 70  # scale out when average CPU passes this percentage
MAX_REPLICAS = 1000
INGRESS_CLASS = "nginx"  # placeholder: set to the ingress controller the cluster really uses

NOTICE = (
    "Generated starter YAML, not applied or deployed. Replace any placeholder "
    "images, and review ports, resource limits and settings. Namespaces, secrets and "
    "volumes are not generated. Nothing has been sent to a cluster."
)

# ---------- Templates ----------
# $name, $image, ... are filled in by Python. Text values (names, labels, image,
# ConfigMap data) are written with json.dumps(), and a JSON string is a valid YAML
# double-quoted string.

DEPLOYMENT = Template("""\
apiVersion: apps/v1
kind: Deployment
metadata:
  name: $name
  labels:
    app: $name
    app.kubernetes.io/part-of: $part_of
    app.kubernetes.io/managed-by: sysdesign-ai
spec:
  replicas: $replicas
  selector:
    matchLabels:
      app: $name
  template:
    metadata:
      labels:
        app: $name
    spec:
      containers:
        - name: $name
          image: $image
          ports:
            - containerPort: $port
          envFrom:
            - configMapRef:
                name: $configmap_name
          resources:
            requests:
              cpu: $cpu_request
              memory: $memory_request
            limits:
              cpu: $cpu_limit
              memory: $memory_limit
""")

HPA = Template("""\
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: $name
  labels:
    app: $name
    app.kubernetes.io/part-of: $part_of
    app.kubernetes.io/managed-by: sysdesign-ai
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: $name
  minReplicas: $min_replicas
  maxReplicas: $max_replicas
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: $cpu_target
""")

# One Ingress for every service that sits behind a load balancer in the design.
INGRESS = Template("""\
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: $name
  labels:
    app.kubernetes.io/part-of: $part_of
    app.kubernetes.io/managed-by: sysdesign-ai
spec:
  ingressClassName: $ingress_class
  rules:
    - http:
        paths:
$paths""")

INGRESS_PATH = Template("""\
          - path: $path
            pathType: Prefix
            backend:
              service:
                name: $service
                port:
                  number: $port
""")

SERVICE = Template("""\
apiVersion: v1
kind: Service
metadata:
  name: $name
  labels:
    app: $name
    app.kubernetes.io/part-of: $part_of
    app.kubernetes.io/managed-by: sysdesign-ai
spec:
  type: $service_type
  selector:
    app: $name
  ports:
    - protocol: TCP
      port: $port
      targetPort: $port
""")

CONFIGMAP = Template("""\
apiVersion: v1
kind: ConfigMap
metadata:
  name: $name
  labels:
    app: $app
    app.kubernetes.io/part-of: $part_of
    app.kubernetes.io/managed-by: sysdesign-ai
data:
$data""")


# ---------- Result models ----------


class KubernetesFile(BaseModel):
    path: str  # e.g. "kubernetes/deployment.yaml"
    content: str


class KubernetesGeneratedComponent(BaseModel):
    id: str
    name: str
    kubernetes_resources: list[str]  # e.g. ["Deployment/api-1", "Service/api-1", ...]


class KubernetesResult(BaseModel):
    project_name: str
    files: list[KubernetesFile]
    generated_components: list[KubernetesGeneratedComponent]
    skipped_components: list[SkippedComponent]
    warnings: list[str]
    notice: str = NOTICE


# ---------- Helpers ----------


def _quote(value) -> str:
    """A safe YAML double-quoted string."""
    return json.dumps(str(value), ensure_ascii=False)


def _dns_name(raw: str, fallback: str = "app") -> str:
    """A valid Kubernetes name: lowercase letters, digits and '-', starting and ending alphanumeric."""
    name = re.sub(r"[^a-z0-9]+", "-", raw.lower()).strip("-")
    return name or fallback


def _unique_name(raw: str, used: set[str]) -> str:
    # Leave room for the "-config" suffix and a numeric tie-breaker.
    base = _dns_name(raw)[: MAX_NAME_LENGTH - len(CONFIGMAP_SUFFIX) - 3].strip("-") or "app"
    name, n = base, 2
    while name in used:
        name, n = f"{base}-{n}", n + 1
    used.add(name)
    return name


def _config(component: ArchitectureComponent) -> dict:
    return {str(k).lower(): v for k, v in component.configuration.items()}


def _config_int(config: dict, keys: list[str], minimum: int, maximum: int):
    for key in keys:
        value = config.get(key)
        if value is None or isinstance(value, bool):
            continue
        try:
            number = int(float(value))
        except (TypeError, ValueError):
            continue
        if minimum <= number <= maximum:
            return number
    return None


def _config_text(config: dict, keys: list[str], pattern: str):
    """The first configuration value that is a string fully matching `pattern`, else None."""
    for key in keys:
        value = config.get(key)
        if isinstance(value, str) and re.fullmatch(pattern, value.strip()):
            return value.strip()
    return None


def _scalar_text(value):
    """Text for a simple value, or None for lists, dicts and null."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (str, int, float)):
        return str(value)
    return None


def _data_block(entries: dict[str, str]) -> str:
    return "".join(f"  {key}: {_quote(value)}\n" for key, value in entries.items())


HEADER = "# Generated by SysDesign AI. Starter YAML: review it before applying.\n"


# ---------- Generator ----------


def generate_kubernetes(architecture: ArchitectureResult | dict) -> KubernetesResult:
    """Convert an architecture into Kubernetes YAML (returned as data, not written to disk)."""
    if not isinstance(architecture, ArchitectureResult):
        architecture = ArchitectureResult.model_validate(architecture)

    part_of = _dns_name(architecture.project_name, "project")[:MAX_NAME_LENGTH].strip("-") or "project"
    components_by_id = {c.id: c for c in architecture.components}
    category = {c.id: categorise(c) for c in architecture.components}

    warnings: list[str] = []
    skipped: list[SkippedComponent] = []
    generated: list[KubernetesGeneratedComponent] = []
    deployments: list[str] = []
    services: list[str] = []
    configmaps: list[str] = []
    autoscalers: list[str] = []
    exposed: list[tuple[str, int]] = []  # (service name, port) of services behind a load balancer
    used_names: set[str] = set()
    missing_image: list[str] = []

    for c in architecture.components:
        if category[c.id] != "compute":
            if category[c.id] == "load_balancer":
                reason = (
                    "Load balancers are not generated. A service connected to one is "
                    "exposed through the Ingress instead."
                )
            else:
                reason = "Not an application service. Only compute components become Kubernetes workloads."
            skipped.append(SkippedComponent(id=c.id, name=c.name, reason=reason))
            continue

        name = _unique_name(c.id, used_names)
        configmap_name = f"{name}{CONFIGMAP_SUFFIX}"
        config = _config(c)

        replicas = (
            _config_int(config, ["replicas", "instances", "instance_count", "count"], 1, 1000) or DEFAULT_REPLICAS
        )
        port = _config_int(config, ["port", "container_port"], 1, 65535) or DEFAULT_PORT

        image = config.get("image")
        if isinstance(image, str) and re.fullmatch(IMAGE_PATTERN, image.strip()):
            image = image.strip()
        else:
            if "image" in config:
                warnings.append(
                    f"'{_one_line(c.name)}': the configured image isn't a valid image name, so a placeholder was used."
                )
            image = f"{PLACEHOLDER_IMAGE_REGISTRY}/{name}:latest"
            missing_image.append(_one_line(c.name))

        # Which other components does this one connect to (either direction)?
        neighbours = []
        for conn in architecture.connections:
            if conn.source == c.id:
                neighbours.append(conn.target)
            elif conn.target == c.id:
                neighbours.append(conn.source)
        connects_to = [_one_line(components_by_id[i].name) for i in dict.fromkeys(neighbours) if i in components_by_id]
        behind_lb = any(category.get(i) == "load_balancer" for i in neighbours)

        data = {"APP_NAME": c.name and _one_line(c.name) or name, "PROJECT_NAME": _one_line(architecture.project_name)}
        if connects_to:
            data["CONNECTS_TO"] = ", ".join(connects_to)

        env = config.get("env")
        if isinstance(env, dict):
            for key, value in env.items():
                text = _scalar_text(value)
                if not re.fullmatch(ENV_KEY_PATTERN, str(key)) or text is None:
                    warnings.append(
                        f"'{_one_line(c.name)}': environment setting '{key}' was skipped "
                        "(names must be letters, digits and underscores, and values must be simple)."
                    )
                else:
                    data[str(key)] = text

        # Names and label values are always quoted: a name like "123", "true" or "null"
        # would otherwise be read by YAML as a number, boolean or null instead of text.
        resources = {}
        for key, default in DEFAULT_RESOURCES.items():
            pattern = CPU_PATTERN if key.startswith("cpu") else MEMORY_PATTERN
            value = _config_text(config, [key], pattern)
            if value is None and key in config:
                warnings.append(
                    f"'{_one_line(c.name)}': {key} isn't a valid value (use for example 250m or 256Mi), "
                    f"so {default} was used."
                )
            resources[key] = value or default

        q_name, q_part_of, q_cm = _quote(name), _quote(part_of), _quote(configmap_name)
        deployments.append(
            DEPLOYMENT.substitute(
                name=q_name,
                part_of=q_part_of,
                replicas=replicas,
                image=_quote(image),
                port=port,
                configmap_name=q_cm,
                **{k: _quote(v) for k, v in resources.items()},
            )
        )
        # Services are always cluster-internal; anything behind a load balancer is reached through the Ingress.
        services.append(SERVICE.substitute(name=q_name, part_of=q_part_of, port=port, service_type="ClusterIP"))
        if behind_lb:
            exposed.append((name, port))

        if config.get("autoscaling") is not False:
            max_replicas = _config_int(config, ["max_replicas"], replicas, MAX_REPLICAS) or min(
                MAX_REPLICAS, max(replicas * 3, replicas + 2)
            )
            autoscalers.append(
                HPA.substitute(
                    name=q_name,
                    part_of=q_part_of,
                    min_replicas=replicas,
                    max_replicas=max_replicas,
                    cpu_target=HPA_CPU_TARGET,
                )
            )
        resource_names = [f"Deployment/{name}", f"Service/{name}", f"ConfigMap/{configmap_name}"]
        if config.get("autoscaling") is not False:
            resource_names.append(f"HorizontalPodAutoscaler/{name}")
        if behind_lb:
            resource_names.append(f"Ingress/{part_of}-ingress")
        configmaps.append(CONFIGMAP.substitute(name=q_cm, app=q_name, part_of=q_part_of, data=_data_block(data)))
        generated.append(KubernetesGeneratedComponent(id=c.id, name=c.name, kubernetes_resources=resource_names))

    if missing_image:
        warnings.insert(
            0,
            "No container image was set for: "
            + ", ".join(missing_image)
            + f". Placeholder images ({PLACEHOLDER_IMAGE_REGISTRY}/...) were used. "
            "Replace them before applying.",
        )
    if not generated:
        warnings.append("No application services (compute components) were found, so the files are empty.")

    # One Ingress for all exposed services: a single one gets "/", several get "/<service>".
    ingress_docs: list[str] = []
    if exposed:
        paths = "".join(
            INGRESS_PATH.substitute(
                path=_quote("/" if len(exposed) == 1 else f"/{svc}"), service=_quote(svc), port=port
            )
            for svc, port in exposed
        )
        ingress_docs.append(
            INGRESS.substitute(
                name=_quote(f"{part_of}-ingress"[:MAX_NAME_LENGTH].strip("-")),
                part_of=_quote(part_of),
                ingress_class=_quote(INGRESS_CLASS),
                paths=paths,
            )
        )
        warnings.append(
            f"The Ingress assumes an '{INGRESS_CLASS}' ingress controller and has no host name or TLS. "
            "Set ingressClassName, add a host and a certificate, and check the path rules"
            + (" (several services share one host, so each is under /<service>)." if len(exposed) > 1 else ".")
        )
    if autoscalers:
        warnings.append(
            "Autoscaling needs the Kubernetes metrics server. The Deployments also set a fixed "
            "replica count, which a later 'kubectl apply' resets; remove 'replicas' if the "
            "autoscaler should own it."
        )

    def build(filename: str, docs: list[str], empty: str = "# No application services to deploy.\n") -> KubernetesFile:
        body = "---\n".join(docs) if docs else empty
        return KubernetesFile(path=f"{OUTPUT_DIR}/{filename}", content=HEADER + body)

    return KubernetesResult(
        project_name=architecture.project_name,
        files=[
            build("deployment.yaml", deployments),
            build("service.yaml", services),
            build("configmap.yaml", configmaps),
            build("hpa.yaml", autoscalers, "# No autoscaling configured (no services, or autoscaling is off).\n"),
            build("ingress.yaml", ingress_docs, "# No services sit behind a load balancer, so no Ingress is needed.\n"),
        ],
        generated_components=generated,
        skipped_components=skipped,
        warnings=warnings,
    )


def _one_line(text: str) -> str:
    return " ".join(str(text).split())


if __name__ == "__main__":
    demo = ArchitectureResult(
        project_name="Demo Shop",
        components=[
            {"id": "lb-1", "name": "Public Load Balancer", "type": "load_balancer", "provider": "aws"},
            {
                "id": "api-1",
                "name": "API Servers",
                "type": "compute",
                "provider": "aws",
                "configuration": {
                    "instances": 3,
                    "port": 8080,
                    "image": "myorg/shop-api:1.4.2",
                    "env": {"LOG_LEVEL": "info"},
                },
            },
            {"id": "worker", "name": "Order Worker", "type": "compute", "provider": "aws"},
            {"id": "db-1", "name": "Primary Database", "type": "database", "provider": "aws"},
        ],
        connections=[
            {"source": "lb-1", "target": "api-1"},
            {"source": "api-1", "target": "db-1"},
            {"source": "api-1", "target": "worker"},
        ],
    )
    result = generate_kubernetes(demo)
    for f in result.files:
        print(f"===== {f.path} =====\n{f.content}")
    print("Skipped:", [s.model_dump() for s in result.skipped_components])
    print("Warnings:", result.warnings)
