from __future__ import annotations

from typing import Any

from fastapi import Depends, HTTPException, APIRouter

from auth import require_admin
from model_gateway import (
    ModelGatewayError,
    generate_text,
    list_model_providers,
    run_model_regression,
    test_model_provider,
)
from models import ModelGenerateRequest, ModelRegressionRequest, ModelTestRequest

router = APIRouter()


@router.get("/models/providers")
def get_model_providers() -> dict[str, Any]:
    providers = list_model_providers()
    return {
        "providers": providers,
        "summary": {
            "total": len(providers),
            "configured": len([p for p in providers if p["configured"]]),
            "testable": len([p for p in providers if p["testable"]]),
        },
    }


@router.post("/models/test")
def test_model(payload: ModelTestRequest, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    return test_model_provider(payload.provider)


@router.post("/models/generate")
def generate_with_model(payload: ModelGenerateRequest, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    try:
        return generate_text(
            payload.prompt,
            provider_key=payload.provider,
            system_prompt=payload.system_prompt,
            temperature=payload.temperature,
            max_tokens=payload.max_tokens,
        )
    except ModelGatewayError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/models/regression")
def run_models_regression(payload: ModelRegressionRequest, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    try:
        return run_model_regression(
            project_name=payload.project_name,
            domain=payload.domain,
            questions=payload.questions,
            provider_keys=payload.providers or None,
            source_probe_enabled=payload.source_probe_enabled,
        )
    except ModelGatewayError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
