"""Terraform generator: turns an ArchitectureResult into starter Terraform files.

Scope (deliberately small): AWS only, and these kinds of component:

    compute        -> aws_instance                      (EC2)
    load balancer  -> aws_lb + target group + listener  (Application Load Balancer)
    database       -> aws_db_instance                   (RDS)
    storage        -> aws_s3_bucket (+ public access block)
    cache          -> ElastiCache (Redis replication group, or Memcached cluster)
    queue          -> aws_sqs_queue (standard or FIFO)
    cdn            -> CloudFront distribution (origin = a connected load balancer or storage)
    auth           -> Cognito user pool + app client

Anything else (search, monitoring, other providers, ...) is NOT generated. It is
listed in `skipped_components` with the reason, so nothing disappears silently.

How it works:
  * Each supported component becomes one block of Terraform made from a template.
  * Things a user will likely want to change (instance type, engine, ...) become
    variables in variables.tf, with defaults taken from the component's
    configuration when it has one.
  * A connection between a load balancer and a compute component becomes a
    target group attachment. Other connections are not expressed in Terraform.

The result is returned as structured data (TerraformResult). Nothing is written
to disk and nothing is run. The output is a STARTING POINT: networking, security
groups, IAM, backups and cost have not been designed. Review it, and run
`terraform validate` and `terraform plan` before applying anything.
"""

import re
from string import Template

from pydantic import BaseModel

from app.schemas.models import ArchitectureComponent, ArchitectureResult
from app.services.catalog import is_non_core_type

# ---------- Configuration ----------

TERRAFORM_VERSION = ">= 1.5.0"
AWS_PROVIDER_VERSION = "~> 5.0"
DEFAULT_REGION = "us-east-1"
OUTPUT_DIR = "terraform"

SUPPORTED_PROVIDERS = {"aws"}

DEFAULTS = {
    "instance_type": "t3.micro",
    "instance_count": 1,
    "db_engine": "postgres",
    "db_instance_class": "db.t3.medium",
    "db_allocated_storage": 20,
}
SUPPORTED_DB_ENGINES = {"postgres", "mysql", "mariadb"}
DB_ENGINE_ALIASES = {"postgresql": "postgres"}

# Words that suggest what a component is: checked on the type first, then the name.
# Order matters: the first category that matches wins.
CATEGORY_KEYWORDS: dict[str, list[str]] = {
    "load_balancer": ["load balancer", "loadbalancer", "lb", "alb", "elb", "nlb"],
    "cache": ["cache", "redis", "memcached", "elasticache"],
    "queue": ["queue", "sqs"],
    "cdn": ["cdn", "cloudfront"],
    "auth": ["auth", "authentication", "cognito"],
    "database": ["database", "db", "sql", "postgres", "postgresql", "mysql", "mariadb", "rds", "aurora"],
    "storage": ["storage", "bucket", "s3", "blob", "object storage"],
    "compute": [
        "compute",
        "server",
        "servers",
        "app",
        "api",
        "web",
        "backend",
        "service",
        "vm",
        "instance",
        "container",
        "ec2",
        "worker",
    ],
}

SUPPORTED_CATEGORIES = {"compute", "load_balancer", "database", "storage", "cache", "queue", "cdn", "auth"}
# A component's declared type decides these directly (the catalog treats them as non-core
# for compute classification, so their names must not turn them into servers).
TYPE_CATEGORIES = {"queue": "queue", "cdn": "cdn", "auth": "auth"}

DEFAULT_CACHE_NODE_TYPE = "cache.t3.micro"
CACHE_PORTS = {"redis": 6379, "memcached": 11211}
MAX_CACHE_NODES = {"redis": 6, "memcached": 40}
# AWS managed CloudFront cache policy "CachingOptimized"
CLOUDFRONT_CACHING_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6"

NOTICE = (
    "Generated starter code, not a finished or reviewed deployment. Networking, "
    "security groups, IAM, backups and costs have not been designed. Run "
    "'terraform validate' and 'terraform plan' and review everything before applying."
)

# ---------- Templates ----------
# string.Template placeholders ($name / ${name}) are filled in by Python.
# The templates deliberately avoid Terraform's own "${...}" interpolation.

PROVIDERS_TF = Template("""\
terraform {
  required_version = "$terraform_version"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "$aws_provider_version"
    }
  }
}

provider "aws" {
  region = var.aws_region
}
""")

VARIABLE = Template("""\
variable "$name" {
  description = "$description"
  type        = $type
$extra}
""")

OUTPUT = Template("""\
output "$name" {
  description = "$description"
  value       = $value
}
""")

COMPUTE = Template("""\
# $comment (compute)
resource "aws_instance" "$label" {
  count         = var.${label}_instance_count
  ami           = var.ami_id
  instance_type = var.${label}_instance_type
  subnet_id     = var.subnet_ids[0]

  vpc_security_group_ids = [aws_security_group.${label}.id]

  tags = {
    Name      = "$name"
    Project   = var.project_name
    ManagedBy = "sysdesign-ai"
  }
}
""")

LOAD_BALANCER = Template("""\
# $comment (load balancer)
resource "aws_lb" "$label" {
  load_balancer_type = "application"
  subnets            = var.subnet_ids
  security_groups    = [aws_security_group.${label}.id]

  tags = {
    Name      = "$name"
    Project   = var.project_name
    ManagedBy = "sysdesign-ai"
  }
}

resource "aws_lb_target_group" "$label" {
  port     = 80
  protocol = "HTTP"
  vpc_id   = var.vpc_id
}

resource "aws_lb_listener" "$label" {
  load_balancer_arn = aws_lb.${label}.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.${label}.arn
  }
}
""")

TARGET_ATTACHMENT = Template("""\
# Connection: $lb_comment -> $target_comment
resource "aws_lb_target_group_attachment" "${lb_label}_${target_label}" {
  count            = var.${target_label}_instance_count
  target_group_arn = aws_lb_target_group.${lb_label}.arn
  target_id        = aws_instance.${target_label}[count.index].id
  port             = 80
}
""")

DATABASE = Template("""\
# $comment (database)
resource "aws_db_instance" "$label" {
  engine              = var.${label}_engine
  instance_class      = var.${label}_instance_class
  allocated_storage   = var.${label}_allocated_storage
  multi_az            = var.${label}_multi_az
  storage_encrypted   = true
  publicly_accessible = false
  username            = var.db_username
  password            = var.db_password
  skip_final_snapshot = true # set to false for production so a final backup is kept

  vpc_security_group_ids = [aws_security_group.${label}.id]

  tags = {
    Name      = "$name"
    Project   = var.project_name
    ManagedBy = "sysdesign-ai"
  }
}
""")

STORAGE = Template("""\
# $comment (storage)
resource "aws_s3_bucket" "$label" {
  bucket = var.${label}_bucket_name

  tags = {
    Name      = "$name"
    Project   = var.project_name
    ManagedBy = "sysdesign-ai"
  }
}

resource "aws_s3_bucket_public_access_block" "$label" {
  bucket                  = aws_s3_bucket.${label}.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
""")


SECURITY_GROUP = Template("""\
# $comment (security group)
resource "aws_security_group" "$label" {
  name_prefix = "$${var.project_name}-${label}-"
  description = "$description"
  vpc_id      = var.vpc_id
$ingress
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name      = "$name"
    Project   = var.project_name
    ManagedBy = "sysdesign-ai"
  }
}
""")


def _ingress(port: int, sources: list[str], open_to_world: bool = False) -> str:
    """One ingress rule: from the given security groups, else the world, else var.allowed_cidr_blocks."""
    if sources:
        who = "security_groups = [" + ", ".join(f"aws_security_group.{s}.id" for s in sources) + "]"
    elif open_to_world:
        who = 'cidr_blocks     = ["0.0.0.0/0"]'
    else:
        who = "cidr_blocks     = var.allowed_cidr_blocks"
    return (
        f"\n  ingress {{\n    from_port       = {port}\n    to_port         = {port}\n"
        f'    protocol        = "tcp"\n    {who}\n  }}\n'
    )


CACHE_REDIS = Template("""\
# $comment (cache)
resource "aws_elasticache_replication_group" "$label" {
  replication_group_id       = "$cache_id"
  description                = "$name"
  engine                     = "redis"
  node_type                  = var.${label}_node_type
  num_cache_clusters         = var.${label}_num_nodes
  automatic_failover_enabled = var.${label}_num_nodes > 1
  port                       = 6379
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  security_group_ids         = [aws_security_group.${label}.id]

  tags = {
    Name      = "$name"
    Project   = var.project_name
    ManagedBy = "sysdesign-ai"
  }
}
""")

CACHE_MEMCACHED = Template("""\
# $comment (cache)
resource "aws_elasticache_cluster" "$label" {
  cluster_id         = "$cache_id"
  engine             = "memcached"
  node_type          = var.${label}_node_type
  num_cache_nodes    = var.${label}_num_nodes
  port               = 11211
  security_group_ids = [aws_security_group.${label}.id]

  tags = {
    Name      = "$name"
    Project   = var.project_name
    ManagedBy = "sysdesign-ai"
  }
}
""")

QUEUE = Template("""\
# $comment (queue)
resource "aws_sqs_queue" "$label" {
  name                       = var.${label}_queue_name$fifo
  message_retention_seconds  = 345600
  visibility_timeout_seconds = 30
  sqs_managed_sse_enabled    = true

  tags = {
    Name      = "$name"
    Project   = var.project_name
    ManagedBy = "sysdesign-ai"
  }
}
""")

AUTH = Template("""\
# $comment (auth)
resource "aws_cognito_user_pool" "$label" {
  name                     = "$name"
  auto_verified_attributes = ["email"]
  mfa_configuration        = "OPTIONAL"

  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = true
  }

  software_token_mfa_configuration {
    enabled = true
  }

  tags = {
    Name      = "$name"
    Project   = var.project_name
    ManagedBy = "sysdesign-ai"
  }
}

resource "aws_cognito_user_pool_client" "$label" {
  name            = "$name client"
  user_pool_id    = aws_cognito_user_pool.${label}.id
  generate_secret = false

  explicit_auth_flows = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
}
""")

CDN_COMMON_TAIL = """\
  default_cache_behavior {
    target_origin_id       = "origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
$cache_settings  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = {
    Name      = "$name"
    Project   = var.project_name
    ManagedBy = "sysdesign-ai"
  }
}
"""

# Origin is a load balancer (dynamic content): nothing is cached, requests are forwarded.
CDN_LB = Template(
    """\
# $comment (cdn, origin: $origin_comment)
resource "aws_cloudfront_distribution" "$label" {
  enabled = true
  comment = "$name"

  origin {
    domain_name = aws_lb.${origin_label}.dns_name
    origin_id   = "origin"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

"""
    + CDN_COMMON_TAIL
)

# Origin is an S3 bucket (static files): cached, reached through origin access control.
CDN_S3 = Template(
    """\
# $comment (cdn, origin: $origin_comment)
resource "aws_cloudfront_origin_access_control" "$label" {
  name                              = "$${var.project_name}-${label}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "$label" {
  enabled = true
  comment = "$name"

  origin {
    domain_name              = aws_s3_bucket.${origin_label}.bucket_regional_domain_name
    origin_id                = "origin"
    origin_access_control_id = aws_cloudfront_origin_access_control.${label}.id
  }

"""
    + CDN_COMMON_TAIL
    + """
# Lets only this CloudFront distribution read the bucket.
resource "aws_s3_bucket_policy" "${label}_cdn" {
  bucket = aws_s3_bucket.${origin_label}.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "$${aws_s3_bucket.${origin_label}.arn}/*"
      Condition = {
        StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.${label}.arn }
      }
    }]
  })
}
"""
)

CDN_LB_SETTINGS = """    min_ttl                = 0
    default_ttl            = 0
    max_ttl                = 0

    forwarded_values {
      query_string = true
      headers      = ["Host", "Authorization"]

      cookies {
        forward = "all"
      }
    }
"""
CDN_S3_SETTINGS = f"""    cache_policy_id        = "{CLOUDFRONT_CACHING_OPTIMIZED}"
"""

# ---------- Result models ----------


class TerraformFile(BaseModel):
    path: str  # e.g. "terraform/main.tf"
    content: str


class GeneratedComponent(BaseModel):
    id: str
    name: str
    category: str  # compute, load_balancer, database or storage
    terraform_resources: list[str]  # e.g. ["aws_instance.api_1"]


class SkippedComponent(BaseModel):
    id: str
    name: str
    reason: str


class TerraformResult(BaseModel):
    project_name: str
    files: list[TerraformFile]
    generated_components: list[GeneratedComponent]
    skipped_components: list[SkippedComponent]
    warnings: list[str]
    notice: str = NOTICE


# ---------- Small helpers ----------


def _hcl_string(value: str) -> str:
    """Make text safe inside a double-quoted Terraform string (without the quotes)."""
    value = " ".join(str(value).split())  # one line
    value = value.replace("\\", "\\\\").replace('"', '\\"')
    return value.replace("${", "$${").replace("%{", "%%{")


def _comment(value: str) -> str:
    return " ".join(str(value).split())


def _slug(text: str, separator: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", separator, text.lower()).strip(separator)
    return slug or "project"


def _unique_label(raw: str, used: set[str]) -> str:
    """A valid, unique Terraform resource name made from a component id."""
    base = _slug(raw, "_")
    if base[0].isdigit():
        base = f"r_{base}"
    label, n = base, 2
    while label in used:
        label, n = f"{base}_{n}", n + 1
    used.add(label)
    return label


def categorise(component: ArchitectureComponent) -> str:
    """Guess the component's role from its type, then from its name."""
    type_key = re.sub(r"[^a-z0-9]+", "_", component.type.lower()).strip("_")
    if type_key in TYPE_CATEGORIES:
        return TYPE_CATEGORIES[type_key]
    if is_non_core_type(component.type):
        return "other"
    for text in (component.type, component.name):
        padded = " " + re.sub(r"[^a-z0-9]+", " ", text.lower()).strip() + " "
        for category, keywords in CATEGORY_KEYWORDS.items():
            if any(f" {kw} " in padded for kw in keywords):
                return category
    return "other"


def _config(component: ArchitectureComponent) -> dict:
    return {str(k).lower(): v for k, v in component.configuration.items()}


def _config_text(config: dict, keys: list[str], pattern: str):
    for key in keys:
        value = config.get(key)
        if isinstance(value, str) and re.fullmatch(pattern, value.strip().lower()):
            return value.strip().lower()
    return None


def _config_int(config: dict, keys: list[str], minimum: int = 1):
    for key in keys:
        value = config.get(key)
        if value is None or isinstance(value, bool):
            continue
        try:
            number = int(float(value))
        except (TypeError, ValueError):
            continue
        if number >= minimum:
            return number
    return None


def _variable(name: str, description: str, type_: str, default=None, sensitive: bool = False) -> str:
    extra = ""
    if default is not None:
        if isinstance(default, bool):
            literal = "true" if default else "false"
        elif isinstance(default, (int, float)):
            literal = str(default)
        else:
            literal = f'"{_hcl_string(default)}"'
        extra += f"  default     = {literal}\n"
    if sensitive:
        extra += "  sensitive   = true\n"
    return VARIABLE.substitute(name=name, description=_hcl_string(description), type=type_, extra=extra)


def _output(name: str, description: str, value: str) -> str:
    return OUTPUT.substitute(name=name, description=_hcl_string(description), value=value)


# ---------- Generator ----------

AWS_REGION_PATTERN = re.compile(r"[a-z]{2}(-[a-z]+)+-[0-9]{1,2}")


def generate_terraform(architecture: ArchitectureResult | dict, region: str | None = None) -> TerraformResult:
    """Convert an architecture into Terraform files (returned as data, not written to disk).

    `region` (for example "eu-west-1") becomes the default of the aws_region variable.
    """
    if not isinstance(architecture, ArchitectureResult):
        architecture = ArchitectureResult.model_validate(architecture)
    region = (region or "").strip().lower() or DEFAULT_REGION
    if not AWS_REGION_PATTERN.fullmatch(region):
        raise ValueError(f"'{region}' is not a valid AWS region name (expected something like eu-west-1)")

    project_slug = _slug(architecture.project_name, "-")
    warnings: list[str] = []
    skipped: list[SkippedComponent] = []
    generated: list[GeneratedComponent] = []

    main_blocks: list[str] = []
    variable_blocks: list[str] = []
    output_blocks: list[str] = []

    used_labels: set[str] = set()
    labels: dict[str, str] = {}  # component id -> terraform label
    categories: dict[str, str] = {}  # component id -> category
    components_by_id = {c.id: c for c in architecture.components}
    lb_ids: list[str] = []
    db_engines: dict[str, str] = {}
    cache_engines: dict[str, str] = {}
    pending_cdn: list[ArchitectureComponent] = []
    compute_ids: list[str] = []

    # ---- 1. one block per supported component ----
    for c in architecture.components:
        category = categorise(c)
        provider = c.provider.strip().lower()

        if provider not in SUPPORTED_PROVIDERS:
            skipped.append(
                SkippedComponent(
                    id=c.id, name=c.name, reason=f"Provider '{c.provider}' is not supported yet. Only AWS is supported."
                )
            )
            continue
        if category not in SUPPORTED_CATEGORIES:
            skipped.append(
                SkippedComponent(
                    id=c.id,
                    name=c.name,
                    reason=f"Component type '{c.type}' is not supported yet. Supported: compute, load balancer, "
                    "database, storage, cache, queue, CDN, auth.",
                )
            )
            continue

        label = _unique_label(c.id, used_labels)
        labels[c.id], categories[c.id] = label, category
        config = _config(c)
        common = dict(label=label, name=_hcl_string(c.name), comment=_comment(c.name))
        resources: list[str] = []

        if category == "compute":
            itype = _config_text(config, ["instance_type", "instance_class"], r"[a-z0-9]+\.[a-z0-9]+")
            count = _config_int(config, ["instances", "instance_count", "count", "replicas"])
            if itype is None and ("instance_type" in config or "instance_class" in config):
                warnings.append(
                    f"'{_comment(c.name)}': instance type in the configuration isn't a valid "
                    f"EC2 type, so the default {DEFAULTS['instance_type']} was used."
                )
            main_blocks.append(COMPUTE.substitute(**common))
            variable_blocks += [
                _variable(
                    f"{label}_instance_type",
                    f"EC2 instance type for {_comment(c.name)}",
                    "string",
                    itype or DEFAULTS["instance_type"],
                ),
                _variable(
                    f"{label}_instance_count",
                    f"Number of instances for {_comment(c.name)}",
                    "number",
                    count or DEFAULTS["instance_count"],
                ),
            ]
            output_blocks.append(
                _output(
                    f"{label}_instance_ids", f"IDs of the {_comment(c.name)} instances", f"aws_instance.{label}[*].id"
                )
            )
            resources = [f"aws_instance.{label}"]
            compute_ids.append(c.id)

        elif category == "load_balancer":
            main_blocks.append(LOAD_BALANCER.substitute(**common))
            output_blocks.append(
                _output(f"{label}_dns_name", f"DNS name of {_comment(c.name)}", f"aws_lb.{label}.dns_name")
            )
            resources = [f"aws_lb.{label}", f"aws_lb_target_group.{label}", f"aws_lb_listener.{label}"]
            lb_ids.append(c.id)

        elif category == "database":
            raw_engine = _config_text(config, ["engine"], r"[a-z0-9\-]+") or ""
            engine = DB_ENGINE_ALIASES.get(raw_engine, raw_engine)
            if engine not in SUPPORTED_DB_ENGINES:
                if raw_engine:
                    warnings.append(
                        f"'{_comment(c.name)}': database engine '{raw_engine}' isn't supported "
                        f"here, so {DEFAULTS['db_engine']} was used."
                    )
                engine = str(DEFAULTS["db_engine"])
            klass = _config_text(config, ["instance_class", "instance_type"], r"db\.[a-z0-9]+\.[a-z0-9]+")
            storage = _config_int(config, ["allocated_storage", "storage_gb", "storage"])
            multi_az = config.get("multi_az") is True
            db_engines[c.id] = engine
            main_blocks.append(DATABASE.substitute(**common))
            variable_blocks += [
                _variable(f"{label}_engine", f"Database engine for {_comment(c.name)}", "string", engine),
                _variable(
                    f"{label}_instance_class",
                    f"RDS instance class for {_comment(c.name)}",
                    "string",
                    klass or DEFAULTS["db_instance_class"],
                ),
                _variable(
                    f"{label}_allocated_storage",
                    f"Storage in GB for {_comment(c.name)}",
                    "number",
                    storage or DEFAULTS["db_allocated_storage"],
                ),
                _variable(
                    f"{label}_multi_az", f"Run {_comment(c.name)} across two availability zones", "bool", multi_az
                ),
            ]
            output_blocks.append(
                _output(
                    f"{label}_endpoint",
                    f"Connection endpoint of {_comment(c.name)}",
                    f"aws_db_instance.{label}.endpoint",
                )
            )
            resources = [f"aws_db_instance.{label}"]

        elif category == "cache":
            engine = _config_text(config, ["engine"], r"[a-z]+") or "redis"
            if engine not in CACHE_PORTS:
                warnings.append(
                    f"'{_comment(c.name)}': cache engine '{engine}' isn't supported here, so redis was used."
                )
                engine = "redis"
            cache_engines[c.id] = engine
            node_type = _config_text(
                config, ["node_type", "instance_type", "instance_class"], r"cache\.[a-z0-9]+\.[a-z0-9]+"
            )
            nodes = _config_int(config, ["nodes", "node_count", "num_nodes", "instances", "replicas", "count"])
            if nodes and nodes > MAX_CACHE_NODES[engine]:
                warnings.append(
                    f"'{_comment(c.name)}': {nodes} cache nodes is more than {engine} supports "
                    f"here, so {MAX_CACHE_NODES[engine]} was used."
                )
                nodes = MAX_CACHE_NODES[engine]
            cache_id = f"{project_slug}-{_slug(label, '-')}"[:40].strip("-")
            template = CACHE_REDIS if engine == "redis" else CACHE_MEMCACHED
            main_blocks.append(template.substitute(cache_id=cache_id, **common))
            variable_blocks += [
                _variable(
                    f"{label}_node_type",
                    f"ElastiCache node type for {_comment(c.name)}",
                    "string",
                    node_type or DEFAULT_CACHE_NODE_TYPE,
                ),
                _variable(f"{label}_num_nodes", f"Number of cache nodes for {_comment(c.name)}", "number", nodes or 1),
            ]
            if engine == "redis":
                output_blocks.append(
                    _output(
                        f"{label}_endpoint",
                        f"Primary endpoint of {_comment(c.name)}",
                        f"aws_elasticache_replication_group.{label}.primary_endpoint_address",
                    )
                )
                resources = [f"aws_elasticache_replication_group.{label}"]
            else:
                output_blocks.append(
                    _output(
                        f"{label}_endpoint",
                        f"Address of {_comment(c.name)}",
                        f"aws_elasticache_cluster.{label}.cluster_address",
                    )
                )
                resources = [f"aws_elasticache_cluster.{label}"]

        elif category == "queue":
            fifo = config.get("fifo") is True or config.get("type") == "fifo" or "fifo" in _comment(c.name).lower()
            queue_name = f"{project_slug}-{_slug(label, '-')}"[:75].strip("-") + (".fifo" if fifo else "")
            main_blocks.append(QUEUE.substitute(fifo="\n  fifo_queue                 = true" if fifo else "", **common))
            variable_blocks.append(
                _variable(f"{label}_queue_name", f"Name of the queue {_comment(c.name)}", "string", queue_name)
            )
            output_blocks += [
                _output(f"{label}_queue_url", f"URL of {_comment(c.name)}", f"aws_sqs_queue.{label}.url"),
                _output(f"{label}_queue_arn", f"ARN of {_comment(c.name)}", f"aws_sqs_queue.{label}.arn"),
            ]
            resources = [f"aws_sqs_queue.{label}"]

        elif category == "auth":
            main_blocks.append(AUTH.substitute(**common))
            output_blocks += [
                _output(
                    f"{label}_user_pool_id",
                    f"ID of the {_comment(c.name)} user pool",
                    f"aws_cognito_user_pool.{label}.id",
                ),
                _output(
                    f"{label}_client_id",
                    f"App client ID for {_comment(c.name)}",
                    f"aws_cognito_user_pool_client.{label}.id",
                ),
            ]
            resources = [f"aws_cognito_user_pool.{label}", f"aws_cognito_user_pool_client.{label}"]

        elif category == "cdn":
            pending_cdn.append(c)  # needs its origin (a connected load balancer or storage), found below
            continue

        else:  # storage
            bucket = f"{project_slug}-{_slug(label, '-')}"[:63].strip("-")
            main_blocks.append(STORAGE.substitute(**common))
            variable_blocks.append(
                _variable(
                    f"{label}_bucket_name",
                    f"Name of the S3 bucket for {_comment(c.name)} (must be globally unique)",
                    "string",
                    bucket,
                )
            )
            output_blocks.append(
                _output(f"{label}_bucket_arn", f"ARN of the {_comment(c.name)} bucket", f"aws_s3_bucket.{label}.arn")
            )
            resources = [f"aws_s3_bucket.{label}", f"aws_s3_bucket_public_access_block.{label}"]

        generated.append(GeneratedComponent(id=c.id, name=c.name, category=category, terraform_resources=resources))

    # ---- 2. connections: only load balancer <-> compute can be expressed ----
    handled: set[tuple[str, str]] = set()
    unexpressed = 0
    for conn in architecture.connections:
        pair = {conn.source, conn.target}
        lb = next((i for i in pair if categories.get(i) == "load_balancer"), None)
        target = next((i for i in pair if categories.get(i) == "compute"), None)
        if lb and target:
            if (lb, target) not in handled:
                handled.add((lb, target))
                main_blocks.append(
                    TARGET_ATTACHMENT.substitute(
                        lb_label=labels[lb],
                        target_label=labels[target],
                        lb_comment=_comment(components_by_id[lb].name),
                        target_comment=_comment(components_by_id[target].name),
                    )
                )
                for g in generated:
                    if g.id == lb:
                        g.terraform_resources.append(f"aws_lb_target_group_attachment.{labels[lb]}_{labels[target]}")
        else:
            unexpressed += 1
    if unexpressed:
        warnings.append(
            f"{unexpressed} connection(s) were not turned into Terraform resources (for example "
            "links to caches, queues or auth services). Security group rules only cover "
            "load balancer, compute and database links, so add application settings and any "
            "other access rules yourself."
        )
    for lb in lb_ids:
        if not any(pair[0] == lb for pair in handled):
            warnings.append(
                f"'{_comment(components_by_id[lb].name)}' has no connected compute component, "
                "so its target group is empty."
            )

    # ---- 2b. one security group per load balancer / compute / database ----
    def neighbours(cid: str, wanted: str) -> list[str]:
        out: list[str] = []
        for conn in architecture.connections:
            other = conn.target if conn.source == cid else conn.source if conn.target == cid else None
            if other and categories.get(other) == wanted and labels[other] not in out:
                out.append(labels[other])
        return out

    for c in architecture.components:
        cat = categories.get(c.id)
        if cat not in ("load_balancer", "compute", "database", "cache"):
            continue
        label, nm = labels[c.id], _hcl_string(c.name)
        if cat == "load_balancer":
            rule = _ingress(80, [], open_to_world=True)
            what = "Public HTTP access to the load balancer"
        elif cat == "compute":
            rule = _ingress(80, neighbours(c.id, "load_balancer"))
            what = "Traffic to the application servers"
        elif cat == "cache":
            rule = _ingress(CACHE_PORTS[cache_engines[c.id]], neighbours(c.id, "compute"))
            what = "Cache access from the application servers"
        else:
            port = 3306 if db_engines.get(c.id) in ("mysql", "mariadb") else 5432
            rule = _ingress(port, neighbours(c.id, "compute"))
            what = "Database access from the application servers"
        main_blocks.append(
            SECURITY_GROUP.substitute(label=label, name=nm, comment=_comment(c.name), description=what, ingress=rule)
        )

    # ---- 2c. CDNs: the origin is a connected load balancer (preferred) or storage bucket ----
    def neighbour_ids(cid: str, wanted: str) -> list[str]:
        out: list[str] = []
        for conn in architecture.connections:
            other = conn.target if conn.source == cid else conn.source if conn.target == cid else None
            if other and categories.get(other) == wanted and other not in out:
                out.append(other)
        return out

    for c in pending_cdn:
        label = labels[c.id]
        common = dict(label=label, name=_hcl_string(c.name), comment=_comment(c.name))
        lb_origin = neighbour_ids(c.id, "load_balancer")
        s3_origin = neighbour_ids(c.id, "storage")
        if lb_origin:
            origin = lb_origin[0]
            main_blocks.append(
                CDN_LB.substitute(
                    origin_label=labels[origin],
                    origin_comment=_comment(components_by_id[origin].name),
                    cache_settings=CDN_LB_SETTINGS,
                    **common,
                )
            )
            resources = [f"aws_cloudfront_distribution.{label}"]
            warnings.append(
                f"'{_comment(c.name)}' forwards every request to the load balancer without "
                "caching. Add cache behaviours for static paths if you want edge caching."
            )
        elif s3_origin:
            origin = s3_origin[0]
            main_blocks.append(
                CDN_S3.substitute(
                    origin_label=labels[origin],
                    origin_comment=_comment(components_by_id[origin].name),
                    cache_settings=CDN_S3_SETTINGS,
                    **common,
                )
            )
            resources = [
                f"aws_cloudfront_origin_access_control.{label}",
                f"aws_cloudfront_distribution.{label}",
                f"aws_s3_bucket_policy.{label}_cdn",
            ]
        else:
            categories.pop(c.id, None)
            labels.pop(c.id, None)
            skipped.append(
                SkippedComponent(
                    id=c.id,
                    name=c.name,
                    reason="A CDN needs a connected load balancer or storage component to use as its origin.",
                )
            )
            continue
        output_blocks.append(
            _output(
                f"{label}_domain_name",
                f"Domain name of {_comment(c.name)}",
                f"aws_cloudfront_distribution.{label}.domain_name",
            )
        )
        generated.append(GeneratedComponent(id=c.id, name=c.name, category="cdn", terraform_resources=resources))
        warnings.append(
            f"'{_comment(c.name)}' uses the default CloudFront certificate and domain. Add your own "
            "domain and certificate for production."
        )

    # ---- 3. shared variables, only the ones the generated resources need ----
    base_variables = [
        _variable("aws_region", "AWS region to deploy into", "string", region),
        _variable("project_name", "Project name used in resource tags", "string", project_slug),
    ]
    cats = set(categories.values())
    if cats & {"compute", "load_balancer"}:
        base_variables.append(
            _variable("subnet_ids", "Subnet IDs to use (a load balancer needs at least two)", "list(string)")
        )
    if cats & {"compute", "load_balancer", "database", "cache"}:
        base_variables.append(_variable("vpc_id", "VPC ID for the security groups and target groups", "string"))
        base_variables.append(
            _variable(
                "allowed_cidr_blocks",
                "CIDR blocks allowed to reach resources that have no connected source in the design",
                "list(string)",
                None,
            ).replace("}\n", '  default     = ["10.0.0.0/16"]\n}\n')
        )
    if "compute" in cats:
        base_variables.append(_variable("ami_id", "AMI ID for the EC2 instances", "string"))
    if "database" in cats:
        base_variables += [
            _variable("db_username", "Master username for the databases", "string", "dbadmin"),
            _variable(
                "db_password", "Master password for the databases. Do not commit this value.", "string", sensitive=True
            ),
        ]

    if cats & {"compute", "load_balancer", "database", "cache"}:
        warnings.append(
            "Security groups were generated from the connections in the design, but the load "
            "balancer still listens on plain HTTP (port 80). Add HTTPS and review every rule."
        )
    if not generated:
        warnings.append("No supported components were found, so main.tf has no resources.")
    if "cache" in cats:
        warnings.append(
            "Caches use the account's default subnet group, and Redis uses in-transit encryption, "
            "so clients must connect with TLS. Review networking before deploying."
        )
    if "database" in cats:
        warnings.append(
            "Databases are created with skip_final_snapshot = true, so deleting one loses its data. "
            "Set it to false for production."
        )
        warnings.append(
            "Databases are created without a custom subnet group, so they use the account's "
            "default one. Review networking before deploying."
        )

    # ---- 4. assemble the four files ----
    header = (
        f"# Generated by SysDesign AI for project: {_comment(architecture.project_name)}\n"
        "# Starter code: review it, then run 'terraform validate' and 'terraform plan'.\n\n"
    )

    def join(blocks: list[str], empty: str) -> str:
        return "\n".join(blocks) if blocks else empty

    files = [
        TerraformFile(
            path=f"{OUTPUT_DIR}/main.tf", content=header + join(main_blocks, "# No supported resources to create.\n")
        ),
        TerraformFile(path=f"{OUTPUT_DIR}/variables.tf", content=header + join(base_variables + variable_blocks, "")),
        TerraformFile(path=f"{OUTPUT_DIR}/outputs.tf", content=header + join(output_blocks, "# No outputs.\n")),
        TerraformFile(
            path=f"{OUTPUT_DIR}/providers.tf",
            content=header
            + PROVIDERS_TF.substitute(terraform_version=TERRAFORM_VERSION, aws_provider_version=AWS_PROVIDER_VERSION),
        ),
    ]

    return TerraformResult(
        project_name=architecture.project_name,
        files=files,
        generated_components=generated,
        skipped_components=skipped,
        warnings=warnings,
    )


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
                "configuration": {"instance_type": "t3.small", "instances": 2},
            },
            {
                "id": "db-1",
                "name": "Primary Database",
                "type": "database",
                "provider": "aws",
                "configuration": {"engine": "postgres", "multi_az": True},
            },
            {"id": "assets", "name": "Asset Storage", "type": "storage", "provider": "aws"},
            {"id": "cache-1", "name": "Session Cache", "type": "cache", "provider": "aws"},
        ],
        connections=[
            {"source": "lb-1", "target": "api-1"},
            {"source": "api-1", "target": "db-1"},
        ],
    )
    result = generate_terraform(demo)
    for f in result.files:
        print(f"===== {f.path} =====\n{f.content}")
    print("Skipped:", [s.model_dump() for s in result.skipped_components])
    print("Warnings:", result.warnings)
