"""Request and response models for the AI assistant: refine, review, import, usage and feedback."""

from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.models import ArchitecturePatch, ArchitectureResult, Requirements

Source = Literal["ai", "rules", "demo"]


class RefineRequest(BaseModel):
    architecture: ArchitectureResult
    requirements: Requirements = Field(default_factory=Requirements)
    instruction: str = Field(..., min_length=1, max_length=500)


class PatchDiff(BaseModel):
    """What a patch would do, in words, for review before it is applied."""

    added: list[str] = Field(default_factory=list)
    removed: list[str] = Field(default_factory=list)
    changed: list[str] = Field(default_factory=list)


class RefineResponse(BaseModel):
    summary: str
    patch: ArchitecturePatch | None = None  # None when nothing can be changed (see summary)
    diff: PatchDiff = Field(default_factory=PatchDiff)
    source: Source
    cached: bool = False


class RegenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=5000)
    architecture: ArchitectureResult


class ReviewFinding(BaseModel):
    id: str
    severity: Literal["high", "medium", "low"]
    title: str
    detail: str
    recommendation: str
    affected_components: list[str] = Field(default_factory=list)
    fix: ArchitecturePatch | None = None


class ReviewRequest(BaseModel):
    architecture: ArchitectureResult
    requirements: Requirements = Field(default_factory=Requirements)


class ReviewResponse(BaseModel):
    summary: str
    findings: list[ReviewFinding]
    source: Source
    cached: bool = False


class DocumentRequest(BaseModel):
    filename: str = Field(..., min_length=1, max_length=200)
    media_type: str = Field(..., max_length=100)
    data_base64: str = Field(..., min_length=1, max_length=8_000_000)


class DocumentResponse(BaseModel):
    text: str
    source: Literal["file", "ai", "demo"]
    truncated: bool = False
    note: str = ""


class UsageByTask(BaseModel):
    task: str
    requests: int
    cached: int
    input_tokens: int
    output_tokens: int


class UsageResponse(BaseModel):
    month: str
    requests: int
    cached_requests: int
    input_tokens: int
    output_tokens: int
    tokens_used: int
    quota: int  # 0 = unlimited
    by_task: list[UsageByTask]
    provider: str = ""  # anthropic or gemini
    models: dict[str, str]
    fallback_model: str | None
    demo_mode: bool


class FeedbackIn(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=5000)
    project_name: str = Field(default="", max_length=200)
    rating: Literal[-1, 1]
    comment: str = Field(default="", max_length=1000)


class HistoryItem(BaseModel):
    id: int
    prompt: str
    project_name: str
    rating: int | None
    comment: str
    created_at: str


class HistoryResponse(BaseModel):
    items: list[HistoryItem]


class RecordGenerationIn(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=5000)
    project_name: str = Field(default="", max_length=200)
