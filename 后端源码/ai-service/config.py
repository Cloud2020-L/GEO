from __future__ import annotations

import os
from pathlib import Path


def _load_local_env() -> None:
    env_path = Path(__file__).resolve().parent / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            os.environ[key] = value


_load_local_env()


POSTGRES_DSN = os.getenv(
    "POSTGRES_DSN",
    "postgresql://zggeo:zggeo@localhost:54329/zggeo",
)
CONTENT_IMAGE_UPLOAD_DIR = os.getenv(
    "CONTENT_IMAGE_UPLOAD_DIR",
    str(Path(__file__).resolve().parent / ".data" / "content-images"),
)
QDRANT_URL = os.getenv("QDRANT_URL", "http://127.0.0.1:6333").replace(
    "://localhost:",
    "://127.0.0.1:",
)
QDRANT_COLLECTION = os.getenv("QDRANT_COLLECTION", "zggeo_pages")
API_HOST = os.getenv("API_HOST", "0.0.0.0")
API_PORT = int(os.getenv("AI_SERVICE_PORT", "8010"))
CORS_ALLOW_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ALLOW_ORIGINS",
        "http://localhost:3003,http://127.0.0.1:3003,http://localhost:3004,http://127.0.0.1:3004,http://localhost:8010,http://127.0.0.1:8010",
    ).split(",")
    if origin.strip()
]
ENABLE_HTTPS_REDIRECT = os.getenv("ENABLE_HTTPS_REDIRECT", "false").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
LOCAL_TASK_QUEUE_WORKERS = max(1, int(os.getenv("LOCAL_TASK_QUEUE_WORKERS", "2")))
TASK_QUEUE_BACKEND = os.getenv("TASK_QUEUE_BACKEND", "local").strip().lower()
TASK_QUEUE_REDIS_URL = os.getenv("REDIS_URL", os.getenv("TASK_QUEUE_REDIS_URL", "redis://127.0.0.1:6379/0"))
TASK_QUEUE_REDIS_QUEUE = os.getenv("TASK_QUEUE_REDIS_QUEUE", "zggeo")
TASK_QUEUE_JOB_TIMEOUT = int(os.getenv("TASK_QUEUE_JOB_TIMEOUT", "900"))
TASK_QUEUE_RESULT_TTL = int(os.getenv("TASK_QUEUE_RESULT_TTL", "86400"))
TASK_QUEUE_FAILURE_TTL = int(os.getenv("TASK_QUEUE_FAILURE_TTL", "604800"))
CLIENT_CREDIT_EXPIRY_SECONDS = max(1, int(os.getenv("CLIENT_CREDIT_EXPIRY_SECONDS", "31536000")))
EMBEDDING_SIZE = 128
LEAD_NOTIFY_CHANNEL = os.getenv("LEAD_NOTIFY_CHANNEL", "ntfy")
LEAD_NOTIFY_TOPIC = os.getenv("LEAD_NOTIFY_TOPIC", "zggeo-open-demo")
LEAD_NOTIFY_URL = os.getenv("LEAD_NOTIFY_URL", f"https://ntfy.sh/{LEAD_NOTIFY_TOPIC}")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")

# ---- ZGEO 模型网关 ----
# P1 先统一接入 OpenAI-compatible Chat Completions 协议：
# OpenAI / DeepSeek / Kimi(Moonshot) / 豆包火山方舟 / 通义千问 DashScope 都可走同一 adapter。
MODEL_DEFAULT_PROVIDER = os.getenv("MODEL_DEFAULT_PROVIDER", "openai")
MODEL_GATEWAY_TIMEOUT = int(os.getenv("MODEL_GATEWAY_TIMEOUT", "60"))
MODEL_GATEWAY_RETRY_ATTEMPTS = max(1, int(os.getenv("MODEL_GATEWAY_RETRY_ATTEMPTS", "2")))
MODEL_GATEWAY_TRUST_ENV = os.getenv("MODEL_GATEWAY_TRUST_ENV", "false").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")

MOONSHOT_API_KEY = os.getenv("MOONSHOT_API_KEY", os.getenv("KIMI_API_KEY", ""))
MOONSHOT_BASE_URL = os.getenv("MOONSHOT_BASE_URL", "https://api.moonshot.cn/v1")
MOONSHOT_MODEL = os.getenv("MOONSHOT_MODEL", "moonshot-v1-8k")

ARK_API_KEY = os.getenv("ARK_API_KEY", os.getenv("DOUBAO_API_KEY", ""))
DOUBAO_BASE_URL = os.getenv("DOUBAO_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3")
DOUBAO_MODEL = os.getenv("DOUBAO_MODEL", "")

DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY", os.getenv("QWEN_API_KEY", ""))
DASHSCOPE_BASE_URL = os.getenv("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
QWEN_MODEL = os.getenv("QWEN_MODEL", "qwen-plus")

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
CLAUDE_API_KEY = os.getenv("CLAUDE_API_KEY", os.getenv("ANTHROPIC_API_KEY", ""))

HUNYUAN_API_KEY = os.getenv("HUNYUAN_API_KEY", os.getenv("YUANBAO_API_KEY", ""))
HUNYUAN_BASE_URL = os.getenv("HUNYUAN_BASE_URL", "")
HUNYUAN_MODEL = os.getenv("HUNYUAN_MODEL", "")

QIANFAN_API_KEY = os.getenv("QIANFAN_API_KEY", os.getenv("WENXIN_API_KEY", ""))
QIANFAN_BASE_URL = os.getenv("QIANFAN_BASE_URL", "")
QIANFAN_MODEL = os.getenv("QIANFAN_MODEL", "")

ZHIPU_API_KEY = os.getenv("ZHIPU_API_KEY", "")
ZHIPU_BASE_URL = os.getenv("ZHIPU_BASE_URL", "")
ZHIPU_MODEL = os.getenv("ZHIPU_MODEL", "")

SPARK_API_KEY = os.getenv("SPARK_API_KEY", "")
SPARK_APP_ID = os.getenv("SPARK_APP_ID", os.getenv("SPARK_APPID", ""))
SPARK_API_SECRET = os.getenv("SPARK_API_SECRET", "")
SPARK_BASE_URL = os.getenv("SPARK_BASE_URL", "")
SPARK_WS_URL = os.getenv("SPARK_WS_URL", "")
SPARK_MODEL = os.getenv("SPARK_MODEL", "")

MINIMAX_API_KEY = os.getenv("MINIMAX_API_KEY", "")
MINIMAX_BASE_URL = os.getenv("MINIMAX_BASE_URL", "")
MINIMAX_MODEL = os.getenv("MINIMAX_MODEL", "")

ZHINAO_API_KEY = os.getenv("ZHINAO_API_KEY", os.getenv("QIHOO_API_KEY", ""))
ZHINAO_BASE_URL = os.getenv("ZHINAO_BASE_URL", "")
ZHINAO_MODEL = os.getenv("ZHINAO_MODEL", "")

BAICHUAN_API_KEY = os.getenv("BAICHUAN_API_KEY", "")
BAICHUAN_BASE_URL = os.getenv("BAICHUAN_BASE_URL", "")
BAICHUAN_MODEL = os.getenv("BAICHUAN_MODEL", "")

YUNWU_API_KEY = os.getenv("YUNWU_API_KEY", "")
YUNWU_BASE_URL = os.getenv("YUNWU_BASE_URL", "")
YUNWU_MODEL = os.getenv("YUNWU_MODEL", "")

# ---- 媒介集市（meijiejishi.com）新闻发稿 API ----
# 账号开通：登录 https://www.meijiejishi.com 个人中心 → API 对接
# userName / pwd / code 均为必填；pwd 和 code 既可填明文（自动 MD5），也可直接填 32 位 MD5
MEDIA_MARKET_BASE_URL = os.getenv("MEDIA_MARKET_BASE_URL", "https://www.meijiejishi.com")
MEDIA_MARKET_USERNAME = os.getenv("MEDIA_MARKET_USERNAME", "")
MEDIA_MARKET_PWD = os.getenv("MEDIA_MARKET_PWD", "")
MEDIA_MARKET_CODE = os.getenv("MEDIA_MARKET_CODE", "")
MEDIA_MARKET_FILE_BASE_URL = os.getenv("MEDIA_MARKET_FILE_BASE_URL", "https://p.iffof.com/file")
MEDIA_MARKET_TRUST_ENV = os.getenv("MEDIA_MARKET_TRUST_ENV", "false").lower() in {"1", "true", "yes", "on"}

# ---- 短信验证码 ----
SMS_PROVIDER = os.getenv("SMS_PROVIDER", "mock").strip().lower()
SMS_CODE_TTL_SECONDS = int(os.getenv("SMS_CODE_TTL_SECONDS", "300"))
SMS_CODE_RESEND_SECONDS = int(os.getenv("SMS_CODE_RESEND_SECONDS", "60"))
SMS_CODE_MAX_PER_PHONE_PER_HOUR = int(os.getenv("SMS_CODE_MAX_PER_PHONE_PER_HOUR", "5"))
SMS_CODE_MAX_PER_IP_PER_HOUR = int(os.getenv("SMS_CODE_MAX_PER_IP_PER_HOUR", "20"))

TENCENTCLOUD_SECRET_ID = os.getenv("TENCENTCLOUD_SECRET_ID", "")
TENCENTCLOUD_SECRET_KEY = os.getenv("TENCENTCLOUD_SECRET_KEY", "")
TENCENT_SMS_REGION = os.getenv("TENCENT_SMS_REGION", "ap-guangzhou")
TENCENT_SMS_SDK_APP_ID = os.getenv("TENCENT_SMS_SDK_APP_ID", "")
TENCENT_SMS_SIGN_NAME = os.getenv("TENCENT_SMS_SIGN_NAME", "")
TENCENT_SMS_TEMPLATE_ID = os.getenv("TENCENT_SMS_TEMPLATE_ID", "")
