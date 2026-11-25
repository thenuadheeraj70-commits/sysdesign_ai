import re

from pydantic import BaseModel, Field, field_validator, model_validator

from app.schemas.models import ArchitectureResult, Requirements

_EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,}$")


class Credentials(BaseModel):
    email: str = Field(..., max_length=320)
    password: str = Field(..., min_length=8, max_length=128)

    @field_validator("email")
    @classmethod
    def valid_email(cls, v: str) -> str:
        v = v.strip().lower()
        if not _EMAIL.match(v):
            raise ValueError("Enter a valid email address")
        return v


class UserOut(BaseModel):
    id: int
    email: str


class AuthResponse(BaseModel):
    token: str
    user: UserOut


class Position(BaseModel):
    """Where a component sits in the diagram (view-only, not part of the architecture)."""

    x: float = Field(..., ge=-1e6, le=1e6)
    y: float = Field(..., ge=-1e6, le=1e6)


class VariantData(BaseModel):
    """One design inside a project: the original, or an alternative to compare against it."""

    id: str = Field(..., min_length=1, max_length=40, pattern=r"^[A-Za-z0-9_-]+$")
    name: str = Field(..., min_length=1, max_length=60)
    architecture: ArchitectureResult
    positions: dict[str, Position] | None = Field(default=None, max_length=100)
    traffic_scale: float = Field(default=1.0, gt=0, le=1000)  # share of the project's traffic this design serves


MAX_VARIANTS = 6


class ProjectIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    prompt: str = Field(default="", max_length=5000)
    architecture: ArchitectureResult
    requirements: Requirements | None = None
    positions: dict[str, Position] | None = Field(default=None, max_length=100)
    # Older clients send one design (`architecture`); newer ones send every variant and which is open.
    variants: list[VariantData] | None = Field(default=None, min_length=1, max_length=MAX_VARIANTS)
    active_variant_id: str | None = Field(default=None, max_length=40)

    @model_validator(mode="after")
    def check_variants(self):
        if self.variants is not None:
            ids = [v.id for v in self.variants]
            if len(set(ids)) != len(ids):
                raise ValueError("Variant ids must be unique")
            if self.active_variant_id not in ids:
                raise ValueError("The open variant must be one of the variants")
        return self


class ProjectRename(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)


class ProjectSummary(BaseModel):
    id: int
    name: str
    updated_at: str
    deleted_at: str | None = None


class ProjectOut(ProjectSummary):
    prompt: str
    architecture: ArchitectureResult
    requirements: Requirements | None = None
    positions: dict[str, Position] | None = None
    variants: list[VariantData] | None = None
    active_variant_id: str | None = None


class ProjectPage(BaseModel):
    items: list[ProjectSummary]
    total: int
    limit: int
    offset: int
