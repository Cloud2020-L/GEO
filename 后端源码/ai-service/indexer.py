from __future__ import annotations

import hashlib
from typing import Iterable

from llama_index.core.node_parser import SentenceSplitter

from config import EMBEDDING_SIZE


splitter = SentenceSplitter(chunk_size=512, chunk_overlap=64)


def chunk_text(text: str) -> list[str]:
    if not text.strip():
        return []
    return splitter.split_text(text)


def embed_text(text: str) -> list[float]:
    vector = [0.0] * EMBEDDING_SIZE
    for token in text.lower().split():
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        for i in range(0, min(len(digest), EMBEDDING_SIZE), 2):
            idx = digest[i] % EMBEDDING_SIZE
            vector[idx] += digest[i + 1] / 255.0
    norm = sum(v * v for v in vector) ** 0.5 or 1.0
    return [v / norm for v in vector]


def embed_many(texts: Iterable[str]) -> list[list[float]]:
    return [embed_text(text) for text in texts]
