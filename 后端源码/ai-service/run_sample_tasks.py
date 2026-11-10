from __future__ import annotations

import json
from pathlib import Path

import httpx


BASE_URL = "http://127.0.0.1:8010"


def main() -> None:
    payloads = json.loads(Path("ai-service/sample_tasks.json").read_text())
    for payload in payloads:
        response = httpx.post(f"{BASE_URL}/tasks", json=payload, timeout=30.0)
        response.raise_for_status()
        print(response.json())


if __name__ == "__main__":
    main()
