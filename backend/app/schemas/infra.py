"""Options and requests for generating infrastructure code."""

from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.models import ArchitectureResult, Requirements


class TerraformOptions(BaseModel):
    """Choices that change what the Terraform contains. The defaults aim at something close to deployable."""

    # create: a VPC with public and private subnets, a NAT gateway and subnet groups.
    # existing: you pass vpc_id and subnet ids as variables.
    networking: Literal["create", "existing"] = "create"
    # Put an ACM certificate and an HTTPS listener on the load balancer (needs a domain and a Route 53 zone).
    https: bool = False
    # asg: Auto Scaling groups with target tracking. instances: a fixed number of EC2 instances.
    scaling: Literal["asg", "instances"] = "asg"
    # CloudWatch alarms (with an SNS topic) and a dashboard for the generated resources.
    monitoring: bool = True
    # A backend.tf for S3 state with locking, and a bootstrap folder that creates the bucket and lock table.
    remote_state: bool = False
    # environments/dev.tfvars, staging.tfvars and prod.tfvars.
    environments: bool = True


class InfraOptions(BaseModel):
    """Everything the downloadable bundle can contain."""

    terraform: TerraformOptions = Field(default_factory=TerraformOptions)
    region: str | None = Field(default=None, max_length=30)
    docker_compose: bool = True
    ci: bool = True  # a GitHub Actions workflow that runs terraform validate and plan
    load_test: bool = True  # a k6 script from the traffic profile
    kustomize: bool = True  # base and overlays for the Kubernetes YAML


class BundleRequest(BaseModel):
    architecture: ArchitectureResult
    requirements: Requirements = Field(default_factory=Requirements)
    options: InfraOptions = Field(default_factory=InfraOptions)


class Finding(BaseModel):
    rule: str
    severity: Literal["high", "medium", "low"]
    file: str
    resource: str = ""
    message: str
    fix: str = ""
    source: Literal["built-in", "checkov"] = "built-in"


class PolicyCheckResponse(BaseModel):
    findings: list[Finding]
    checked_files: int
    checkov_available: bool
    notes: list[str] = Field(default_factory=list)
