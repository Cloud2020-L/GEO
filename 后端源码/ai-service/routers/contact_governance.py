from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query

from auth import current_user
from models import (
    ContactAuditRunRequest,
    ContactDeploymentPackageRequest,
    ContactGovernanceProfileRequest,
    ContactGovernanceProfileUpdateRequest,
    ContactVisibilityRunRequest,
)
from services import contact_governance_service

router = APIRouter(prefix="/contact-governance")


@router.post("/profiles")
def create_contact_profile(
    payload: ContactGovernanceProfileRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return contact_governance_service.create_profile(payload, user)


@router.get("/profiles")
def list_contact_profiles(
    limit: int = Query(default=50, ge=1, le=100),
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    return contact_governance_service.list_profiles(user, limit)


@router.get("/profiles/{profile_id}")
def get_contact_profile(profile_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return contact_governance_service.get_profile(profile_id, user)


@router.put("/profiles/{profile_id}")
def update_contact_profile(
    profile_id: str,
    payload: ContactGovernanceProfileUpdateRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return contact_governance_service.update_profile(profile_id, payload, user)


@router.delete("/profiles/{profile_id}")
def delete_contact_profile(profile_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return contact_governance_service.delete_profile(profile_id, user)


@router.post("/audit-runs")
def create_contact_audit_run(
    payload: ContactAuditRunRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return contact_governance_service.create_audit_run(payload, user)


@router.get("/audit-runs/{run_id}")
def get_contact_audit_run(run_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return contact_governance_service.get_audit_run(run_id, user)


@router.post("/visibility-runs")
def create_contact_visibility_run(
    payload: ContactVisibilityRunRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return contact_governance_service.create_visibility_run(payload, user)


@router.get("/visibility-runs/{run_id}")
def get_contact_visibility_run(run_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return contact_governance_service.get_visibility_run(run_id, user)


@router.post("/deployment-package")
def create_contact_deployment_package(
    payload: ContactDeploymentPackageRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return contact_governance_service.build_deployment_package(payload, user)
