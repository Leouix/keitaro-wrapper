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

from ..constants import equal_shares
from ..db import get_db
from ..deps import get_keitaro_with_key
from ..keitaro import KeitaroClient, KeitaroUnavailable
from ..models import StreamOfferPending, StreamOfferPin, StreamOfferState, utcnow

logger = logging.getLogger(__name__)

# Правило 6 контракта пинов: detail 409 при добавлении офера в поток,
# где свободного веса нет.
PIN_NO_FREE_WEIGHT = (
    "Все оферы зафиксированы: свободного веса нет. "
    "Снимите фиксацию хотя бы с одного офера."
)

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


def _equal_split(count: int, total: int) -> list[int]:
    """Равные целые доли с суммой ровно total, остаток — первым по порядку.

    Обобщение equal_shares: _equal_split(n, 100) == equal_shares(n).
    """
    if count <= 0:
        return []
    base, rest = divmod(total, count)
    return [base + (1 if i < rest else 0) for i in range(count)]


def _scaled_to_total(values: list[int], total: int) -> list[int]:
    """Масштабировать веса к сумме total, сохранив пропорции.

    Остаток от округления добирают строки с самой большой дробной частью,
    поэтому равные веса дают прежнее «34/33/33», а 40/30/20 -> 44/33/23.
    Сумма нулей/пустой список -> равные доли total (как equal_shares).
    """
    n = len(values)
    if n == 0:
        return []
    s = sum(values)
    if s <= 0:
        return _equal_split(n, total)
    exact = [v * total / s for v in values]
    out = [int(x) for x in exact]
    leftover = total - sum(out)
    order = sorted(range(n), key=lambda i: exact[i] - out[i], reverse=True)
    for i in order[:leftover]:
        out[i] += 1
    return out


def _scaled_to_100(values: list[int]) -> list[int]:
    """Масштабировать веса к 100, сохранив пропорции."""
    return _scaled_to_total(values, 100)


def _pins_for_stream(db: Session, stream_id: int) -> dict[int, int | None]:
    """Пины потока из БД: offer_id -> share (None, если share не записан)."""
    rows = (
        db.query(StreamOfferPin)
        .filter(StreamOfferPin.stream_id == stream_id)
        .all()
    )
    return {r.offer_id: r.share for r in rows}


def _resolved_pins(
    offers: list[dict], pins: dict[int, int | None]
) -> dict[int, int]:
    """Пины финального состава с разрешённым весом (правило 2 контракта).

    Живой офер — его текущий share из Keitaro; черновик (share не пришёл) —
    share из строки пина. Пин без известного веса (нет ни в Keitaro, ни в
    БД) пином не считается и в Σпинов не попадает.
    """
    resolved: dict[int, int] = {}
    for o in offers:
        oid = o.get("offer_id")
        if oid not in pins:
            continue
        share = _share_of(o)
        if share is None:
            pin_share = pins[oid]
            if isinstance(pin_share, int) and not isinstance(pin_share, bool):
                share = pin_share
        if share is not None:
            resolved[oid] = share
    return resolved


def _check_pins_free_weight(resolved: dict[int, int], *, adding: bool) -> None:
    """Правило 6: добавлять офер нельзя, если свободного веса нет (Σпинов >= 100)."""
    if adding and sum(resolved.values()) >= 100:
        raise HTTPException(409, PIN_NO_FREE_WEIGHT)


def reshare(
    offers: list[dict],
    *,
    rescale: bool = False,
    pins: dict[int, int | None] | None = None,
) -> list[dict]:
    """Доли для PUT в Keitaro.

    Ручные веса, выставленные в Keitaro, не перетираются: офер, который
    уже живой в потоке, сохраняет свой share. Новый офер (share не пришёл
    из Keitaro) получает средний вес живых — при равных весах это ровно
    его доля в новом наборе (4×25 + новый -> новый 25, всего 125 = по 20%).
    rescale=True (удаление): веса живых масштабируются к 100 с сохранением
    пропорций, как это делает интерфейс Keitaro. Пустой список -> пустой
    payload.

    Пины (pins: offer_id -> share из stream_offer_pin):
    - запаянных в финальном составе нет — прежнее поведение без изменений;
    - остался один офер — его доля 100;
    - добавление: незапаянные (и живые, и черновики) делят 100 − Σпинов
      поровну, остаток от деления — первым по порядку потока, пины
      не меняются;
    - удаление: незапаянные живые масштабируются пропорционально на
      (100 − Σпинов); если незапаянных не осталось — пины масштабируются
      пропорционально до 100. Если в этом же apply добавляются черновики,
      свободный бюджет делится между живыми (пропорция) и черновиками
      (поровну) так, что средний вес живых равен доле каждого черновика.
    """
    if not offers:
        return []
    if len(offers) == 1:
        # Единственный офер в финальном составе — доля 100 (в прежнем коде
        # это же давали equal_shares(1) и _scaled_to_100([v])).
        return [
            {
                "offer_id": offers[0]["offer_id"],
                "share": 100,
                "state": offers[0].get("state") or "active",
            }
        ]

    resolved = _resolved_pins(offers, pins or {})
    if not resolved:
        return _reshare_plain(offers, rescale=rescale)

    free = max(0, 100 - sum(resolved.values()))
    unpinned = [o for o in offers if o["offer_id"] not in resolved]
    shares: dict[int, int] = dict(resolved)

    if not unpinned:
        if rescale:
            # Незапаянных не осталось: пины масштабируются пропорционально
            # до 100 (Σпинов == 100 — масштабирование ничего не меняет).
            scaled = _scaled_to_total(
                [resolved[o["offer_id"]] for o in offers], 100
            )
            for o, value in zip(offers, scaled):
                shares[o["offer_id"]] = value
        # Иначе (чистый add при всех запаянных) сюда не доходим: 409
        # «свободного веса нет» отдаётся до reshare.
    elif not rescale:
        # Добавление: незапаянные делят свободный бюджет поровну (правило 3).
        split = _equal_split(len(unpinned), free)
        for o, value in zip(unpinned, split):
            shares[o["offer_id"]] = value
    else:
        # Удаление: живые незапаянные — пропорционально свободному бюджету.
        drafts = [o for o in unpinned if _share_of(o) is None]
        known = [o for o in unpinned if _share_of(o) is not None]
        if not drafts:
            scaled = _scaled_to_total([_share_of(o) for o in known], free)
            for o, value in zip(known, scaled):
                shares[o["offer_id"]] = value
        else:
            known_budget = free * len(known) // (len(known) + len(drafts))
            scaled = _scaled_to_total([_share_of(o) for o in known], known_budget)
            for o, value in zip(known, scaled):
                shares[o["offer_id"]] = value
            draft_split = _equal_split(len(drafts), free - known_budget)
            for o, value in zip(drafts, draft_split):
                shares[o["offer_id"]] = value

    return [
        {
            "offer_id": o["offer_id"],
            "share": shares[o["offer_id"]],
            "state": o.get("state") or "active",
        }
        for o in offers
    ]


def _reshare_plain(offers: list[dict], *, rescale: bool) -> list[dict]:
    """Прежнее поведение reshare (без запаянных оферов) — не менялось."""
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
            split = equal_shares(len(offers))
            default = None
        for i, o in enumerate(unknown):
            if default is not None:
                shares[o["offer_id"]] = default
            else:
                shares[o["offer_id"]] = split[i]
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


def _delete_pin_quiet(db: Session, *, stream_id: int, offer_id: int) -> None:
    """Офер удалён из потока — его пин больше не имеет смысла.

    Ошибка записи не ломает 200-ответ (как с archive-строкой): пин долечит
    очистка в apply (пины оферов вне финального состава удаляются).
    """
    try:
        db.query(StreamOfferPin).filter(
            StreamOfferPin.stream_id == stream_id,
            StreamOfferPin.offer_id == offer_id,
        ).delete()
        db.commit()
    except Exception:
        db.rollback()
        logger.exception(
            "stream_offer_pin delete failed: stream=%s offer=%s",
            stream_id,
            offer_id,
        )


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
    # Правило 6: добавлять при Σпинов >= 100 нельзя (живые веса из потока).
    stream_pins = _pins_for_stream(db, stream_id)
    _check_pins_free_weight(_resolved_pins(offers, stream_pins), adding=True)
    payload = reshare(offers, pins=stream_pins)
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
    stream_pins = _pins_for_stream(db, stream_id)
    payload = reshare(
        [o for o in offers if o.get("offer_id") != offer_id],
        rescale=True,
        pins=stream_pins,
    )
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
    # Офер удалён из потока — его пин больше не имеет смысла.
    _delete_pin_quiet(db, stream_id=stream_id, offer_id=offer_id)
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


def _pins_payload(rows: list[StreamOfferPin]) -> list[dict]:
    return [
        {
            "stream_id": r.stream_id,
            "offer_id": r.offer_id,
            "share": r.share,
        }
        for r in rows
    ]


@pending_router.get("/pending")
async def get_campaign_streams_pending(
    campaign_id: int = FPath(gt=0),
    db: Session = Depends(get_db),
):
    """Ожидающие изменения кампании + пины её потоков: только локальная БД —
    без API-ключа и без похода в Keitaro (работает и при недоступном Keitaro)."""
    rows = (
        db.query(StreamOfferPending)
        .filter(StreamOfferPending.campaign_id == campaign_id)
        .order_by(StreamOfferPending.id)
        .all()
    )
    pin_rows = (
        db.query(StreamOfferPin)
        .filter(StreamOfferPin.campaign_id == campaign_id)
        .order_by(StreamOfferPin.id)
        .all()
    )
    return {"pending": _pending_payload(rows), "pins": _pins_payload(pin_rows)}


def _pending_pins_blocked(db: Session, *, stream_id: int, removes: list[int]) -> bool:
    """Правило 6 по данным БД (без Keitaro): Σпинов живых оферов >= 100.

    Живой состав — StreamOfferState (archived_at IS NULL); пины удаляемых
    оферов не считаются — их удаление освобождает вес. Если живых данных
    нет, не блокируем: финальная проверка — в apply.
    """
    live_ids = {
        r.offer_id
        for r in (
            db.query(StreamOfferState)
            .filter(
                StreamOfferState.stream_id == stream_id,
                StreamOfferState.archived_at.is_(None),
            )
            .all()
        )
    }
    if not live_ids:
        return False
    removed = set(removes)
    pins = {
        oid: share
        for oid, share in _pins_for_stream(db, stream_id).items()
        if oid in live_ids and oid not in removed
    }
    pinned_shares = [
        share for share in pins.values()
        if isinstance(share, int) and not isinstance(share, bool)
    ]
    return sum(pinned_shares) >= 100


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

    if add and _pending_pins_blocked(db, stream_id=stream_id, removes=remove):
        raise HTTPException(409, PIN_NO_FREE_WEIGHT)

    # Пины отменённых черновиков чистим после замены набора (D1): если
    # офер был в старом add, не входит в новый add и не живой в потоке,
    # его пин — зомби от отменённого черновика. Пины удаляемых оферов не
    # считаем отменёнными — их удаление легально (офер уходит из потока).
    old_adds = {
        r.offer_id
        for r in (
            db.query(StreamOfferPending)
            .filter(
                StreamOfferPending.stream_id == stream_id,
                StreamOfferPending.action == "add",
            )
            .all()
        )
    }

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
    _clear_cancelled_draft_pins(
        db, stream_id=stream_id, old_adds=old_adds, new_adds=set(add)
    )
    rows = (
        db.query(StreamOfferPending)
        .filter(StreamOfferPending.stream_id == stream_id)
        .order_by(StreamOfferPending.id)
        .all()
    )
    return {"pending": _pending_payload(rows)}


def _clear_cancelled_draft_pins(
    db: Session,
    *,
    stream_id: int,
    old_adds: set[int],
    new_adds: set[int],
) -> None:
    """Отменённые черновики: пин пары больше не имеет смысла (D1).

    Удаляем пины оферов, которые были в старом наборе pending-add, не
    входят в новый и не живые в потоке (StreamOfferState,
    archived_at IS NULL). Ошибка записи не ломает ответ (как с pending).
    """
    cancelled = old_adds - new_adds
    if not cancelled:
        return
    live_ids = {
        r.offer_id
        for r in (
            db.query(StreamOfferState)
            .filter(
                StreamOfferState.stream_id == stream_id,
                StreamOfferState.archived_at.is_(None),
            )
            .all()
        )
    }
    zombie = cancelled - live_ids
    if not zombie:
        return
    try:
        db.query(StreamOfferPin).filter(
            StreamOfferPin.stream_id == stream_id,
            StreamOfferPin.offer_id.in_(zombie),
        ).delete(synchronize_session=False)
        db.commit()
    except Exception:
        db.rollback()
        logger.exception(
            "stream_offer_pin draft-cancel cleanup failed: stream=%s offers=%s",
            stream_id,
            sorted(zombie),
        )


class PinEntryBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    offer_id: int = Field(gt=0)
    share: int | None = Field(ge=0, le=100)


class PinsBody(BaseModel):
    """Тело PUT .../pins: полный набор пинов потока (замена целиком).

    Пин — свойство пары (stream_id, offer_id): дубли внутри списка
    схлопываются (первое вхождение). share 0..100 или null. Keitaro не
    вызывается; campaign_id из пути — только группировка (как у PUT
    pending), проверка принадлежности — в apply.
    """

    model_config = ConfigDict(extra="forbid")

    pins: list[PinEntryBody]


@pending_router.put("/{stream_id}/pins")
async def put_stream_pins(
    campaign_id: int = FPath(gt=0),
    stream_id: int = FPath(gt=0),
    body: PinsBody = ...,
    db: Session = Depends(get_db),
):
    """Заменить набор пинов потока целиком (без Keitaro)."""
    seen: dict[int, int | None] = {}
    for entry in body.pins:
        seen.setdefault(entry.offer_id, entry.share)

    db.query(StreamOfferPin).filter(
        StreamOfferPin.stream_id == stream_id
    ).delete()
    for oid, share in seen.items():
        db.add(
            StreamOfferPin(
                campaign_id=campaign_id,
                stream_id=stream_id,
                offer_id=oid,
                share=share,
            )
        )
    db.commit()
    rows = (
        db.query(StreamOfferPin)
        .filter(StreamOfferPin.stream_id == stream_id)
        .order_by(StreamOfferPin.id)
        .all()
    )
    return {"pins": _pins_payload(rows)}


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


def _apply_pins_after_put(
    db: Session,
    *,
    stream_id: int,
    final_ids: list[int],
    payload_by_id: dict[int, dict],
) -> None:
    """Пины после успешного PUT: пины оферов, которых нет в финальном
    составе, удаляются; share пинов оставшихся — из PUT-payload (правило 2:
    вес запаянного живого офера — его текущий share из Keitaro, в том числе
    после пропорционального масштабирования пинов до 100)."""
    try:
        for row in (
            db.query(StreamOfferPin)
            .filter(StreamOfferPin.stream_id == stream_id)
            .all()
        ):
            if row.offer_id not in final_ids:
                db.delete(row)
                continue
            entry = payload_by_id.get(row.offer_id)
            share = entry.get("share") if entry else None
            if isinstance(share, int) and not isinstance(share, bool):
                row.share = share
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


def _clear_stale_pins_quiet(
    db: Session, *, stream_id: int, keep: set[int]
) -> None:
    """Пины оферов вне keep (ни живых, ни ожидаемых в pending) — зомби
    отменённых черновиков; удаляются без права сломать 200-ответ (D1)."""
    try:
        db.query(StreamOfferPin).filter(
            StreamOfferPin.stream_id == stream_id,
            ~StreamOfferPin.offer_id.in_(keep),
        ).delete(synchronize_session=False)
        db.commit()
    except Exception:
        db.rollback()
        logger.exception(
            "stream_offer_pin noop cleanup failed: stream=%s", stream_id
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
        # офера, которого там уже нет): очищаем pending без PUT. Заодно
        # убираем зомби-пины отменённых черновиков — оферов, которых нет
        # ни в живом составе, ни в pending (D1).
        pending_ids = {r.offer_id for r in pending_rows}
        _clear_pending_quiet(db, stream_id=stream_id)
        _clear_stale_pins_quiet(
            db, stream_id=stream_id, keep=set(live) | pending_ids
        )
        return {"applied": True, "noop": True, "stream": stream}

    final = [live_by_id[oid] for oid in final_ids if oid in live_by_id]
    final += [{"offer_id": oid, "state": "active"} for oid in final_ids if oid not in live_by_id]

    stream_pins = _pins_for_stream(db, stream_id)
    # Правило 6 (финальная проверка): добавлять при Σпинов >= 100 нельзя.
    # Пины считаются по финальному составу — пины удаляемых оферов в него
    # не входят (их удаление освобождает вес).
    if adds:
        _check_pins_free_weight(_resolved_pins(final, stream_pins), adding=True)
    payload = reshare(
        final,
        rescale=any(oid in live_by_id for oid in removes),
        pins=stream_pins,
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
        _apply_pins_after_put(
            db,
            stream_id=stream_id,
            final_ids=final_ids,
            payload_by_id=payload_by_id,
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
