from app.schemas.models import ArchitectureResult, GenerateCodeResult, KubernetesOutput, TerraformResult

from .kubernetes_generator import generate_kubernetes
from .terraform_generator import generate_terraform

NOTICE = "This generates infrastructure code only. Nothing is deployed or executed."


def generate_code(architecture, region: str | None = None):
    if not isinstance(architecture, ArchitectureResult):
        architecture = ArchitectureResult.model_validate(architecture)
    k = generate_kubernetes(architecture)
    t = generate_terraform(architecture, region=region)
    # The generators use their own result classes; convert to the API schema via plain dicts.
    return GenerateCodeResult(
        project_name=architecture.project_name,
        terraform=TerraformResult.model_validate(t.model_dump()),
        kubernetes=KubernetesOutput(
            available=True,
            files=[f.model_dump() for f in k.files],
            message=(
                f"Kubernetes YAML generated for {len(k.generated_components)} application service(s)."
                if k.generated_components
                else "No application service components were found."
            ),
            warnings=k.warnings,
            skipped_components=[s.model_dump() for s in k.skipped_components],
            notice=k.notice,
        ),
        notice=NOTICE,
    )
