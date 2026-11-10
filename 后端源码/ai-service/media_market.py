"""
媒介集市 (meijiejishi.com) 新闻发稿 API 客户端

接入范围：
  - POST /session                            登录换 token
  - GET  /userInfo/info                      用户信息（探活）
  - GET  /sysDictData/rest/sys_news_extend   筛选字典（9 组）
  - GET  /media/type/1                       媒体查询（分页）
  - GET  /popularize/resouce/1               订单列表
  - POST /popularize/pushOrder               标题查重
  - POST /popularize                         创建订单
  - GET  /popularize/{id}
  - PUT  /popularize
  - POST /wordToHtml                         Word 转 HTML（预留）
  - POST /media                              收藏/取消

凭据在 config.py 里从环境变量读，不落库。token 内存 cache，过期前自动续。
"""
from __future__ import annotations

import hashlib
import html
import logging
import threading
import time
from typing import Any, Dict, List, Optional

import httpx

import config

log = logging.getLogger("media_market")


class MediaMarketError(RuntimeError):
    """媒介集市调用失败的统一异常。"""

    def __init__(self, code: str | int, mess: str, *, status_code: int = 502) -> None:
        super().__init__(f"[{code}] {mess}")
        self.code = str(code)
        self.mess = mess
        self.status_code = status_code


def _md5(value: str) -> str:
    return hashlib.md5(value.encode("utf-8")).hexdigest()


def _maybe_md5(value: str) -> str:
    """如果已经是 32 位十六进制就当作已 md5，否则现场算。

    这样凭据写 `.env` 时既能写明文密码、也能写 md5 值。"""
    v = value.strip()
    if len(v) == 32 and all(c in "0123456789abcdefABCDEF" for c in v):
        return v.lower()
    return _md5(v)


class _TokenCache:
    """线程安全的 token 单例缓存。"""

    __slots__ = ("_token", "_expire_at", "_lock")

    def __init__(self) -> None:
        self._token: Optional[str] = None
        self._expire_at: float = 0.0
        self._lock = threading.Lock()

    def get(self) -> Optional[str]:
        # 提前 60s 续期，避免边界情况
        if self._token and time.time() < self._expire_at - 60:
            return self._token
        return None

    def set(self, token: str, expire_in_minutes: int) -> None:
        with self._lock:
            self._token = token
            self._expire_at = time.time() + max(60, int(expire_in_minutes) * 60)

    def invalidate(self) -> None:
        with self._lock:
            self._token = None
            self._expire_at = 0.0


_token_cache = _TokenCache()


def _client() -> httpx.Client:
    """每次调用开一个短连接 client，避免跨线程共享的复杂性。"""
    return httpx.Client(
        base_url=config.MEDIA_MARKET_BASE_URL.rstrip("/"),
        timeout=httpx.Timeout(15.0, connect=6.0),
        headers={"Content-Type": "application/json;charset=UTF-8"},
        trust_env=config.MEDIA_MARKET_TRUST_ENV,
    )


def _assert_config() -> None:
    missing = [
        name
        for name, value in [
            ("MEDIA_MARKET_BASE_URL", config.MEDIA_MARKET_BASE_URL),
            ("MEDIA_MARKET_USERNAME", config.MEDIA_MARKET_USERNAME),
            ("MEDIA_MARKET_PWD", config.MEDIA_MARKET_PWD),
            ("MEDIA_MARKET_CODE", config.MEDIA_MARKET_CODE),
        ]
        if not value
    ]
    if missing:
        raise MediaMarketError(
            code="missing_config",
            mess=f"媒介集市凭据未配置：{', '.join(missing)}，请在 .env 中补齐。",
            status_code=503,
        )


def _unwrap(resp: httpx.Response) -> Dict[str, Any]:
    """媒介集市约定：{code, mess, data}。code=200 才算成功。"""
    try:
        body = resp.json()
    except Exception as exc:
        log.warning("媒介集市返回非 JSON: %s %s", resp.status_code, resp.text[:200])
        raise MediaMarketError(
            code=resp.status_code, mess=f"响应不是 JSON: {resp.text[:120]}"
        ) from exc
    code = body.get("code")
    if str(code) != "200":
        raise MediaMarketError(code=code or resp.status_code, mess=body.get("mess") or "请求失败")
    return body


# ---------------- 登录 ----------------

def login(force: bool = False) -> str:
    """取 token，force=True 强制重登。"""
    if not force:
        cached = _token_cache.get()
        if cached:
            return cached

    _assert_config()
    payload = {
        "userName": config.MEDIA_MARKET_USERNAME,
        "pwd": _maybe_md5(config.MEDIA_MARKET_PWD),
        "code": _maybe_md5(config.MEDIA_MARKET_CODE),
    }
    try:
        with _client() as cli:
            resp = cli.post("/session", json=payload)
    except httpx.RequestError as exc:
        raise MediaMarketError(
            code="network_error",
            mess=f"媒介集市登录网络失败：{exc}",
            status_code=502,
        ) from exc

    body = _unwrap(resp)
    data = body.get("data") or {}
    token = data.get("token")
    expires = data.get("expires_in") or data.get("expire_in") or 30
    if not token:
        raise MediaMarketError(code="no_token", mess="登录响应里没有 token")
    _token_cache.set(token, int(expires))
    log.info("媒介集市登录成功，有效期 %s 分钟", expires)
    return token


def _auth_headers() -> Dict[str, str]:
    return {"Authorization": f"Bearer {login()}"}


def _request(
    method: str,
    path: str,
    *,
    params: Optional[Dict[str, Any]] = None,
    json: Optional[Any] = None,
    retry_on_401: bool = True,
) -> Dict[str, Any]:
    """统一请求，401 自动重登一次。"""
    try:
        with _client() as cli:
            resp = cli.request(
                method,
                path,
                params=params,
                json=json,
                headers=_auth_headers(),
            )
    except httpx.RequestError as exc:
        raise MediaMarketError(
            code="network_error",
            mess=f"媒介集市请求网络失败：{exc}",
            status_code=502,
        ) from exc
    if resp.status_code == 401 and retry_on_401:
        log.info("媒介集市 token 失效，强制重登重试一次")
        _token_cache.invalidate()
        return _request(method, path, params=params, json=json, retry_on_401=False)
    return _unwrap(resp)


def _file_url(url: str) -> str:
    clean_url = str(url or "").strip()
    if clean_url.startswith("http://") or clean_url.startswith("https://"):
        return clean_url
    return f"{config.MEDIA_MARKET_FILE_BASE_URL.rstrip('/')}/{clean_url.lstrip('/')}"


def _upload_request(
    *,
    file_name: str,
    content: bytes,
    content_type: str,
    retry_on_401: bool = True,
) -> Dict[str, Any]:
    try:
        with httpx.Client(
            base_url=config.MEDIA_MARKET_BASE_URL.rstrip("/"),
            timeout=httpx.Timeout(30.0, connect=8.0),
            trust_env=config.MEDIA_MARKET_TRUST_ENV,
        ) as cli:
            resp = cli.post(
                "/ueditor/rest/exec?action=uploadimage",
                headers=_auth_headers(),
                data={"type": "ajax"},
                files={"upfile": (file_name, content, content_type or "application/octet-stream")},
            )
    except httpx.RequestError as exc:
        raise MediaMarketError(
            code="network_error",
            mess=f"媒介集市图片上传网络失败：{exc}",
            status_code=502,
        ) from exc
    if resp.status_code == 401 and retry_on_401:
        log.info("媒介集市 token 失效，图片上传强制重登重试一次")
        _token_cache.invalidate()
        return _upload_request(
            file_name=file_name,
            content=content,
            content_type=content_type,
            retry_on_401=False,
        )
    try:
        body = resp.json()
    except Exception as exc:
        log.warning("媒介集市图片上传返回非 JSON: %s %s", resp.status_code, resp.text[:200])
        raise MediaMarketError(
            code=resp.status_code,
            mess=f"图片上传响应不是 JSON: {resp.text[:120]}",
        ) from exc
    if resp.status_code >= 400 or str(body.get("state") or "").upper() != "SUCCESS":
        raise MediaMarketError(
            code=body.get("state") or resp.status_code,
            mess=body.get("message") or body.get("mess") or "图片上传失败",
            status_code=502,
        )
    return body


# ---------------- 只读接口（第一期） ----------------

def get_user_info() -> Dict[str, Any]:
    """探活用：拉一次自己的用户信息，验证 token 和账号状态。"""
    body = _request("GET", "/userInfo/info")
    return body.get("data") or {}


def get_dict_filters() -> List[Dict[str, Any]]:
    """9 组筛选字典：门户类型 / 频道类型 / 覆盖区域 / 价格区间 / 收录情况 / 联系方式 / 出稿速度 / 特殊项目 / 通发专区。

    返回结构：[ { dictLabel, dictValue, singleOrMultiple, sysDictDataList: [{dictCode, dictLabel, ...}] } ]
    """
    body = _request("GET", "/sysDictData/rest/sys_news_extend")
    data = body.get("data") or []
    return data if isinstance(data, list) else []


def search_media(
    *,
    page: int = 1,
    size: int = 30,
    dict_code: str = "",
    condition: str = "",
    remark: str = "",
    accurate_inquiry: bool = False,
    collect: bool = False,
    sort: str = "",
    search: str = "",
) -> Dict[str, Any]:
    """搜索媒体（分页）。

    - dict_code：多选条件，逗号分隔的 dictCode 列表，空字符串 = 不过滤
    - condition：媒体名称/链接模糊查询
    - collect：true 时只返回已收藏
    - sort + search：排序字段与方向（asc/desc），留空用默认
    """
    params: Dict[str, Any] = {
        "page": page,
        "size": size,
        "dictCode": dict_code,
        "condition": condition,
        "remark": remark,
        "accurateInquiry": "true" if accurate_inquiry else "false",
        "collect": "true" if collect else "false",
        "sort": sort,
        "search": search,
    }
    body = _request("GET", "/media/type/1", params=params)
    return body.get("data") or {}


def list_orders(
    *,
    page: int = 1,
    size: int = 20,
    pop_title: str = "",
    pop_out_trade_no: str = "",
    media_name: str = "",
    pop_auditing: str = "",
    start_time: str = "",
    end_time: str = "",
) -> Dict[str, Any]:
    """订单列表（发稿记录）。

    pop_auditing: 待审核-0 / 发布中-1 / 已发布-2 / 拒稿-3
    start_time / end_time: 'YYYY-MM-DD HH:MM:SS'
    """
    params: Dict[str, Any] = {
        "page": page,
        "size": size,
        "popTitle": pop_title,
        "popOutTradeNo": pop_out_trade_no,
        "mediaName": media_name,
        "popAuditing": pop_auditing,
        "startTime": start_time,
        "endTime": end_time,
    }
    body = _request("GET", "/popularize/resouce/1", params=params)
    return body.get("data") or {}


# ---------------- 投稿 / 订单接口 ----------------

def _as_media_id_list(media_ids: list[str]) -> list[str]:
    ids = [str(item).strip() for item in media_ids if str(item).strip()]
    if not ids:
        raise MediaMarketError(code="missing_media", mess="请选择至少一个投稿媒体", status_code=400)
    return ids


def _plain_text_to_html(content: str) -> str:
    stripped = content.strip()
    if not stripped:
        return ""
    if "<p" in stripped.lower() or "<div" in stripped.lower() or "<br" in stripped.lower():
        return stripped
    paragraphs = [p.strip() for p in stripped.splitlines() if p.strip()]
    return "".join(f"<p>{html.escape(p)}</p>" for p in paragraphs)


def check_title_duplicates(title: str, media_ids: list[str]) -> list[Dict[str, Any]]:
    """检查标题是否已在指定媒体下投过。

    媒介集市返回 data 为 list；非空表示重复，不允许创建订单。
    """
    clean_title = title.strip()
    if not clean_title:
        raise MediaMarketError(code="missing_title", mess="请填写文章标题", status_code=400)
    body = _request(
        "POST",
        "/popularize/pushOrder",
        json={"title": clean_title, "mediaIdList": _as_media_id_list(media_ids)},
    )
    data = body.get("data") or []
    return data if isinstance(data, list) else []


def upload_image(*, file_name: str, content: bytes, content_type: str) -> Dict[str, Any]:
    clean_name = (file_name or "article-image.png").strip() or "article-image.png"
    if not content:
        raise MediaMarketError(code="empty_file", mess="图片文件为空", status_code=400)
    body = _upload_request(file_name=clean_name, content=content, content_type=content_type)
    raw_url = str(body.get("url") or "").strip()
    if not raw_url:
        raise MediaMarketError(code="missing_url", mess="图片上传成功但未返回图片地址", status_code=502)
    return {
        "original": body.get("original") or clean_name,
        "size": body.get("size"),
        "title": body.get("title"),
        "type": body.get("type"),
        "url": _file_url(raw_url),
        "raw_url": raw_url,
        "group": body.get("group"),
    }


def create_order(
    *,
    title: str,
    content: str,
    link: str | None,
    remark: str = "",
    media_ids: list[str],
    allow_duplicate: bool = False,
) -> list[Dict[str, Any]]:
    """创建新闻媒体投稿订单。

    注意：该接口会在媒介集市侧真实创建订单并产生费用，因此调用前必须由前端做二次确认。
    """
    clean_title = title.strip()
    clean_content = _plain_text_to_html(content)
    clean_link = (link or "").strip()
    clean_remark = remark.strip()
    ids = _as_media_id_list(media_ids)

    if not clean_title:
        raise MediaMarketError(code="missing_title", mess="请填写文章标题", status_code=400)
    if not clean_content:
        raise MediaMarketError(code="missing_content", mess="请填写文章正文", status_code=400)
    if clean_link and not (clean_link.startswith("http://") or clean_link.startswith("https://")):
        raise MediaMarketError(code="invalid_link", mess="原文链接必须以 http:// 或 https:// 开头", status_code=400)

    duplicates = check_title_duplicates(clean_title, ids)
    if duplicates and not allow_duplicate:
        raise MediaMarketError(
            code="duplicate_title",
            mess="该标题在所选媒体中已存在，请修改标题后再投稿。",
            status_code=409,
        )

    payload = {
        "popList": [
            {
                "popType": 1,
                "popTitle": clean_title,
                "popContent": clean_content,
                "popLink": clean_link,
                "popRemark": clean_remark,
            }
        ],
        "mediaIdList": ids,
    }
    body = _request("POST", "/popularize", json=payload)
    data = body.get("data") or []
    return data if isinstance(data, list) else [data]


def get_order_detail(pop_id: str) -> Dict[str, Any]:
    clean_id = str(pop_id).strip()
    if not clean_id:
        raise MediaMarketError(code="missing_pop_id", mess="缺少订单 ID", status_code=400)
    body = _request("GET", f"/popularize/{clean_id}")
    data = body.get("data") or {}
    if isinstance(data, list):
        return data[0] if data else {}
    return data


def update_order(*, pop_id: str, title: str, content: str, link: str, remark: str = "") -> Dict[str, Any]:
    clean_id = str(pop_id).strip()
    if not clean_id:
        raise MediaMarketError(code="missing_pop_id", mess="缺少订单 ID", status_code=400)
    payload = {
        "popId": clean_id,
        "popTitle": title.strip(),
        "popContent": _plain_text_to_html(content),
        "popLink": link.strip(),
        "popRemark": remark.strip(),
    }
    body = _request("PUT", "/popularize", json=payload)
    data = body.get("data") or {}
    if isinstance(data, list):
        return data[0] if data else {}
    return data


# ---------------- 辅助：字典树 → 前端筛选条结构 ----------------

FRIENDLY_LABELS = {
    "sys_news_extend_mhlx": "综合门户",
    "sys_news_extend_pdlx": "频道类型",
    "sys_news_extend_fgqy": "覆盖区域",
    "sys_news_extend_jgqj": "价格区间",
    "sys_news_extend_slqk": "收录情况",
    "sys_news_extend_lxfs": "链接类型",
    "sys_news_extend_cgsd": "出稿速度",
    "sys_news_extend_zmkf": "特殊项目",
    "sys_news_extend_tfzq": "通发专区",
}


def normalize_filters(raw: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """把媒介集市的字典树压平成前端友好结构。

    output: [{ key, label, multiple, options: [{code, label}] }, ...]
    """
    out: List[Dict[str, Any]] = []
    for g in raw or []:
        dict_value = str(g.get("dictValue") or "")
        label = FRIENDLY_LABELS.get(dict_value) or str(g.get("dictLabel") or dict_value)
        options = []
        for opt in g.get("sysDictDataList") or []:
            options.append(
                {
                    "code": str(opt.get("dictCode") or ""),
                    "label": str(opt.get("dictLabel") or ""),
                    "sort": int(opt.get("dictSort") or 0),
                }
            )
        options.sort(key=lambda x: x["sort"])
        out.append(
            {
                "key": dict_value,
                "label": label,
                "multiple": str(g.get("singleOrMultiple")) == "1",
                "options": options,
                "sort": int(g.get("dictSort") or 0),
            }
        )
    out.sort(key=lambda x: x["sort"])
    return out


def simplify_media(row: Dict[str, Any]) -> Dict[str, Any]:
    """把单条媒体的 mediaExtendAttrList 展开成 key->label 的 map，方便前端直接绑定。"""
    attrs_by_dict_value: Dict[str, List[str]] = {}
    for a in row.get("mediaExtendAttrList") or []:
        sys = a.get("sysDictData") or {}
        dv = str(sys.get("dictValue") or "")
        lb = str(sys.get("dictLabel") or "")
        if not dv:
            continue
        attrs_by_dict_value.setdefault(dv, []).append(lb)

    return {
        "mediaId": row.get("mediaId"),
        "mediaName": row.get("mediaName"),
        "mediaLink": row.get("mediaLink"),
        "marketPrice": row.get("marketPrice"),
        "weighting": row.get("weighting"),
        "mediaRemark": row.get("mediaRemark"),
        "manuscriptRate": row.get("manuscriptRate"),
        "manuscriptRateStr": row.get("manuscriptRateStr"),
        "salesVolume": row.get("salesVolume"),
        "isCollect": row.get("isCollect"),
        "isRecommend": row.get("isRecommend"),
        "isPreferred": row.get("isPreferred"),
        "attrs": attrs_by_dict_value,
        # 常用属性直接拿出来
        "portal": (attrs_by_dict_value.get("sys_news_extend_mhlx") or [""])[0],
        "channel": (attrs_by_dict_value.get("sys_news_extend_pdlx") or [""])[0],
        "region": (attrs_by_dict_value.get("sys_news_extend_fgqy") or [""])[0],
        "priceRange": (attrs_by_dict_value.get("sys_news_extend_jgqj") or [""])[0],
        "indexing": (attrs_by_dict_value.get("sys_news_extend_slqk") or [""])[0],
        "linkType": (attrs_by_dict_value.get("sys_news_extend_lxfs") or [""])[0],
        "speed": (attrs_by_dict_value.get("sys_news_extend_cgsd") or [""])[0],
        "special": attrs_by_dict_value.get("sys_news_extend_zmkf") or [],
    }
