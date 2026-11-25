from fastapi import APIRouter, HTTPException, Query, Response

from app.schemas.models import ArchitectureResult, GenerateCodeResult
from app.services.code_generation import generate_code
from app.services.zip_export import build_infrastructure_zip

router = APIRouter(prefix="/api")

REGION_HELP = "AWS region used as the Terraform default, for example eu-west-1."


@router.post("/generate-code", response_model=GenerateCodeResult)
def generate_infrastructure_code(
    architecture: ArchitectureResult, region: str | None = Query(None, max_length=30, description=REGION_HELP)
):
    try:
        return generate_code(architecture, region=region)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/generate-code/zip", response_class=Response)
def download_infrastructure_zip(
    architecture: ArchitectureResult, region: str | None = Query(None, max_length=30, description=REGION_HELP)
):
    try:
        data, filename = build_infrastructure_zip(architecture, region=region)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "no-store"},
    )
