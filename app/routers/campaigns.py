import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi import Path as FPath
from sqlalchemy.orm import Session

from ..constants import CAMPAIGN_LIST_FIELDS
from ..db import get_db
from ..deps import get_keitaro_with_key
from ..keitaro import KeitaroClient, KeitaroUnavailable
from ..models import CampaignCache, StreamOfferState, utcnow

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/campaigns", tags=["campaigns"])


def _upsert(db: Session, campaigns: list[dict]):
    for c in campaigns:
        row = db.get(CampaignCache, c.get("id"))
        if row is None:
            db.add(CampaignCache(keitaro_id=c["id"], name=str(c.get("name", "")), payload=c))
        else:
            row.name = str(c.get("name", row.name))
            row.payload = c
    db.commit()


# Whitelist полей кампании — в app/constants.py (граница безопасности,
# общая для всех роутеров).


def _whitelist(c: dict) -> dict:
    return {field: c.get(field) for field in CAMPAIGN_LIST_FIELDS}


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


@router.get("/{campaign_id}")
async def get_campaign(
    campaign_id: int,
    db: Session = Depends(get_db),
    keitaro: KeitaroClient = Depends(get_keitaro_with_key),
):
    """Детальная кампания для фронта: только whitelisted поля (без token).
    Кэш при недоступности Keitaro — в той же плоской форме + stale=true."""
    try:
        data = await keitaro.get_campaign(campaign_id)
    except KeitaroUnavailable:
        row = db.get(CampaignCache, campaign_id)
        if row is None:
            raise HTTPException(503, "Keitaro unavailable and no cached data")
        return {**_whitelist(row.payload), "stale": True}
    _upsert(db, [data])
    return _whitelist(data)


def sync_stream_offer_state(db: Session, campaign_id: int, streams) -> None:
    """Сверка stream_offer_state с живым списком потоков кампании.

    Живые оферы (в пришедшем payload) — upsert и снятие архива; наши живые
    строки, которых в payload больше нет, — архив reason="keitaro" (уже
    архивные не трогаем). Любая ошибка БД не должна ломать страницу —
    вызывающий код оборачивает вызов в try/except.

    SQL: две выборки независимо от числа потоков и оферов — существующие
    строки одним запросом WHERE stream_id IN (...) и выборка на архивацию
    по кампании (раньше был SELECT на каждый офер каждого потока, K×N).
    """
    if not isinstance(streams, list):
        return
    now = utcnow()
    seen: set[tuple[int, int]] = set()
    entries: dict[tuple[int, int], dict] = {}
    stream_campaign: dict[int, int] = {}
    for st in streams:
        if not isinstance(st, dict):
            continue
        try:
            stream_id = int(st.get("id"))
        except (TypeError, ValueError):
            continue
        st_campaign = st.get("campaign_id")
        if st_campaign is None:
            st_campaign = campaign_id  # fallback: кампания из пути
        stream_campaign[stream_id] = int(st_campaign)
        for o in st.get("offers") or []:
            try:
                offer_id = int(o.get("offer_id"))
            except (TypeError, ValueError):
                continue
            seen.add((stream_id, offer_id))
            entries[(stream_id, offer_id)] = o
    stream_ids = {sid for sid, _ in seen}
    existing: dict[tuple[int, int], StreamOfferState] = {}
    if stream_ids:
        existing = {
            (row.stream_id, row.offer_id): row
            for row in db.query(StreamOfferState)
            .filter(StreamOfferState.stream_id.in_(stream_ids))
            .all()
        }
    for key in seen:
        stream_id, offer_id = key
        row = existing.get(key)
        if row is None:
            row = StreamOfferState(stream_id=stream_id, offer_id=offer_id)
            db.add(row)
        entry = entries[key]
        row.campaign_id = stream_campaign[stream_id]
        row.share = entry.get("share")
        row.state = entry.get("state") or "active"
        row.last_seen_at = now
        row.archived_at = None
        row.archive_reason = None
    for row in (
        db.query(StreamOfferState)
        .filter(
            StreamOfferState.campaign_id == campaign_id,
            StreamOfferState.archived_at.is_(None),
        )
        .all()
    ):
        if (row.stream_id, row.offer_id) not in seen:
            row.archived_at = now
            row.archive_reason = "keitaro"
    db.commit()


@router.get("/{campaign_id}/streams/archive")
async def get_campaign_streams_archive(
    campaign_id: int = FPath(gt=0),
    db: Session = Depends(get_db),
):
    """Архив удалённых оферов кампании: только локальная БД — без ключа,
    без похода в Keitaro, работает и при недоступности Keitaro."""
    rows = (
        db.query(StreamOfferState)
        .filter(
            StreamOfferState.campaign_id == campaign_id,
            StreamOfferState.archived_at.isnot(None),
        )
        .order_by(StreamOfferState.archived_at.desc())
        .all()
    )
    return {
        "archived": [
            {
                "stream_id": r.stream_id,
                "offer_id": r.offer_id,
                "share": r.share,
                "state": r.state,
                "archived_at": r.archived_at.isoformat() if r.archived_at else None,
                "reason": r.archive_reason,
            }
            for r in rows
        ]
    }


@router.get("/{campaign_id}/streams")
async def get_campaign_streams(
    campaign_id: int = FPath(gt=0),
    db: Session = Depends(get_db),
    keitaro: KeitaroClient = Depends(get_keitaro_with_key),
):
    # Тело — ровно ответ Keitaro (список потоков); 404/403/502 маппит KeitaroClient,
    # недоступность (5xx/сеть после ретряев) переводим в 502 — UI ждёт
    # «Keitaro недоступен», а не 500 с трейсбеком.
    try:
        data = await keitaro.get_campaign_streams(campaign_id)
    except KeitaroUnavailable as e:
        raise HTTPException(502, "Keitaro unavailable") from e
    try:
        sync_stream_offer_state(db, campaign_id, data)
    except Exception:
        # Синхронизация — побочный эффект: БД не должна ломать страницу.
        logger.exception(
            "stream_offer_state sync failed for campaign %s", campaign_id
        )
    return data
