from app.schemas.models import ArchitectureResult
from app.services.terraform_generator import generate_terraform


def build(components, connections=()):
    arch = ArchitectureResult.model_validate(
        {
            "project_name": "Shop",
            "components": components,
            "connections": [{"source": a, "target": b} for a, b in connections],
        }
    )
    result = generate_terraform(arch)
    files = {f.path.split("/")[-1]: f.content for f in result.files}
    return result, files


def comp(cid, name, type_, **config):
    return {"id": cid, "name": name, "type": type_, "provider": "aws", "configuration": config}


def test_memcached_and_node_cap():
    result, files = build(
        [comp("api", "API", "compute"), comp("c", "Cache", "cache", engine="memcached", nodes=99)], [("api", "c")]
    )
    assert 'resource "aws_elasticache_cluster" "c"' in files["main.tf"]
    assert "from_port       = 11211" in files["main.tf"]
    assert "default     = 40" in files["variables.tf"]
    assert any("40 was used" in w for w in result.warnings)


def test_fifo_queue():
    _, files = build([comp("q", "Order Queue", "queue", fifo=True)])
    assert "fifo_queue                 = true" in files["main.tf"]
    assert '.fifo"' in files["variables.tf"]


def test_cdn_in_front_of_storage_uses_access_control_and_bucket_policy():
    result, files = build([comp("cdn", "CDN", "cdn"), comp("s", "Assets", "storage")], [("cdn", "s")])
    main = files["main.tf"]
    assert "aws_cloudfront_origin_access_control" in main
    assert 'resource "aws_s3_bucket_policy" "cdn_cdn"' in main
    assert '"${aws_s3_bucket.s.arn}/*"' in main  # real Terraform interpolation survived templating
    assert "cache_policy_id" in main
    assert (
        "aws_s3_bucket_policy.cdn_cdn"
        in next(g for g in result.generated_components if g.id == "cdn").terraform_resources
    )


def test_cdn_without_origin_is_skipped_with_reason():
    result, files = build([comp("cdn", "CDN", "cdn"), comp("a", "API", "compute")])
    assert [s.id for s in result.skipped_components] == ["cdn"]
    assert "origin" in result.skipped_components[0].reason
    assert "cloudfront" not in files["main.tf"]


def test_auth_user_pool_and_outputs():
    _, files = build([comp("auth", "Auth", "auth")])
    assert 'resource "aws_cognito_user_pool" "auth"' in files["main.tf"]
    assert "auth_user_pool_id" in files["outputs.tf"] and "auth_client_id" in files["outputs.tf"]


def test_cache_security_group_only_from_connected_compute():
    _, files = build([comp("api", "API", "compute"), comp("c", "Cache", "cache")], [("api", "c")])
    assert "from_port       = 6379" in files["main.tf"]
    assert "security_groups = [aws_security_group.api.id]" in files["main.tf"]
