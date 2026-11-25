from fastapi import APIRouter

from app.config import APP_NAME, VERSION
from app.schemas.models import HealthResponse, RootResponse

router = APIRouter()


@router.get("/", response_model=RootResponse)
def root():
    return RootResponse(name=APP_NAME, version=VERSION, message="Welcome to the SysDesign AI API")


@router.get("/health", response_model=HealthResponse)
def health():
    return HealthResponse(status="ok")
