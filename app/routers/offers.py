from fastapi import APIRouter, Depends, Path

from ..keitaro import KeitaroClient
from .campaigns import get_keitaro_with_key

router = APIRouter(prefix="/api/offers", tags=["offers"])


@router.get("/{offer_id}")
async def get_offer(
    offer_id: int = Path(gt=0),
    keitaro: KeitaroClient = Depends(get_keitaro_with_key),
):
    # Тело — ровно ответ Keitaro; ошибки маппит KeitaroClient
    # (403 permission → 403, HTML-логин → 502, 404 → 404).
    return await keitaro.get_offer(offer_id)
