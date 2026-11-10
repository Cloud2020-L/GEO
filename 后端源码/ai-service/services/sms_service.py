from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
from typing import Any

from fastapi import HTTPException

import config
from auth import JWT_SECRET
from database import get_conn
from user_identity import normalize_mainland_phone, phone_to_e164


log = logging.getLogger(__name__)
REGISTER_SCENE = "register"
MAX_VERIFY_ATTEMPTS = 5


def _digest(value: str) -> str:
    return hmac.new(JWT_SECRET.encode("utf-8"), value.encode("utf-8"), hashlib.sha256).hexdigest()


def _phone_hash(phone: str) -> str:
    return _digest(f"phone:{phone}")


def _code_hash(phone: str, code: str) -> str:
    return _digest(f"sms-code:{phone}:{code}")


def _generate_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


class SmsProvider:
    name = "base"

    def send_register_code(self, phone: str, code: str) -> str | None:
        raise NotImplementedError


class MockSmsProvider(SmsProvider):
    name = "mock"

    def send_register_code(self, phone: str, code: str) -> str | None:
        log.warning("[mock sms] register code for %s is %s", phone, code)
        return f"mock-{secrets.token_hex(6)}"


class TencentSmsProvider(SmsProvider):
    name = "tencent"

    def send_register_code(self, phone: str, code: str) -> str | None:
        missing = [
            key
            for key, value in [
                ("TENCENTCLOUD_SECRET_ID", config.TENCENTCLOUD_SECRET_ID),
                ("TENCENTCLOUD_SECRET_KEY", config.TENCENTCLOUD_SECRET_KEY),
                ("TENCENT_SMS_SDK_APP_ID", config.TENCENT_SMS_SDK_APP_ID),
                ("TENCENT_SMS_SIGN_NAME", config.TENCENT_SMS_SIGN_NAME),
                ("TENCENT_SMS_TEMPLATE_ID", config.TENCENT_SMS_TEMPLATE_ID),
            ]
            if not value
        ]
        if missing:
            raise HTTPException(status_code=503, detail=f"腾讯云短信配置缺失：{', '.join(missing)}")

        try:
            from tencentcloud.common import credential
            from tencentcloud.common.exception.tencent_cloud_sdk_exception import TencentCloudSDKException
            from tencentcloud.common.profile.client_profile import ClientProfile
            from tencentcloud.common.profile.http_profile import HttpProfile
            from tencentcloud.sms.v20210111 import models, sms_client
        except ModuleNotFoundError as exc:
            raise HTTPException(status_code=503, detail="缺少 tencentcloud-sdk-python 依赖") from exc

        try:
            cred = credential.Credential(config.TENCENTCLOUD_SECRET_ID, config.TENCENTCLOUD_SECRET_KEY)
            http_profile = HttpProfile()
            http_profile.endpoint = "sms.tencentcloudapi.com"
            client_profile = ClientProfile()
            client_profile.httpProfile = http_profile
            client = sms_client.SmsClient(cred, config.TENCENT_SMS_REGION, client_profile)

            req = models.SendSmsRequest()
            req.PhoneNumberSet = [phone_to_e164(phone)]
            req.SmsSdkAppId = config.TENCENT_SMS_SDK_APP_ID
            req.SignName = config.TENCENT_SMS_SIGN_NAME
            req.TemplateId = config.TENCENT_SMS_TEMPLATE_ID
            req.TemplateParamSet = [code]

            resp = client.SendSms(req)
            status_set = getattr(resp, "SendStatusSet", None) or []
            first_status = status_set[0] if status_set else None
            status_code = getattr(first_status, "Code", "") if first_status else ""
            if status_code != "Ok":
                message = getattr(first_status, "Message", "") if first_status else "腾讯云未返回发送状态"
                raise HTTPException(status_code=502, detail=f"腾讯云短信发送失败：{status_code or message}")
            return getattr(first_status, "SerialNo", None) or getattr(resp, "RequestId", None)
        except TencentCloudSDKException as exc:
            raise HTTPException(status_code=502, detail=f"腾讯云短信调用失败：{exc}") from exc


def _provider() -> SmsProvider:
    if config.SMS_PROVIDER == "tencent":
        return TencentSmsProvider()
    return MockSmsProvider()


def _assert_send_allowed(phone_hash: str, ip: str | None) -> None:
    with get_conn() as conn:
        recent = conn.execute(
            """
            select id
            from auth_sms_codes
            where scene = %s
              and phone_hash = %s
              and created_at > now() - (%s * interval '1 second')
            order by created_at desc
            limit 1
            """,
            (REGISTER_SCENE, phone_hash, config.SMS_CODE_RESEND_SECONDS),
        ).fetchone()
        if recent:
            raise HTTPException(status_code=429, detail=f"验证码已发送，请 {config.SMS_CODE_RESEND_SECONDS} 秒后再试")

        phone_count = conn.execute(
            """
            select count(*) as count
            from auth_sms_codes
            where scene = %s
              and phone_hash = %s
              and created_at > now() - interval '1 hour'
            """,
            (REGISTER_SCENE, phone_hash),
        ).fetchone()
        if int(phone_count["count"] or 0) >= config.SMS_CODE_MAX_PER_PHONE_PER_HOUR:
            raise HTTPException(status_code=429, detail="该手机号验证码发送过于频繁，请稍后再试")

        if ip:
            ip_count = conn.execute(
                """
                select count(*) as count
                from auth_sms_codes
                where scene = %s
                  and ip = %s
                  and created_at > now() - interval '1 hour'
                """,
                (REGISTER_SCENE, ip),
            ).fetchone()
            if int(ip_count["count"] or 0) >= config.SMS_CODE_MAX_PER_IP_PER_HOUR:
                raise HTTPException(status_code=429, detail="当前网络验证码发送过于频繁，请稍后再试")


def send_register_code(raw_phone: str, ip: str | None = None) -> dict[str, Any]:
    phone = normalize_mainland_phone(raw_phone)
    phone_hash = _phone_hash(phone)
    _assert_send_allowed(phone_hash, ip)

    code = _generate_code()
    provider = _provider()
    provider_request_id = provider.send_register_code(phone, code)

    with get_conn() as conn:
        conn.execute(
            """
            insert into auth_sms_codes (
              scene, phone_hash, code_hash, provider, provider_request_id, ip, expires_at
            )
            values (%s, %s, %s, %s, %s, %s, now() + (%s * interval '1 second'))
            """,
            (
                REGISTER_SCENE,
                phone_hash,
                _code_hash(phone, code),
                provider.name,
                provider_request_id,
                ip,
                config.SMS_CODE_TTL_SECONDS,
            ),
        )

    response: dict[str, Any] = {
        "ok": True,
        "expires_in": config.SMS_CODE_TTL_SECONDS,
        "resend_after": config.SMS_CODE_RESEND_SECONDS,
    }
    if provider.name == "mock":
        response["debug_code"] = code
    return response


def verify_register_code(raw_phone: str, raw_code: str) -> str:
    phone = normalize_mainland_phone(raw_phone)
    code = str(raw_code or "").strip()
    if not code.isdigit():
        raise HTTPException(status_code=400, detail="验证码不正确")

    phone_hash = _phone_hash(phone)
    code_hash = _code_hash(phone, code)
    with get_conn() as conn:
        row = conn.execute(
            """
            select id, code_hash, attempts
            from auth_sms_codes
            where scene = %s
              and phone_hash = %s
              and consumed_at is null
              and expires_at > now()
            order by created_at desc
            limit 1
            """,
            (REGISTER_SCENE, phone_hash),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=400, detail="验证码已过期或不存在，请重新获取")
        if int(row["attempts"] or 0) >= MAX_VERIFY_ATTEMPTS:
            raise HTTPException(status_code=429, detail="验证码错误次数过多，请重新获取")
        if not hmac.compare_digest(str(row["code_hash"]), code_hash):
            conn.execute("update auth_sms_codes set attempts = attempts + 1 where id = %s", (row["id"],))
            raise HTTPException(status_code=400, detail="验证码不正确")
        conn.execute("update auth_sms_codes set consumed_at = now() where id = %s", (row["id"],))
    return phone
