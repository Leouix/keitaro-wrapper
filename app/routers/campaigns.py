from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi import Path as FPath
from sqlalchemy.orm import Session

from ..db import get_db
from ..keitaro import KeitaroClient, KeitaroUnavailable
from ..keybox import KeyStore, get_key_store, resolve_key
from ..models import CampaignCache

router = APIRouter(prefix="/api/campaigns", tags=["campaigns"])


def get_keitaro() -> KeitaroClient:
    return KeitaroClient()


def get_keitaro_with_key(store: KeyStore = Depends(get_key_store)) -> KeitaroClient:
    """Клиент для data-эндпоинтов: без настроенного ключа — 409, а не поход в Keitaro."""
    resolved = resolve_key(store)
    if resolved is None:
        raise HTTPException(409, "API key is not configured")
    return KeitaroClient(api_key=resolved[0])


def _upsert(db: Session, campaigns: list[dict]):
    for c in campaigns:
        row = db.get(CampaignCache, c.get("id"))
        if row is None:
            db.add(CampaignCache(keitaro_id=c["id"], name=str(c.get("name", "")), payload=c))
        else:
            row.name = str(c.get("name", row.name))
            row.payload = c
    db.commit()


# Поля кампании, разрешённые к выдаче списком в браузер.
# Всё остальное (token, postbacks, domain, ...) из ответа Keitaro вырезается:
# в живом списке у каждой кампании есть token, отдавать его нельзя.
LIST_FIELDS = ("id", "name", "alias", "state", "group", "updated_at")


def _whitelist(c: dict) -> dict:
    return {field: c.get(field) for field in LIST_FIELDS}


def _stale(db: Session, *, keitaro_id: int | None = None, name: str | None = None) -> dict:
    row = (
        db.get(CampaignCache, keitaro_id)
        if keitaro_id is not None
        else (
            db.query(CampaignCache).filter(CampaignCache.name.ilike(name)).first() if name else None
        )
    )
    if row is None:
        raise HTTPException(503, "Keitaro unavailable and no cached data")
    return {"stale": True, "campaign": row.payload}


@router.get("")
async def list_campaigns(
    query: str = Query("", description="Подстрока имени кампании"),
    keitaro: KeitaroClient = Depends(get_keitaro_with_key),
):
    """Живой поиск кампаний по имени.

    Пустой query — сразу пустой список, в Keitaro не ходим (иначе страница
    по умолчанию вываливала бы все кампании аккаунта). Непустой query —
    каждый раз свежий запрос в Keitaro и фильтрация на нашем сервере;
    кэш и stale-фолбэк здесь намеренно не используются.
    """
    needle = query.strip().lower()
    if not needle:
        return {"campaigns": [], "stale": False, "query": ""}
    try:
        data = await keitaro.get_campaigns()
    except KeitaroUnavailable:
        raise HTTPException(502, "Keitaro unavailable")
    if isinstance(data, dict) and "campaigns" in data:
        data = data["campaigns"]
    if not isinstance(data, list):
        raise HTTPException(502, "Keitaro returned unexpected campaigns format")
    matches = [c for c in data if needle in str(c.get("name") or "").lower()]
    return {"campaigns": [_whitelist(c) for c in matches], "stale": False, "query": needle}


@router.get("/by-name/{name}")
async def get_campaign_by_name(
    name: str,
    db: Session = Depends(get_db),
    keitaro: KeitaroClient = Depends(get_keitaro),
):
    try:
        data = await keitaro.get_campaigns()
    except KeitaroUnavailable:
        return _stale(db, name=name)
    if isinstance(data, dict) and "campaigns" in data:
        data = data["campaigns"]
    wanted = name.strip().lower()
    match = next(
        (c for c in data if str(c.get("name", "")).strip().lower() == wanted), None
    )
    if match is None:
        raise HTTPException(404, f"Campaign '{name}' not found")
    _upsert(db, data)
    return match


@router.get("/{campaign_id}")
async def get_campaign(
    campaign_id: int,
    db: Session = Depends(get_db),
    keitaro: KeitaroClient = Depends(get_keitaro),
):
    try:
        data = await keitaro.get_campaign(campaign_id)
    except KeitaroUnavailable:
        return _stale(db, keitaro_id=campaign_id)
    _upsert(db, [data])
    return data


@router.get("/{campaign_id}/streams")
async def get_campaign_streams(
    campaign_id: int = FPath(gt=0),
    keitaro: KeitaroClient = Depends(get_keitaro_with_key),
):
    # Тело — ровно ответ Keitaro (список потоков); ошибки маппит KeitaroClient.
    return await keitaro.get_campaign_streams(campaign_id)
