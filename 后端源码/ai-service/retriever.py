from __future__ import annotations

import uuid

from qdrant_client import QdrantClient
from qdrant_client.http.exceptions import UnexpectedResponse
from qdrant_client.http import models as rest

from config import EMBEDDING_SIZE, QDRANT_COLLECTION, QDRANT_URL
from indexer import embed_text


client = QdrantClient(url=QDRANT_URL, timeout=15.0)


def ensure_collection() -> None:
    collections = {c.name for c in client.get_collections().collections}
    if QDRANT_COLLECTION in collections:
        return
    try:
        client.create_collection(
            collection_name=QDRANT_COLLECTION,
            vectors_config=rest.VectorParams(size=EMBEDDING_SIZE, distance=rest.Distance.COSINE),
        )
    except UnexpectedResponse as exc:
        if "already exists" not in str(exc):
            raise


def _payload_index(field_name: str) -> None:
    try:
        client.create_payload_index(
            collection_name=QDRANT_COLLECTION,
            field_name=field_name,
            field_schema=rest.PayloadSchemaType.KEYWORD,
        )
    except Exception:  # noqa: BLE001 - 索引已存在或老版本 Qdrant 不支持时不阻断主流程
        return


def _tenant_conditions(task_key: str, tenant_id: str | None = None) -> list[rest.FieldCondition]:
    conditions = [rest.FieldCondition(key="task_id", match=rest.MatchValue(value=task_key))]
    if tenant_id:
        conditions.append(rest.FieldCondition(key="tenant_id", match=rest.MatchValue(value=str(tenant_id))))
    return conditions


def upsert_chunks(
    task_id: str,
    page_id: str,
    chunks: list[str],
    url: str,
    title: str,
    tenant_id: str | None = None,
) -> None:
    ensure_collection()
    _payload_index("task_id")
    if tenant_id:
        _payload_index("tenant_id")
    task_key = str(task_id)
    page_key = str(page_id)
    tenant_key = str(tenant_id) if tenant_id else None
    points = []
    for idx, chunk in enumerate(chunks):
        point_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"zggeo:{tenant_key or 'global'}:{task_key}:{page_key}:{idx}"))
        payload = {
            "task_id": task_key,
            "page_id": page_key,
            "chunk_index": idx,
            "url": url,
            "title": title,
            "text": chunk,
        }
        if tenant_key:
            payload["tenant_id"] = tenant_key
        points.append(
            rest.PointStruct(
                id=point_id,
                vector=embed_text(chunk),
                payload=payload,
            )
        )
    if points:
        client.upsert(collection_name=QDRANT_COLLECTION, points=points)


def retrieve_similar(task_id: str, query: str, limit: int = 3, tenant_id: str | None = None) -> list[dict]:
    ensure_collection()
    task_key = str(task_id)
    result = client.query_points(
        collection_name=QDRANT_COLLECTION,
        query=embed_text(query),
        limit=limit,
        query_filter=rest.Filter(must=_tenant_conditions(task_key, tenant_id)),
        with_payload=True,
    )
    return [
        {
            "score": item.score,
            "tenant_id": item.payload.get("tenant_id"),
            "task_id": item.payload.get("task_id"),
            "url": item.payload.get("url"),
            "title": item.payload.get("title"),
            "text": item.payload.get("text"),
        }
        for item in result.points
    ]
