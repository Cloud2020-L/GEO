from __future__ import annotations

import re
import secrets


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
USERNAME_RE = re.compile(r"^[A-Za-z0-9_\-\u4e00-\u9fff]{2,32}$")
MAINLAND_PHONE_RE = re.compile(r"^1[3-9]\d{9}$")


def normalize_username(raw: str | None) -> str:
    username = str(raw or "").strip()
    if "@" in username:
        raise ValueError("用户名不能使用邮箱格式")
    if not USERNAME_RE.fullmatch(username):
        raise ValueError("用户名支持中文、字母、数字、下划线和短横线，长度 2-32 位")
    return username


def normalize_contact_email(raw: str | None) -> str | None:
    email = str(raw or "").strip().lower()
    if not email:
        return None
    if not EMAIL_RE.fullmatch(email):
        raise ValueError("联系邮箱格式不正确")
    return email


def normalize_mainland_phone(raw: str | None) -> str:
    phone = re.sub(r"\D+", "", str(raw or ""))
    if phone.startswith("86") and len(phone) == 13:
        phone = phone[2:]
    if not MAINLAND_PHONE_RE.fullmatch(phone):
        raise ValueError("请输入正确的中国大陆手机号")
    return phone


def phone_to_e164(phone: str) -> str:
    return f"+86{normalize_mainland_phone(phone)}"


def fallback_contact_email(username: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_-]+", "", username).strip("-_").lower() or "user"
    return f"{safe}-{secrets.token_hex(4)}@zggeo.local"
