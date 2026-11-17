"""Добавление офера в поток Keitaro.

Контракт согласован с брифом:
- campaign_id клиенту не доверяем — берём его из самого потока;
- PUT частичный, но share Keitaro сам не пересчитывает, поэтому присылаем
  явные целые для ВСЕХ оферов потока (100 // n, как раскладывает UI);
- дубликат offer_id отсекаем до PUT — сервер Keitaro дубликаты схлопывает.
"""

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, ConfigDict, Field

from ..keitaro import KeitaroClient, KeitaroUnavailable
from .campaigns import get_keitaro_with_key

router = APIRouter(prefix="/api/streams", tags=["streams"])


class OfferAddBody(BaseModel):
    # extra="forbid": campaign_id и прочее от клиента не принимаем —
    # источник правды по кампании это сам поток.
    model_config = ConfigDict(extra="forbid")

    offer_id: int = Field(gt=0)


def _equal_share(n: int) -> int:
    # Keitaro share сам не пересчитывает; UI раскладывает поровну с
    # округлением вниз (3 офера -> 33/33/33), повторяем это.
    return 100 // n


def _offers_payload(offers: list[dict]) -> list[dict]:
    n = len(offers)
    return [
        {"offer_id": o["offer_id"], "share": _equal_share(n), "state": o.get("state") or "active"}
        for o in offers
    ]


@router.post("/{stream_id}/offers")
async def add_offer_to_stream(
    stream_id: int = Path(gt=0),
    body: OfferAddBody = ...,
    keitaro: KeitaroClient = Depends(get_keitaro_with_key),
):
    try:
        stream = await keitaro.get_stream(stream_id)
    except KeitaroUnavailable as e:
        # KeitaroUnavailable — НЕ HTTPException, мимо except HTTPException
        # он дал бы 500 с трейсбеком; UI ждёт «Keitaro недоступен» (502).
        raise HTTPException(502, "Keitaro unavailable") from e
    except HTTPException as e:
        if e.status_code == 404:
            raise HTTPException(404, "Поток не найден") from e
        raise  # 403 permission / 502 HTML-логин — как есть

    schema = str(stream.get("schema") or "")
    if schema != "landings":
        # redirect-поток принимает offers с 200, но молча игнорирует —
        # не делаем PUT, который ничего не изменит.
        raise HTTPException(409, f"Поток не принимает оферы (schema={schema})")

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
        return {"added": False, "already": True, "stream": stream}

    offers.append({"offer_id": body.offer_id, "share": 0, "state": "active"})
    payload = _offers_payload(offers)
    try:
        updated = await keitaro.update_stream_offers(
            stream_id, stream.get("campaign_id"), payload
        )
    except KeitaroUnavailable as e:
        # PUT ретраится внутри клиента; если и он не прошёл — 502, не 500.
        raise HTTPException(502, "Keitaro unavailable") from e
    return {"added": True, "already": False, "stream": updated}
