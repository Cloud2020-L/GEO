from __future__ import annotations

from bs4 import BeautifulSoup
import httpx
from urllib.parse import urlparse


USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0 Safari/537.36"
)


def _candidate_urls(url: str) -> list[str]:
    raw = (url or "").strip()
    if not raw:
        return []
    parsed = urlparse(raw if "://" in raw else f"https://{raw}")
    host = parsed.netloc or parsed.path
    path = parsed.path if parsed.netloc else ""
    if not host:
        return []

    base_host = host[4:] if host.startswith("www.") else host
    schemes = [parsed.scheme or "https", "https", "http"]
    hosts = [host, f"www.{base_host}", base_host]
    candidates: list[str] = []
    for scheme in schemes:
        for item_host in hosts:
            candidate = f"{scheme}://{item_host}{path if path and path != host else ''}"
            if candidate not in candidates:
                candidates.append(candidate)
    return candidates


def fetch_url_content(url: str) -> dict[str, str]:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Cache-Control": "no-cache",
    }
    errors: list[str] = []
    response: httpx.Response | None = None
    for candidate in _candidate_urls(url):
        try:
            with httpx.Client(
                headers=headers,
                follow_redirects=True,
                timeout=httpx.Timeout(20.0, connect=8.0),
                trust_env=False,
            ) as client:
                current = client.get(candidate)
            current.raise_for_status()
            response = current
            break
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{candidate} -> {exc}")

    if response is None:
        detail = "；".join(errors[-4:]) or "没有可读取的 URL"
        raise RuntimeError(detail)

    soup = BeautifulSoup(response.text, "html.parser")
    title = soup.title.string.strip() if soup.title and soup.title.string else url
    text = " ".join(chunk.strip() for chunk in soup.get_text(" ").split() if chunk.strip())
    return {"url": str(response.url), "title": title, "raw_text": text[:40000]}
