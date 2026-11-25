import os

from fastapi.testclient import TestClient

from app import config
from app.main import app
from app.services import ai_generator, requirements_extractor
from app.services.demo import demo_architecture
from app.services.terraform_generator import generate_terraform

client = TestClient(app, raise_server_exceptions=False)


def test_demo_mode_needs_no_api_key(monkeypatch):
    monkeypatch.setattr(config, "DEMO_MODE", True)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert len(ai_generator.generate_architecture("anything").components) >= 6
    assert requirements_extractor.extract_requirements("anything").expected_users == 100000


def test_missing_key_message_mentions_demo_mode(monkeypatch):
    monkeypatch.setattr(config, "DEMO_MODE", False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    try:
        ai_generator.generate_architecture("a shop")
    except ai_generator.AIConfigError as exc:
        assert "DEMO_MODE" in str(exc)
    else:
        raise AssertionError("expected AIConfigError")


def test_secret_key_is_generated_once_and_reused(tmp_path, monkeypatch):
    monkeypatch.delenv("SECRET_KEY", raising=False)
    monkeypatch.setattr(config, "DB_PATH", str(tmp_path / "x" / "db.sqlite"))
    key1, ephemeral1 = config._load_secret_key()
    key2, ephemeral2 = config._load_secret_key()
    assert key1 == key2 and len(key1) >= 32 and not ephemeral1 and not ephemeral2
    assert os.path.exists(tmp_path / "x" / ".secret_key")


def test_terraform_security_groups_follow_connections():
    tf = generate_terraform(demo_architecture())
    main = next(f.content for f in tf.files if f.path.endswith("main.tf"))
    assert 'resource "aws_security_group" "api"' in main
    assert "security_groups = [aws_security_group.lb.id]" in main  # app only reachable from the LB
    assert (
        "security_groups = [aws_security_group.api.id, aws_security_group.worker.id]" in main
    )  # DB only from its app servers
    assert "from_port       = 5432" in main
    assert "vpc_security_group_ids" in main
    variables = next(f.content for f in tf.files if f.path.endswith("variables.tf"))
    assert 'variable "vpc_id"' in variables and 'variable "allowed_cidr_blocks"' in variables


def test_startup_messages(monkeypatch):
    monkeypatch.setattr(config, "DEMO_MODE", False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert any("ANTHROPIC_API_KEY" in text for _, text in config.startup_messages())
    monkeypatch.setenv("ANTHROPIC_API_KEY", "your-api-key-here")  # the .env.example placeholder
    assert any("placeholder" in text for _, text in config.startup_messages())
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-real-looking-value")
    assert not any("ANTHROPIC_API_KEY" in text for _, text in config.startup_messages())
    monkeypatch.setattr(config, "DEMO_MODE", True)
    assert any("DEMO_MODE" in text for _, text in config.startup_messages())


def test_server_starts_and_logs_with_the_lifespan_hook(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with TestClient(app) as c:  # entering the context runs startup
        assert c.get("/health").status_code == 200
