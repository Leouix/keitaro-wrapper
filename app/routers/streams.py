"""Добавление и удаление офера в потоке Keitaro.

Контракт согласован с брифом:
- campaign_id клиенту не доверяем — берём его из самого потока;
- PUT частичный, но share Keitaro сам не пересчитывает, поэтому присылаем
  явные целые для ВСЕХ оферов потока: 100 // n поровну, остаток добирается
  первым оферам (3 офера -> 34/33/33);
- дубликат offer_id отсекаем до PUT — сервер Keitaro дубликаты схлопывает;
- удаление: сначала PUT в Keitaro с пересчитанными долями, только после
  успеха офер архивируется в stream_offer_state (archive_reason="user");
  ошибка записи в БД после успешного PUT не ломает ответ — логируем и
  всё равно отдаём 200;
- POST возвращает офер из архива к жизни (archived_at=None).
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..keitaro import KeitaroClient, KeitaroUnavailable
from ..models import StreamOfferState, utcnow
from .campaigns import get_keitaro_with_key

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/streams", tags=["streams"])


class OfferAddBody(BaseModel):
    # extra="forbid": campaign_id и прочее от клиента не принимаем —
    # источник правды по кампании это сам поток.
    model_config = ConfigDict(extra="forbid")

    offer_id: int = Field(gt=0)


def reshare(offers: list[dict]) -> list[dict]:
    """Равные доли для всех оферов потока.

    Keitaro share сам не пересчитывает; UI раскладывает поровну с
    доборкой остатка первым оферам (3 офера -> 34/33/33), повторяем это.
    Пустой список -> пустой payload.
    """
    n = len(offers)
    if n == 0:
        return []
    base, rest = divmod(100, n)
    return [
        {
            "offer_id": o["offer_id"],
            "share": base + (1 if i < rest else 0),
            "state": o.get("state") or "active",
        }
        for i, o in enumerate(offers)
    ]


def _lift_archive(
    db: Session,
    *,
    stream_id: int,
    campaign_id,
    offer_id: int,
    entry: dict | None = None,
) -> None:
    """Офер снова живой в потоке: архивная строка снимается (или заводится)."""
    row = (
        db.query(StreamOfferState)
        .filter(
            StreamOfferState.stream_id == stream_id,
            StreamOfferState.offer_id == offer_id,
        )
        .one_or_none()
    )
    if row is None:
        row = StreamOfferState(
            stream_id=stream_id,
            offer_id=offer_id,
            campaign_id=int(campaign_id or 0),
        )
        db.add(row)
    if entry is not None:
        row.share = entry.get("share")
        row.state = entry.get("state") or "active"
    row.last_seen_at = utcnow()
    row.archived_at = None
    row.archive_reason = None
    db.commit()


def _archive_offer(
    db: Session,
    *,
    stream_id: int,
    campaign_id,
    offer_id: int,
    entry: dict,
    reason: str,
) -> None:
    """Архивируем офер: последние известные share/state + причина."""
    row = (
        db.query(StreamOfferState)
        .filter(
            StreamOfferState.stream_id == stream_id,
            StreamOfferState.offer_id == offer_id,
        )
        .one_or_none()
    )
    if row is None:
        row = StreamOfferState(
            stream_id=stream_id,
            offer_id=offer_id,
            campaign_id=int(campaign_id or 0),
        )
        db.add(row)
    row.share = entry.get("share")
    row.state = entry.get("state") or "active"
    row.last_seen_at = utcnow()
    row.archived_at = utcnow()
    row.archive_reason = reason
    db.commit()


async def _get_stream_or_raise(keitaro: KeitaroClient, stream_id: int) -> dict:
    try:
        return await keitaro.get_stream(stream_id)
    except KeitaroUnavailable as e:
        # KeitaroUnavailable — НЕ HTTPException, мимо except HTTPException
        # он дал бы 500 с трейсбеком; UI ждёт «Keitaro недоступен» (502).
        raise HTTPException(502, "Keitaro unavailable") from e
    except HTTPException as e:
        if e.status_code == 404:
            raise HTTPException(404, "Поток не найден") from e
        raise  # 403 permission и прочие 4xx — как есть


def _check_landings_schema(stream: dict) -> None:
    schema = str(stream.get("schema") or "")
    if schema != "landings":
        # redirect-поток принимает offers с 200, но молча игнорирует —
        # не делаем PUT, который ничего не изменит.
        raise HTTPException(409, f"Поток не принимает оферы (schema={schema})")


@router.post("/{stream_id}/offers")
async def add_offer_to_stream(
    stream_id: int = Path(gt=0),
    body: OfferAddBody = ...,
    db: Session = Depends(get_db),
    keitaro: KeitaroClient = Depends(get_keitaro_with_key),
):
    stream = await _get_stream_or_raise(keitaro, stream_id)
    _check_landings_schema(stream)

    try:
        offer = await keitaro.get_offer(body.offer_id)
    except KeitaroUnavailable as e:
        raise HTTPException(502, "Keitaro unavailable") from e
    except HTTPException as e:
        if e.status_code == 404:
            raise HTTPException(404, "Офер не найден в Keitaro") from e
        raise

    offers = list(stream.get("offers") or [])
    if any(o.get("offer_id") == body.offer_id for o in offers):
        # Офер уже в потоке — и всё равно он живой: снимаем архив, если был.
        entry = next((o for o in offers if o.get("offer_id") == body.offer_id), None)
        try:
            _lift_archive(
                db,
                stream_id=stream_id,
                campaign_id=stream.get("campaign_id"),
                offer_id=body.offer_id,
                entry=entry,
            )
        except Exception:
            logger.exception(
                "stream_offer_state unarchive failed: stream=%s offer=%s",
                stream_id,
                body.offer_id,
            )
        return {"added": False, "already": True, "stream": stream}

    offers.append({"offer_id": body.offer_id, "share": 0, "state": "active"})
    payload = reshare(offers)
    try:
        updated = await keitaro.update_stream_offers(
            stream_id, stream.get("campaign_id"), payload
        )
    except KeitaroUnavailable as e:
        # PUT ретраится внутри клиента; если и он не прошёл — 502, не 500.
        raise HTTPException(502, "Keitaro unavailable") from e
    entry = next((o for o in payload if o["offer_id"] == body.offer_id), None)
    try:
        _lift_archive(
            db,
            stream_id=stream_id,
            campaign_id=stream.get("campaign_id"),
            offer_id=body.offer_id,
            entry=entry,
        )
    except Exception:
        logger.exception(
            "stream_offer_state unarchive failed: stream=%s offer=%s",
            stream_id,
            body.offer_id,
        )
    return {"added": True, "already": False, "stream": updated}


@router.delete("/{stream_id}/offers/{offer_id}")
async def remove_offer_from_stream(
    stream_id: int = Path(gt=0),
    offer_id: int = Path(gt=0),
    db: Session = Depends(get_db),
    keitaro: KeitaroClient = Depends(get_keitaro_with_key),
):
    """Удаление офера из потока: PUT в Keitaro c пересчитанными долями,
    при успехе — архивная строка (archive_reason="user"). Восстановить
    офер можно POST-ом (снимает архив) или через archive-эндпоинт кампании."""
    stream = await _get_stream_or_raise(keitaro, stream_id)
    _check_landings_schema(stream)

    offers = list(stream.get("offers") or [])
    entry = next((o for o in offers if o.get("offer_id") == offer_id), None)
    if entry is None:
        archived = (
            db.query(StreamOfferState)
            .filter(
                StreamOfferState.stream_id == stream_id,
                StreamOfferState.offer_id == offer_id,
                StreamOfferState.archived_at.isnot(None),
            )
            .one_or_none()
        )
        if archived is not None:
            # Уже удалён (у нас архивная строка) — идемпотентный ответ.
            return {"removed": False, "already": True, "stream": stream}
        raise HTTPException(404, "Офер не найден в потоке")

    if len(offers) == 1:
        # Поток без оферов Keitaro не принимает — PUT не делаем.
        raise HTTPException(409, "Нельзя удалить единственный офер потока")

    payload = reshare([o for o in offers if o.get("offer_id") != offer_id])
    try:
        updated = await keitaro.update_stream_offers(
            stream_id, stream.get("campaign_id"), payload
        )
    except KeitaroUnavailable as e:
        # PUT не прошёл — в БД ничего не меняем, состояние офера не тронуто.
        raise HTTPException(502, "Keitaro unavailable") from e

    try:
        _archive_offer(
            db,
            stream_id=stream_id,
            campaign_id=stream.get("campaign_id"),
            offer_id=offer_id,
            entry=entry,
            reason="user",
        )
    except Exception:
        # PUT уже прошёл — офер в Keitaro удалён; ошибка локальной записи
        # не отменяет результат, строку долечит синхронизация списком.
        logger.exception(
            "stream_offer_state archive failed after PUT: stream=%s offer=%s",
            stream_id,
            offer_id,
        )
    return {"removed": True, "already": False, "stream": updated}
