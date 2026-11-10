from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any

from fastapi import Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from database import get_conn


JWT_SECRET = os.getenv("JWT_SECRET") or os.getenv("AUTH_JWT_SECRET") or "zggeo-local-dev-jwt-secret-change-me"
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_MINUTES = int(os.getenv("JWT_EXPIRE_MINUTES", "10080"))
PUBLIC_AUTH_PATHS = {
    "/health",
    "/health/ready",
    "/auth/login",
    "/auth/register",
    "/auth/register/send-code",
    "/api/zggeo/auth/login",
    "/api/zggeo/auth/register",
    "/api/zggeo/auth/register/send-code",
    "/client-events",
    "/api/zggeo/client-events",
}
API_PROXY_PREFIXES = ("/api/zggeo",)
CLIENT_API_PREFIXES = (
    "/leads",
    "/consultation-leads",
    "/keyword-expansion",
    "/keyword-prompts",
    "/model-visibility",
    "/questions",
    "/tasks",
    "/reports",
    "/geo",
    "/content/tasks",
    "/content/questions/mine",
    "/content/agent-runs",
    "/content/image-groups",
    "/content/images",
    "/content/articles",
    "/content/article-library",
    "/billing",
    "/client-events",
    "/models/providers",
    "/agent/workflows",
    "/auth/change-password",
)
CLIENT_API_DENY_EXACT_PATHS = {
    "/agent/workflows/n8n-events",
}
CLIENT_API_DENY_SUFFIXES = (
    "/n8n-callback",
)
CLIENT_API_ALLOW_METHOD_PATHS = {
    ("GET", "/media-market/filters"),
    ("GET", "/media-market/media"),
    ("POST", "/media-market/title-check"),
    ("POST", "/media-market/upload-image"),
    ("POST", "/media-market/orders"),
}


def _is_client_api_allowed(path: str, method: str = "GET") -> bool:
    if (method.upper(), path) in CLIENT_API_ALLOW_METHOD_PATHS:
        return True
    if path in CLIENT_API_DENY_EXACT_PATHS:
        return False
    if any(path.endswith(suffix) for suffix in CLIENT_API_DENY_SUFFIXES):
        return False
    return any(path == prefix or path.startswith(f"{prefix}/") for prefix in CLIENT_API_PREFIXES)


def _auth_path_variants(path: str) -> set[str]:
    variants = {path}
    for prefix in API_PROXY_PREFIXES:
        if path.startswith(f"{prefix}/"):
            stripped = path.removeprefix(prefix) or "/"
            variants.add(stripped)
    return variants


def _is_public_auth_path(path: str) -> bool:
    return any(variant in PUBLIC_AUTH_PATHS for variant in _auth_path_variants(path))


def _extract_bearer_token(request: Request) -> str | None:
    auth_header = request.headers.get("authorization") or ""
    if auth_header.lower().startswith("bearer "):
        return auth_header.split(" ", 1)[1].strip()
    return None


def _base64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")


def _base64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("utf-8"))


def _legacy_sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _is_bcrypt_hash(password_hash: str | None) -> bool:
    return bool(password_hash and password_hash.startswith(("$2a$", "$2b$", "$2y$")))


def is_legacy_password_hash(password_hash: str | None) -> bool:
    if not password_hash or _is_bcrypt_hash(password_hash):
        return False
    if len(password_hash) != 64:
        return False
    return all(char in "0123456789abcdef" for char in password_hash.lower())


def hash_password(password: str) -> str:
    try:
        import bcrypt
    except ModuleNotFoundError as exc:
        raise RuntimeError("bcrypt is required for password hashing; please install requirements.txt") from exc
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str | None) -> bool:
    if not password_hash:
        return False
    if _is_bcrypt_hash(password_hash):
        try:
            import bcrypt
        except ModuleNotFoundError:
            return False
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    if is_legacy_password_hash(password_hash):
        return hmac.compare_digest(_legacy_sha256(password), password_hash)
    return False


def create_access_token(user: dict[str, Any]) -> str:
    now = int(time.time())
    payload = {
        "sub": str(user.get("id") or ""),
        "role": str(user.get("role") or ""),
        "tenant_id": str(user.get("tenant_id") or ""),
        "iat": now,
        "exp": now + JWT_EXPIRE_MINUTES * 60,
    }
    header = {"alg": JWT_ALGORITHM, "typ": "JWT"}
    signing_input = ".".join(
        [
            _base64url_encode(json.dumps(header, separators=(",", ":")).encode("utf-8")),
            _base64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8")),
        ]
    )
    signature = hmac.new(JWT_SECRET.encode("utf-8"), signing_input.encode("utf-8"), hashlib.sha256).digest()
    return f"{signing_input}.{_base64url_encode(signature)}"


def _decode_access_token(token: str) -> dict[str, Any] | None:
    parts = token.split(".")
    if len(parts) != 3:
        return None
    signing_input = ".".join(parts[:2])
    expected = hmac.new(JWT_SECRET.encode("utf-8"), signing_input.encode("utf-8"), hashlib.sha256).digest()
    try:
        actual = _base64url_decode(parts[2])
    except Exception:  # noqa: BLE001
        return None
    if not hmac.compare_digest(actual, expected):
        return None
    try:
        payload = json.loads(_base64url_decode(parts[1]).decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None
    if int(payload.get("exp") or 0) < int(time.time()):
        return None
    return payload


def _user_from_id(user_id: str | None) -> dict[str, Any] | None:
    if not user_id:
        return None
    with get_conn() as conn:
        row = conn.execute(
            """
            select u.id, u.username, u.name, u.email, u.phone, u.role, u.status, u.bound_lead_id, u.must_change_password,
                   t.id as tenant_id, t.name as tenant_name, t.plan, t.credit_balance
            from app_users u
            join app_tenants t on t.id = u.tenant_id
            where u.id = %s and u.status = 'active'
            """,
            (user_id,),
        ).fetchone()
    return dict(row) if row else None


def _user_from_token(token: str | None) -> dict[str, Any] | None:
    if not token:
        return None
    if token.startswith("local-"):
        return _user_from_id(token.removeprefix("local-").strip())
    payload = _decode_access_token(token)
    return _user_from_id(str(payload.get("sub") or "")) if payload else None


async def require_authentication(request: Request, call_next):
    path = request.url.path
    if (
        request.method == "OPTIONS"
        or _is_public_auth_path(path)
        or path.startswith("/docs")
        or path.startswith("/redoc")
        or path.startswith("/openapi")
    ):
        return await call_next(request)

    user = _user_from_token(_extract_bearer_token(request))
    if not user:
        return JSONResponse(status_code=401, content={"detail": "请先登录"})
    if str(user.get("role") or "").lower() == "client" and not _is_client_api_allowed(path, request.method):
        return JSONResponse(status_code=403, content={"detail": "客户账号无权访问该内部接口"})
    request.state.current_user = user
    return await call_next(request)


def current_user(request: Request) -> dict[str, Any]:
    user = getattr(request.state, "current_user", None)
    if not user:
        raise HTTPException(status_code=401, detail="请先登录")
    return user


def optional_current_user(request: Request) -> dict[str, Any] | None:
    user = getattr(request.state, "current_user", None)
    if user:
        return user
    return _user_from_token(_extract_bearer_token(request))


def require_admin(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if str(user.get("role") or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="当前账号无管理员权限")
    return user


def _is_admin(user: dict[str, Any] | None) -> bool:
    return str((user or {}).get("role") or "").lower() == "admin"


def _tenant_id(user: dict[str, Any] | None) -> str | None:
    tenant_id = (user or {}).get("tenant_id")
    return str(tenant_id) if tenant_id else None


def _bound_lead_id(user: dict[str, Any] | None) -> str | None:
    lead_id = (user or {}).get("bound_lead_id")
    return str(lead_id) if lead_id else None


def _is_client(user: dict[str, Any] | None) -> bool:
    return str((user or {}).get("role") or "").lower() == "client"


def _tenant_where(user: dict[str, Any], column: str = "tenant_id") -> tuple[str, list[Any]]:
    if _is_admin(user):
        return "", []
    tenant_id = _tenant_id(user)
    if not tenant_id:
        raise HTTPException(status_code=403, detail="当前账号未绑定客户资产空间")
    return f" and {column} = %s", [tenant_id]
