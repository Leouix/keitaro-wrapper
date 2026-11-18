import asyncio

import httpx
from fastapi import APIRouter, Depends, HTTPException, Path, Query

from ..deps import get_keitaro_with_key
from ..keitaro import KeitaroClient, KeitaroUnavailable

router = APIRouter(prefix="/api/offers", tags=["offers"])

# Верхняя граница батча: страница потоков редко показывает больше оферов,
# а без лимита ?ids=... превращается в неограниченный поход в Keitaro.
MAX_BATCH_IDS = 50


def parse_offer_ids(raw: str) -> list[int]:
    """'1,2,3' -> [1, 2, 3]. Дубли схлопываются, порядок сохраняется."""
    raw = raw.strip()
    if not raw:
        raise HTTPException(422, "ids is required: GET /api/offers?ids=1,2,3")
    ids: list[int] = []
    for part in raw.split(","):
        try:
            value = int(part.strip())
        except ValueError:
            raise HTTPException(
                422, f"ids must be comma-separated positive integers, got: {part!r}"
            )
        if value <= 0:
            raise HTTPException(422, "offer ids must be positive integers")
        ids.append(value)
    ids = list(dict.fromkeys(ids))
    if len(ids) > MAX_BATCH_IDS:
        raise HTTPException(
            422, f"Too many ids: {len(ids)} > limit {MAX_BATCH_IDS}"
        )
    return ids


@router.get("")
async def get_offers_batch(
    ids: str = Query(...),
    keitaro: KeitaroClient = Depends(get_keitaro_with_key),
):
    """Батч-загрузка оферов: один запрос фронта вместо N запросов по одному.

    Каждый id запрашивается в Keitaro отдельно (параллельно, gather);
    ошибка/403/404/недоступность одного офера НЕ валит весь батч — она
    попадает в errors с кодом и текстом. 403 отдаётся как есть, с текстом
    Keitaro («Keitaro permission denied: ...»), чтобы фронт честно показал
    «нет прав», а не «не удалось загрузить». Ответ:
    {"offers": [...], "errors": [{"offer_id": N, "status": S, "detail": "..."}]}
    """
    offer_ids = parse_offer_ids(ids)
    results = await asyncio.gather(
        *(keitaro.get_offer(oid) for oid in offer_ids),
        return_exceptions=True,
    )
    offers: list[dict] = []
    errors: list[dict] = []
    for oid, result in zip(offer_ids, results):
        if isinstance(result, BaseException):
            if isinstance(result, KeitaroUnavailable):
                errors.append(
                    {"offer_id": oid, "status": 502, "detail": "Keitaro unavailable"}
                )
            elif isinstance(result, HTTPException):
                errors.append(
                    {
                        "offer_id": oid,
                        "status": result.status_code,
                        "detail": result.detail,
                    }
                )
            else:
                # Неожиданное исключение — 502 с типом, без утечки содержимого.
                errors.append(
                    {
                        "offer_id": oid,
                        "status": 502,
                        "detail": f"Unexpected error: {type(result).__name__}",
                    }
                )
        else:
            offers.append(result)
    return {"offers": offers, "errors": errors}


@router.get("/{offer_id}")
async def get_offer(
    offer_id: int = Path(gt=0),
    keitaro: KeitaroClient = Depends(get_keitaro_with_key),
):
    # Тело — ровно ответ Keitaro; 404/403 маппит KeitaroClient,
    # недоступность (5xx/сеть после ретряев) переводим в 502 — как в streams/campaigns.
    try:
        return await keitaro.get_offer(offer_id)
    except KeitaroUnavailable as e:
        raise HTTPException(502, "Keitaro unavailable") from e
