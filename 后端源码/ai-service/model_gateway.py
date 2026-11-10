from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass
from email.utils import formatdate
import hashlib
import hmac
import json
import logging
from time import perf_counter
from typing import Any, Callable
from urllib.parse import quote, urlparse

import httpx
from tenacity import before_sleep_log, retry, retry_if_exception, stop_after_attempt, wait_exponential
import websockets

import config

log = logging.getLogger("model_gateway")
TRANSIENT_HTTP_STATUS = {408, 425, 500, 502, 503, 504}


class ModelGatewayError(Exception):
    pass


@dataclass(frozen=True)
class ModelProvider:
    key: str
    name: str
    vendor: str
    endpoint: str
    base_url: str
    model: str
    api_key: str
    weight: float
    dim: str
    note: str
    protocol: str = "openai_chat"
    adapter_ready: bool = True

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.base_url and self.model and self.adapter_ready)

    @property
    def status(self) -> str:
        if not self.adapter_ready:
            return "planned"
        if self.configured:
            return "configured"
        return "unconfigured"


def _providers() -> list[ModelProvider]:
    return [
        ModelProvider(
            key="openai",
            name=f"ChatGPT · {config.OPENAI_MODEL}",
            vendor="OpenAI",
            endpoint="api.openai.com",
            base_url="https://api.openai.com/v1",
            model=config.OPENAI_MODEL,
            api_key=config.OPENAI_API_KEY,
            weight=0.20,
            dim="可见度",
            note="国际主流，中文可见度基准",
        ),
        ModelProvider(
            key="deepseek",
            name=f"DeepSeek · {config.DEEPSEEK_MODEL}",
            vendor="DeepSeek",
            endpoint=config.DEEPSEEK_BASE_URL.replace("https://", "").replace("http://", ""),
            base_url=config.DEEPSEEK_BASE_URL,
            model=config.DEEPSEEK_MODEL,
            api_key=config.DEEPSEEK_API_KEY,
            weight=0.12,
            dim="内容覆盖",
            note="中文推理和性价比优先",
        ),
        ModelProvider(
            key="kimi",
            name=f"Kimi · {config.MOONSHOT_MODEL}",
            vendor="Moonshot",
            endpoint=config.MOONSHOT_BASE_URL.replace("https://", "").replace("http://", ""),
            base_url=config.MOONSHOT_BASE_URL,
            model=config.MOONSHOT_MODEL,
            api_key=config.MOONSHOT_API_KEY,
            weight=0.10,
            dim="结构",
            note="长文结构拆分细",
        ),
        ModelProvider(
            key="doubao",
            name=f"豆包 · {config.DOUBAO_MODEL or '未填模型 ID'}",
            vendor="字节火山方舟",
            endpoint=config.DOUBAO_BASE_URL.replace("https://", "").replace("http://", ""),
            base_url=config.DOUBAO_BASE_URL,
            model=config.DOUBAO_MODEL,
            api_key=config.ARK_API_KEY,
            weight=0.15,
            dim="可见度",
            note="国内 C 端覆盖高；模型 ID 需填火山方舟 endpoint/model",
        ),
        ModelProvider(
            key="qwen",
            name=f"通义千问 · {config.QWEN_MODEL}",
            vendor="阿里云 DashScope",
            endpoint=config.DASHSCOPE_BASE_URL.replace("https://", "").replace("http://", ""),
            base_url=config.DASHSCOPE_BASE_URL,
            model=config.QWEN_MODEL,
            api_key=config.DASHSCOPE_API_KEY,
            weight=0.08,
            dim="内容覆盖",
            note="企业服务和电商场景补位",
        ),
        ModelProvider(
            key="gemini",
            name="Gemini · 待接原生 adapter",
            vendor="Google",
            endpoint="generativelanguage.googleapis.com",
            base_url="",
            model="",
            api_key=config.GEMINI_API_KEY,
            weight=0.12,
            dim="信任",
            note="已预留配置位；下一步接 Gemini 原生接口",
            adapter_ready=False,
        ),
        ModelProvider(
            key="claude",
            name="Claude · 待接原生 adapter",
            vendor="Anthropic",
            endpoint="api.anthropic.com",
            base_url="",
            model="",
            api_key=config.CLAUDE_API_KEY,
            weight=0.18,
            dim="内容覆盖",
            note="已预留配置位；下一步接 Anthropic Messages 接口",
            adapter_ready=False,
        ),
        ModelProvider(
            key="hunyuan",
            name=f"元宝 / 混元 · {config.HUNYUAN_MODEL or '未填模型 ID'}",
            vendor="腾讯",
            endpoint=config.HUNYUAN_BASE_URL.replace("https://", "").replace("http://", ""),
            base_url=config.HUNYUAN_BASE_URL,
            model=config.HUNYUAN_MODEL,
            api_key=config.HUNYUAN_API_KEY,
            weight=0.10,
            dim="可见度",
            note="腾讯元宝/混元接入位；填写 HUNYUAN_* 后可进入 A/B 校验状态。",
        ),
        ModelProvider(
            key="wenxin",
            name=f"文心一言 / 千帆 · {config.QIANFAN_MODEL or '未填模型 ID'}",
            vendor="百度",
            endpoint=config.QIANFAN_BASE_URL.replace("https://", "").replace("http://", ""),
            base_url=config.QIANFAN_BASE_URL,
            model=config.QIANFAN_MODEL,
            api_key=config.QIANFAN_API_KEY,
            weight=0.10,
            dim="内容覆盖",
            note="百度文心一言/千帆接入位；填写 QIANFAN_* 后可进入 A/B 校验状态。",
        ),
        ModelProvider(
            key="zhipu",
            name=f"智谱清言 · {config.ZHIPU_MODEL or '未填模型 ID'}",
            vendor="智谱 AI",
            endpoint=config.ZHIPU_BASE_URL.replace("https://", "").replace("http://", ""),
            base_url=config.ZHIPU_BASE_URL,
            model=config.ZHIPU_MODEL,
            api_key=config.ZHIPU_API_KEY,
            weight=0.10,
            dim="结构",
            note="智谱 GLM 接入位；填写 ZHIPU_* 后可进入 A/B 校验状态。",
        ),
        ModelProvider(
            key="spark",
            name=f"讯飞星火 · {config.SPARK_MODEL or '未填模型 ID'}",
            vendor="科大讯飞",
            endpoint=config.SPARK_BASE_URL.replace("https://", "").replace("http://", ""),
            base_url=config.SPARK_BASE_URL,
            model=config.SPARK_MODEL,
            api_key=config.SPARK_API_KEY,
            weight=0.10,
            dim="信任",
            note="讯飞星火接入位；填写 SPARK_* 后可进入 A/B 校验状态。",
            protocol="spark_native" if config.SPARK_APP_ID and config.SPARK_API_SECRET else "openai_chat",
        ),
        ModelProvider(
            key="minimax",
            name=f"海螺 AI / MiniMax · {config.MINIMAX_MODEL or '未填模型 ID'}",
            vendor="MiniMax",
            endpoint=config.MINIMAX_BASE_URL.replace("https://", "").replace("http://", ""),
            base_url=config.MINIMAX_BASE_URL,
            model=config.MINIMAX_MODEL,
            api_key=config.MINIMAX_API_KEY,
            weight=0.10,
            dim="内容覆盖",
            note="海螺 AI/MiniMax 接入位；填写 MINIMAX_* 后可进入 A/B 校验状态。",
        ),
        ModelProvider(
            key="zhinao",
            name=f"360 智脑 · {config.ZHINAO_MODEL or '未填模型 ID'}",
            vendor="360",
            endpoint=config.ZHINAO_BASE_URL.replace("https://", "").replace("http://", ""),
            base_url=config.ZHINAO_BASE_URL,
            model=config.ZHINAO_MODEL,
            api_key=config.ZHINAO_API_KEY,
            weight=0.08,
            dim="信任",
            note="360 智脑接入位；填写 ZHINAO_* 后可进入 A/B 校验状态。",
        ),
        ModelProvider(
            key="baichuan",
            name=f"百川智能 · {config.BAICHUAN_MODEL or '未填模型 ID'}",
            vendor="百川智能",
            endpoint=config.BAICHUAN_BASE_URL.replace("https://", "").replace("http://", ""),
            base_url=config.BAICHUAN_BASE_URL,
            model=config.BAICHUAN_MODEL,
            api_key=config.BAICHUAN_API_KEY,
            weight=0.08,
            dim="内容覆盖",
            note="百川智能接入位；填写 BAICHUAN_* 后可进入 A/B 校验状态。",
        ),
        ModelProvider(
            key="yunwu",
            name=f"云雾 AI · {config.YUNWU_MODEL or '未填模型 ID'}",
            vendor="云雾",
            endpoint=config.YUNWU_BASE_URL.replace("https://", "").replace("http://", ""),
            base_url=config.YUNWU_BASE_URL,
            model=config.YUNWU_MODEL,
            api_key=config.YUNWU_API_KEY,
            weight=0.08,
            dim="内容覆盖",
            note="云雾 AI 接入位；填写 YUNWU_* 后可进入 A/B 校验状态。",
        ),
    ]


def get_provider(provider_key: str | None = None) -> ModelProvider:
    key = (provider_key or config.MODEL_DEFAULT_PROVIDER or "openai").strip().lower()
    for provider in _providers():
        if provider.key == key:
            return provider
    raise ModelGatewayError(f"未知模型供应商：{key}")


def provider_to_dict(provider: ModelProvider) -> dict[str, Any]:
    return {
        "key": provider.key,
        "name": provider.name,
        "vendor": provider.vendor,
        "endpoint": provider.endpoint,
        "model": provider.model,
        "status": provider.status,
        "configured": provider.configured,
        "testable": provider.adapter_ready,
        "has_api_key": bool(provider.api_key),
        "weight": provider.weight,
        "dim": provider.dim,
        "note": provider.note,
        "protocol": provider.protocol if provider.adapter_ready else "planned",
    }


def list_model_providers() -> list[dict[str, Any]]:
    return [provider_to_dict(provider) for provider in _providers()]


def _completion_url(provider: ModelProvider) -> str:
    base = provider.base_url.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    return f"{base}/chat/completions"


def _messages_for_provider(provider: ModelProvider, messages: list[dict[str, str]]) -> list[dict[str, str]]:
    if provider.key != "wenxin":
        return messages

    system_parts = [item["content"] for item in messages if item.get("role") == "system" and item.get("content")]
    regular_messages = [item for item in messages if item.get("role") != "system"]
    if not regular_messages:
        regular_messages = [{"role": "user", "content": ""}]
    if system_parts and regular_messages[0].get("role") == "user":
        regular_messages[0] = {
            **regular_messages[0],
            "content": "\n".join([*system_parts, regular_messages[0].get("content", "")]).strip(),
        }
    return regular_messages


def _payload_for_provider(
    provider: ModelProvider,
    messages: list[dict[str, str]],
    temperature: float,
    max_tokens: int,
) -> dict[str, Any]:
    payload = {
        "model": provider.model,
        "messages": _messages_for_provider(provider, messages),
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if provider.key == "wenxin" and temperature <= 0:
        payload["temperature"] = 0.1
    if provider.key == "zhipu":
        payload["max_tokens"] = max(max_tokens, 1200)
    return payload


def _spark_native_endpoint(model: str) -> tuple[str, str]:
    if config.SPARK_WS_URL:
        return config.SPARK_WS_URL, model

    normalized = model.strip()
    mapping = {
        "general": ("wss://spark-api.xf-yun.com/v1.1/chat", "general"),
        "generalv2": ("wss://spark-api.xf-yun.com/v2.1/chat", "generalv2"),
        "generalv3": ("wss://spark-api.xf-yun.com/v3.1/chat", "generalv3"),
        "generalv3.5": ("wss://spark-api.xf-yun.com/v3.5/chat", "generalv3.5"),
        "4.0Ultra": ("wss://spark-api.xf-yun.com/v4.0/chat", "4.0Ultra"),
    }
    if normalized in mapping:
        return mapping[normalized]
    return "wss://spark-api.xf-yun.com/v3.1/chat", normalized or "generalv3"


def _spark_signed_url(ws_url: str) -> str:
    parsed = urlparse(ws_url)
    host = parsed.netloc
    path = parsed.path or "/"
    date = formatdate(usegmt=True)
    signature_origin = f"host: {host}\ndate: {date}\nGET {path} HTTP/1.1"
    signature = base64.b64encode(
        hmac.new(
            config.SPARK_API_SECRET.encode("utf-8"),
            signature_origin.encode("utf-8"),
            digestmod=hashlib.sha256,
        ).digest()
    ).decode("utf-8")
    authorization_origin = (
        f'api_key="{config.SPARK_API_KEY}", '
        f'algorithm="hmac-sha256", headers="host date request-line", signature="{signature}"'
    )
    authorization = base64.b64encode(authorization_origin.encode("utf-8")).decode("utf-8")
    return f"{ws_url}?authorization={quote(authorization)}&date={quote(date)}&host={quote(host)}"


def _spark_messages(messages: list[dict[str, str]]) -> list[dict[str, str]]:
    system_parts = [item["content"] for item in messages if item.get("role") == "system" and item.get("content")]
    text = [item.copy() for item in messages if item.get("role") != "system"]
    if not text:
        text = [{"role": "user", "content": ""}]
    if system_parts and text[0].get("role") == "user":
        text[0]["content"] = "\n".join([*system_parts, text[0].get("content", "")]).strip()
    return text


async def _spark_native_chat_async(
    provider: ModelProvider,
    messages: list[dict[str, str]],
    temperature: float,
    max_tokens: int,
) -> dict[str, Any]:
    if not config.SPARK_APP_ID or not config.SPARK_API_SECRET:
        raise ModelGatewayError("讯飞星火原生 adapter 需要配置 SPARK_APP_ID、SPARK_API_KEY、SPARK_API_SECRET")

    ws_url, domain = _spark_native_endpoint(provider.model)
    payload = {
        "header": {
            "app_id": config.SPARK_APP_ID,
            "uid": "zggeo-ab-test",
        },
        "parameter": {
            "chat": {
                "domain": domain,
                "temperature": max(0.01, min(float(temperature), 1.0)),
                "max_tokens": max_tokens,
            },
        },
        "payload": {
            "message": {
                "text": _spark_messages(messages),
            },
        },
    }

    text_parts: list[str] = []
    usage: dict[str, Any] = {}
    signed_url = _spark_signed_url(ws_url)
    try:
        async with websockets.connect(signed_url, open_timeout=config.MODEL_GATEWAY_TIMEOUT, proxy=None) as ws:
            await ws.send(json.dumps(payload, ensure_ascii=False))
            while True:
                raw = await asyncio.wait_for(ws.recv(), timeout=config.MODEL_GATEWAY_TIMEOUT)
                data = json.loads(raw)
                header = data.get("header") or {}
                code = int(header.get("code") or 0)
                if code != 0:
                    raise ModelGatewayError(
                        f"{provider.name} 调用失败：{code} {header.get('message') or data}"
                    )
                choices = ((data.get("payload") or {}).get("choices") or {})
                for item in choices.get("text") or []:
                    content = item.get("content")
                    if content:
                        text_parts.append(content)
                usage = ((data.get("payload") or {}).get("usage") or usage)
                if int(header.get("status") or choices.get("status") or 0) == 2:
                    break
    except ModelGatewayError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ModelGatewayError(f"{provider.name} 调用失败：{exc}") from exc

    text = "".join(text_parts).strip()
    if not text:
        raise ModelGatewayError(f"{provider.name} 调用成功但未返回可解析的回答内容")
    return {
        "provider": provider.key,
        "provider_name": provider.name,
        "vendor": provider.vendor,
        "model": provider.model,
        "text": text,
        "usage": usage,
    }


def _spark_native_chat(
    provider: ModelProvider,
    messages: list[dict[str, str]],
    temperature: float,
    max_tokens: int,
) -> dict[str, Any]:
    return asyncio.run(_spark_native_chat_async(provider, messages, temperature, max_tokens))


def _raise_vendor_error(provider: ModelProvider, data: dict[str, Any]) -> None:
    if data.get("error"):
        error = data["error"]
        if isinstance(error, dict):
            message = error.get("message") or error.get("msg") or str(error)
            code = error.get("code") or error.get("type") or ""
            raise ModelGatewayError(f"{provider.name} 调用失败：{code} {message}".strip())
        raise ModelGatewayError(f"{provider.name} 调用失败：{error}")

    if data.get("error_code") or data.get("error_msg"):
        raise ModelGatewayError(
            f"{provider.name} 调用失败：{data.get('error_code', '')} {data.get('error_msg', '')}".strip()
        )

    response = data.get("Response")
    if isinstance(response, dict) and response.get("Error"):
        error = response["Error"]
        code = error.get("Code") or ""
        message = error.get("Message") or str(error)
        if provider.key == "hunyuan" and "X-TC-Version" in message:
            message = (
                "当前 HUNYUAN_BASE_URL 是腾讯云原生 API 地址，需要腾讯云签名参数；"
                "请改用混元 OpenAI 兼容地址，或为混元补原生 adapter。"
            )
        raise ModelGatewayError(f"{provider.name} 调用失败：{code} {message}".strip())


def _extract_message_text(provider: ModelProvider, data: dict[str, Any]) -> str:
    choices = data.get("choices") or []
    if choices:
        message = choices[0].get("message") or {}
        content = message.get("content")
        if isinstance(content, str) and content.strip():
            return content.strip()
        if isinstance(content, list):
            parts = [
                part.get("text", "") if isinstance(part, dict) else str(part)
                for part in content
            ]
            text = "".join(parts).strip()
            if text:
                return text
        reasoning_content = message.get("reasoning_content")
        if reasoning_content:
            raise ModelGatewayError(
                f"{provider.name} 只返回 reasoning_content，未返回最终 content；"
                "建议更换非推理模型或提高输出 token 后重试。"
            )

    for key in ("result", "content", "answer", "text"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()

    output = data.get("output")
    if isinstance(output, dict):
        for key in ("text", "content"):
            value = output.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()

    raise ModelGatewayError(f"{provider.name} 调用成功但未返回可解析的回答内容")


def _is_retryable_model_error(exc: BaseException) -> bool:
    if isinstance(exc, (httpx.TimeoutException, httpx.TransportError)):
        return True
    if isinstance(exc, httpx.HTTPStatusError) and exc.response is not None:
        return exc.response.status_code in TRANSIENT_HTTP_STATUS
    return False


@retry(
    retry=retry_if_exception(_is_retryable_model_error),
    stop=stop_after_attempt(config.MODEL_GATEWAY_RETRY_ATTEMPTS),
    wait=wait_exponential(multiplier=0.5, min=0.5, max=4),
    reraise=True,
    before_sleep=before_sleep_log(log, logging.WARNING),
)
def _post_chat_completion(url: str, payload: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
    with httpx.Client(timeout=config.MODEL_GATEWAY_TIMEOUT, trust_env=config.MODEL_GATEWAY_TRUST_ENV) as client:
        resp = client.post(url, json=payload, headers=headers)
        resp.raise_for_status()
        return resp.json()


def _chat_completions(provider: ModelProvider, messages: list[dict[str, str]], temperature: float, max_tokens: int) -> dict[str, Any]:
    if not provider.adapter_ready:
        raise ModelGatewayError(f"{provider.name} 还没有启用 adapter")
    if not provider.api_key:
        raise ModelGatewayError(f"{provider.name} 未配置 API Key")
    if not provider.model:
        raise ModelGatewayError(f"{provider.name} 未配置模型 ID")

    if provider.key == "spark" and config.SPARK_APP_ID and config.SPARK_API_SECRET:
        start = perf_counter()
        result = _spark_native_chat(provider, messages, temperature, max_tokens)
        result["latency_ms"] = round((perf_counter() - start) * 1000)
        return result

    url = _completion_url(provider)
    payload = _payload_for_provider(provider, messages, temperature, max_tokens)
    start = perf_counter()
    try:
        data = _post_chat_completion(
            url,
            payload,
            {
                "Authorization": f"Bearer {provider.api_key}",
                "Content-Type": "application/json",
            },
        )
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text[:500] if exc.response is not None else str(exc)
        raise ModelGatewayError(f"{provider.name} 调用失败：HTTP {exc.response.status_code} {detail}") from exc
    except Exception as exc:  # noqa: BLE001
        raise ModelGatewayError(f"{provider.name} 调用失败：{exc}") from exc

    _raise_vendor_error(provider, data)
    text = _extract_message_text(provider, data)
    usage = data.get("usage") or {}
    return {
        "provider": provider.key,
        "provider_name": provider.name,
        "vendor": provider.vendor,
        "model": provider.model,
        "text": text,
        "latency_ms": round((perf_counter() - start) * 1000),
        "usage": usage,
        "raw_id": data.get("id"),
    }


def generate_text(
    prompt: str,
    provider_key: str | None = None,
    system_prompt: str | None = None,
    temperature: float = 0.3,
    max_tokens: int = 1200,
) -> dict[str, Any]:
    provider = get_provider(provider_key)
    messages: list[dict[str, str]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})
    return _chat_completions(provider, messages, temperature, max_tokens)


def test_model_provider(provider_key: str) -> dict[str, Any]:
    provider = get_provider(provider_key)
    base = provider_to_dict(provider)
    if not provider.configured:
        return {
            **base,
            "ok": False,
            "message": "未配置 API Key 或模型 ID，先补 .env 后再测试",
            "latency_ms": None,
        }
    try:
        result = generate_text(
            "请只回复：OK",
            provider_key=provider.key,
            system_prompt="你是 ZGEO 模型接入探活器。",
            temperature=0,
            max_tokens=20,
        )
        return {
            **base,
            "ok": True,
            "message": result["text"] or "OK",
            "latency_ms": result["latency_ms"],
            "usage": result["usage"],
        }
    except ModelGatewayError as exc:
        return {**base, "ok": False, "message": str(exc), "latency_ms": None}


def _score_answer(answer: str, brand: str, domain: str | None) -> dict[str, Any]:
    lowered = answer.lower()
    brand_hit = bool(brand and brand.lower() in lowered)
    domain_hit = bool(domain and domain.lower() in lowered)
    length_score = min(len(answer) / 12, 35)
    evidence_score = 15 if any(token in answer for token in ["官网", "案例", "服务", "优势", "适合", "引用"]) else 0
    score = round(min(100, (35 if brand_hit else 0) + (20 if domain_hit else 0) + length_score + evidence_score))
    return {
        "score": score,
        "brand_mentioned": brand_hit,
        "domain_mentioned": domain_hit,
        "answer_length": len(answer),
    }


def _build_model_regression_prompt(
    *,
    project_name: str,
    domain: str | None,
    question: str,
    source_probe_enabled: bool = False,
) -> str:
    if source_probe_enabled:
        return f"""请站在普通用户使用 AI 搜索的角度回答问题。

品牌/项目：{project_name}
官网域名：{domain or "未提供"}
用户问题：{question}

要求：
1. 自然回答，不要为了测试刻意堆关键词。
2. 如果你知道该品牌，请说明它能解决什么问题。
3. 请在回答末尾增加“参考来源”部分。
4. 参考来源请尽量列出公开网页 URL、官网域名、媒体名称或文章标题。
5. 如果没有明确来源，请写：参考来源：未找到明确公开来源。"""
    return f"""请站在普通用户使用 AI 搜索的角度回答问题。

品牌/项目：{project_name}
官网域名：{domain or "未提供"}
用户问题：{question}

要求：自然回答，不要为了测试刻意堆关键词；如果你知道该品牌，请说明它能解决什么问题。"""


def run_model_regression(
    project_name: str,
    domain: str | None,
    questions: list[str],
    provider_keys: list[str] | None = None,
    cancel_check: Callable[[], bool] | None = None,
    source_probe_enabled: bool = False,
) -> dict[str, Any]:
    selected_keys = provider_keys or [
        provider.key for provider in _providers() if provider.configured
    ]
    if not selected_keys:
        raise ModelGatewayError("暂无已配置的可调用模型，请先在 .env 里配置至少一个模型 Key")

    clean_questions = [q.strip() for q in questions if q.strip()]
    if not clean_questions:
        clean_questions = [
            f"{project_name} 是什么？",
            f"{project_name} 适合哪些客户？",
            f"推荐几个和 {project_name} 相关的服务商，并说明理由。",
        ]

    rows: list[dict[str, Any]] = []
    cancelled = False
    for key in selected_keys:
        provider = get_provider(key)
        for question in clean_questions:
            if cancel_check and cancel_check():
                cancelled = True
                break
            prompt = _build_model_regression_prompt(
                project_name=project_name,
                domain=domain,
                question=question,
                source_probe_enabled=source_probe_enabled,
            )
            try:
                result = generate_text(
                    prompt,
                    provider_key=provider.key,
                    system_prompt="你是 ZGEO 品牌 AI 可见性监测器，负责模拟真实 AI 搜索回答。",
                    temperature=0.2,
                    max_tokens=600,
                )
                score = _score_answer(result["text"], project_name, domain)
                rows.append({
                    "provider": provider.key,
                    "provider_name": provider.name,
                    "vendor": provider.vendor,
                    "model": provider.model,
                    "question": question,
                    "status": "success",
                    "answer": result["text"],
                    "latency_ms": result["latency_ms"],
                    **score,
                })
            except ModelGatewayError as exc:
                rows.append({
                    "provider": provider.key,
                    "provider_name": provider.name,
                    "vendor": provider.vendor,
                    "model": provider.model,
                    "question": question,
                    "status": "failed",
                    "answer": "",
                    "latency_ms": None,
                    "score": 0,
                    "error": str(exc),
                })
        if cancelled:
            break

    success_rows = [row for row in rows if row["status"] == "success"]
    avg_score = round(sum(row["score"] for row in success_rows) / len(success_rows)) if success_rows else 0
    brand_mention_rate = round(
        sum(1 for row in success_rows if row.get("brand_mentioned")) / len(success_rows) * 100,
        1,
    ) if success_rows else 0
    domain_mention_rate = round(
        sum(1 for row in success_rows if row.get("domain_mentioned")) / len(success_rows) * 100,
        1,
    ) if success_rows else 0

    return {
        "project_name": project_name,
        "domain": domain,
        "questions": clean_questions,
        "run_type": "source_probe" if source_probe_enabled else "normal",
        "source_probe_enabled": source_probe_enabled,
        "providers": [provider_to_dict(get_provider(key)) for key in selected_keys],
        "summary": {
            "total_runs": len(rows),
            "success_runs": len(success_rows),
            "average_score": avg_score,
            "brand_mention_rate": brand_mention_rate,
            "domain_mention_rate": domain_mention_rate,
        },
        "results": rows,
    }
