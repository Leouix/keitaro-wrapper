"""Добавление и удаление офера в потоке Keitaro.

Контракт согласован с брифом:
- campaign_id клиенту не доверяем — берём его из самого потока;
- PUT частичный, но share Keitaro сам не пересчитывает, поэтому присылаем
  явные веса для ВСЕХ оферов потока: живой офер сохраняет свой share из
  Keitaro (ручные веса не перетираем), новый получает средний вес живых —
  при равных весах это ровно его доля (4×25 + новый -> по 25, всего 125);
- удаление: сначала PUT в Keitaro с весами, масштабированными к 100
  с сохранением пропорций (33/33/33 -> 50/50), только после
  успеха офер архивируется в stream_offer_state (archive_reason="user");
- дубликат offer_id отсекаем до PUT — сервер Keitaro дубликаты схлопывает;
  ошибка записи в БД после успешного PUT не ломает ответ — логируем и
  всё равно отдаём 200;
- запрет «нельзя удалить единственный офер» снят (2026-11-17, проверено
  живым PUT на потоке 1313077: Keitaro принимает offers: []); пустой
  landings-поток допустим;
- POST возвращает офер из архива к жизни (archived_at=None).

Страница потоков теперь работает local-first: удаление/возврат офера
мгновенно меняют только таблицу и pending (StreamOfferPending), а в
Keitaro уходит одним PUT по кнопке «Отправить в Кейтаро»
(PUT .../pending + POST .../apply). Эти старые синхронные эндпоинты
оставлены как есть для совместимости.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from fastapi import Path as FPath
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import get_keitaro_with_key
from ..keitaro import KeitaroClient, KeitaroUnavailable
from ..models import StreamOfferPending, StreamOfferState, utcnow

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/streams", tags=["streams"])
# Local-first эндпоинты: путь живёт под /api/campaigns/{cid}/streams,
# но по коду это зона streams (в Keitaro ходит только apply).
pending_router = APIRouter(
    prefix="/api/campaigns/{campaign_id}/streams", tags=["streams"]
)


class OfferAddBody(BaseModel):
    # extra="forbid": campaign_id и прочее от клиента не принимаем —
    # источник правды по кампании это сам поток.
    model_config = ConfigDict(extra="forbid")

    offer_id: int = Field(gt=0)


def _share_of(entry: dict) -> int | None:
    """Вес офера из живого ответа Keitaro (None, если Keitaro его не прислал)."""
    value = entry.get("share")
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _scaled_to_100(values: list[int]) -> list[int]:
    """Масштабировать веса к 100, сохранив пропорции.

    Остаток от округления добирают строки с самой большой дробной частью,
    поэтому равные веса дают прежнее «34/33/33», а 40/30/20 -> 44/33/23.
    """
    total = sum(values)
    if total <= 0:
        base, rest = divmod(100, len(values))
        return [base + (1 if i < rest else 0) for i in range(len(values))]
    exact = [v * 100 / total for v in values]
    out = [int(x) for x in exact]
    leftover = 100 - sum(out)
    order = sorted(range(len(exact)), key=lambda i: exact[i] - out[i], reverse=True)
    for i in order[:leftover]:
        out[i] += 1
    return out


def reshare(offers: list[dict], *, rescale: bool = False) -> list[dict]:
    """Доли для PUT в Keitaro.

    Ручные веса, выставленные в Keitaro, не перетираются: офер, который
    уже живой в потоке, сохраняет свой share. Новый офер (share не пришёл
    из Keitaro) получает средний вес живых — при равных весах это ровно
    его доля в новом наборе (4×25 + новый -> новый 25, всего 125 = по 20%).
    rescale=True (удаление): веса живых масштабируются к 100 с сохранением
    пропорций, как это делает интерфейс Keitaro. Пустой список -> пустой
    payload.
    """
    if not offers:
        return []
    known = [o for o in offers if _share_of(o) is not None]
    unknown = [o for o in offers if _share_of(o) is None]
    shares: dict[int, int] = {}
    if known:
        values = [_share_of(o) for o in known]
        if rescale:
            values = _scaled_to_100(values)
        for o, value in zip(known, values):
            shares[o["offer_id"]] = value
    if unknown:
        if shares:
            default = round(sum(shares.values()) / len(shares))
        else:
            base, rest = divmod(100, len(offers))
            default = None
        for i, o in enumerate(unknown):
            if default is not None:
                shares[o["offer_id"]] = default
            else:
                shares[o["offer_id"]] = base + (1 if i < rest else 0)
    return [
        {
            "offer_id": o["offer_id"],
            "share": shares[o["offer_id"]],
            "state": o.get("state") or "active",
        }
        for o in offers
    ]


def _lift_archive(
    db: Session,
    *,
    stream_id: int,
    campaign_id,
    offer_id: int,
    entry: dict | None = None,
    commit: bool = True,
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
    if commit:
        db.commit()


def _archive_offer(
    db: Session,
    *,
    stream_id: int,
    campaign_id,
    offer_id: int,
    entry: dict,
    reason: str,
    commit: bool = True,
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
    if commit:
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
    stream_id: int = FPath(gt=0),
    body: OfferAddBody = ...,
    db: Session = Depends(get_db),
    keitaro: KeitaroClient = Depends(get_keitaro_with_key),
):
    """Синхронное добавление офера в поток (PUT сразу в Keitaro).

    Оставлен для совместимости; страница потоков теперь ходит через
    PUT .../pending + POST .../apply (local-first)."""
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

    offers.append({"offer_id": body.offer_id, "state": "active"})
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
    stream_id: int = FPath(gt=0),
    offer_id: int = FPath(gt=0),
    db: Session = Depends(get_db),
    keitaro: KeitaroClient = Depends(get_keitaro_with_key),
):
    """Синхронное удаление офера из потока: PUT в Keitaro c пересчитанными
    долями, при успехе — архивная строка (archive_reason="user").
    Удаление последнего офера разрешено: PUT уходит с offers: [], пустой
    landings-поток допустим. Восстановить офер можно POST-ом (снимает
    архив) или через archive-эндпоинт кампании.

    Оставлен для совместимости; страница потоков теперь ходит через
    PUT .../pending + POST .../apply (local-first: удаление меняет только
    таблицу, в Keitaro уходит одним PUT по кнопке «Отправить в Кейтаро»)."""
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

    # Удаление последнего офера разрешено: Keitaro принимает offers: []
    # (проверено живым PUT на потоке 1313077, 2026-11-17).
    payload = reshare([o for o in offers if o.get("offer_id") != offer_id], rescale=True)
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


# --- Local-first: ожидающие изменения + явная отправка в Keitaro --------------

class PendingBody(BaseModel):
    """Тело PUT .../pending: полный набор ожидающих действий по потоку.

    Оба списка обязательны (пустой = «ожидающих нет»), extra="forbid":
    campaign_id и прочее от клиента не принимаем. Значения — целые > 0;
    дубли внутри списка схлопываем; один id в обоих списках — 400.
    """

    model_config = ConfigDict(extra="forbid")

    add: list[int]
    remove: list[int]

    @field_validator("add", "remove")
    @classmethod
    def _positive_ids(cls, v: list[int]) -> list[int]:
        for x in v:
            if x <= 0:
                raise ValueError("offer ids must be positive integers")
        return v


def _pending_payload(rows: list[StreamOfferPending]) -> list[dict]:
    return [
        {
            "stream_id": r.stream_id,
            "offer_id": r.offer_id,
            "action": r.action,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


@pending_router.get("/pending")
async def get_campaign_streams_pending(
    campaign_id: int = FPath(gt=0),
    db: Session = Depends(get_db),
):
    """Ожидающие изменения кампании: только локальная БД — без API-ключа
    и без похода в Keitaro (работает и при недоступном Keitaro)."""
    rows = (
        db.query(StreamOfferPending)
        .filter(StreamOfferPending.campaign_id == campaign_id)
        .order_by(StreamOfferPending.id)
        .all()
    )
    return {"pending": _pending_payload(rows)}


@pending_router.put("/{stream_id}/pending")
async def put_stream_pending(
    campaign_id: int = FPath(gt=0),
    stream_id: int = FPath(gt=0),
    body: PendingBody = ...,
    db: Session = Depends(get_db),
):
    """Заменить набор ожидающих изменений потока целиком (без Keitaro).

    campaign_id из пути — только группировка; принадлежность потока
    проверяется в apply (по campaign_id самого потока). Дубли внутри
    списка схлопываются; один id в add и remove — 400.
    """
    add = list(dict.fromkeys(body.add))
    remove = list(dict.fromkeys(body.remove))
    overlap = set(add) & set(remove)
    if overlap:
        raise HTTPException(
            400,
            "Один и тот же офер не может быть одновременно в add и remove: "
            f"{sorted(overlap)}",
        )

    db.query(StreamOfferPending).filter(
        StreamOfferPending.stream_id == stream_id
    ).delete()
    for oid in add:
        db.add(
            StreamOfferPending(
                campaign_id=campaign_id, stream_id=stream_id,
                offer_id=oid, action="add",
            )
        )
    for oid in remove:
        db.add(
            StreamOfferPending(
                campaign_id=campaign_id, stream_id=stream_id,
                offer_id=oid, action="remove",
            )
        )
    db.commit()
    rows = (
        db.query(StreamOfferPending)
        .filter(StreamOfferPending.stream_id == stream_id)
        .order_by(StreamOfferPending.id)
        .all()
    )
    return {"pending": _pending_payload(rows)}


def _apply_pending_to_db(
    db: Session,
    *,
    stream_id: int,
    campaign_id,
    live_by_id: dict[int, dict],
    payload_by_id: dict[int, dict],
    removes: list[int],
    adds: list[int],
) -> None:
    """Одна транзакция: архив для remove (share/state из живого потока),
    снятие архива для add (share из PUT-payload), очистка pending потока.
    Ошибка — полный откат, вызывающий код решает, что отвечать."""
    try:
        for oid in removes:
            entry = live_by_id.get(oid)
            if entry is not None:
                # Офера уже нет в Keitaro — архивировать нечего (не ошибка).
                _archive_offer(
                    db,
                    stream_id=stream_id,
                    campaign_id=campaign_id,
                    offer_id=oid,
                    entry=entry,
                    reason="user",
                    commit=False,
                )
        for oid in adds:
            _lift_archive(
                db,
                stream_id=stream_id,
                campaign_id=campaign_id,
                offer_id=oid,
                entry=payload_by_id.get(oid),
                commit=False,
            )
        db.query(StreamOfferPending).filter(
            StreamOfferPending.stream_id == stream_id
        ).delete()
        db.commit()
    except Exception:
        db.rollback()
        raise


def _clear_pending_quiet(db: Session, *, stream_id: int) -> None:
    """Очистка pending для noop: ошибка записи не ломает 200-ответ."""
    try:
        db.query(StreamOfferPending).filter(
            StreamOfferPending.stream_id == stream_id
        ).delete()
        db.commit()
    except Exception:
        db.rollback()
        logger.exception(
            "stream_offer_pending cleanup failed: stream=%s", stream_id
        )


@pending_router.post("/{stream_id}/apply")
async def apply_stream_pending(
    campaign_id: int = FPath(gt=0),
    stream_id: int = FPath(gt=0),
    db: Session = Depends(get_db),
    keitaro: KeitaroClient = Depends(get_keitaro_with_key),
):
    """Применить ожидающие изменения потока одним PUT в Keitaro.

    local=final вычисляется из живого списка оферов: live минус remove
    плюс add (уже существующие не дублируются, порядок add сохраняется).
    final пуст -> обычный PUT с offers: [] — пустой landings-поток
    допустим (запрет «единственный офер» снят 2026-11-17); final == live
    -> noop без PUT, pending очищается. Ошибка БД после успешного PUT
    не отменяет 200 — как в синхронных эндпоинтах.
    """
    pending_rows = (
        db.query(StreamOfferPending)
        .filter(StreamOfferPending.stream_id == stream_id)
        .order_by(StreamOfferPending.id)
        .all()
    )
    removes = [r.offer_id for r in pending_rows if r.action == "remove"]
    adds = [r.offer_id for r in pending_rows if r.action == "add"]

    stream = await _get_stream_or_raise(keitaro, stream_id)
    if int(stream.get("campaign_id") or 0) != campaign_id:
        # campaign_id в пути — только группировка; настоящий owner потока
        # решает, к какой кампании он относится.
        raise HTTPException(
            409,
            f"Поток относится к кампании {stream.get('campaign_id')}, "
            f"а не к {campaign_id}",
        )

    offers = list(stream.get("offers") or [])
    live = [o.get("offer_id") for o in offers]
    live_by_id = {o.get("offer_id"): o for o in offers}

    if pending_rows and str(stream.get("schema") or "") != "landings":
        _check_landings_schema(stream)  # 409: redirect-поток молча игнорирует offers

    final_ids = [oid for oid in live if oid not in set(removes)]
    for oid in adds:
        if oid not in final_ids:
            final_ids.append(oid)

    # Каждый add должен существовать в Keitaro (404 — pending не трогаем).
    for oid in adds:
        try:
            await keitaro.get_offer(oid)
        except KeitaroUnavailable as e:
            raise HTTPException(502, "Keitaro unavailable") from e
        except HTTPException as e:
            if e.status_code == 404:
                raise HTTPException(404, "Офер не найден в Keitaro") from e
            raise

    if final_ids == live:
        # Менять в Keitaro нечего (например, повторный apply или remove
        # офера, которого там уже нет): очищаем pending без PUT.
        _clear_pending_quiet(db, stream_id=stream_id)
        return {"applied": True, "noop": True, "stream": stream}

    final = [live_by_id[oid] for oid in final_ids if oid in live_by_id]
    final += [{"offer_id": oid, "state": "active"} for oid in final_ids if oid not in live_by_id]
    payload = reshare(
        final, rescale=any(oid in live_by_id for oid in removes)
    )
    try:
        updated = await keitaro.update_stream_offers(
            stream_id, stream.get("campaign_id"), payload
        )
    except KeitaroUnavailable as e:
        raise HTTPException(502, "Keitaro unavailable") from e

    payload_by_id = {o["offer_id"]: o for o in payload}
    added = [oid for oid in final_ids if oid not in live_by_id]
    actually_removed = [oid for oid in removes if oid in live_by_id]
    try:
        _apply_pending_to_db(
            db,
            stream_id=stream_id,
            campaign_id=stream.get("campaign_id"),
            live_by_id=live_by_id,
            payload_by_id=payload_by_id,
            removes=removes,
            adds=adds,
        )
    except Exception:
        # PUT уже прошёл — изменения в Keitaro состоялись; ошибка локальной
        # записи не отменяет результат (pending дочистит повторный apply).
        logger.exception(
            "pending apply db write failed after PUT: stream=%s", stream_id
        )
    return {
        "applied": True,
        "noop": False,
        "stream": updated,
        "added": added,
        "removed": actually_removed,
    }
