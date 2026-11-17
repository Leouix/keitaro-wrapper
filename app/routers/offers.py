from fastapi import APIRouter, Depends, HTTPException, Path

from ..keitaro import KeitaroClient, KeitaroUnavailable
from .campaigns import get_keitaro_with_key

router = APIRouter(prefix="/api/offers", tags=["offers"])


@router.get("/{offer_id}")
async def get_offer(
    offer_id: int = Path(gt=0),
    keitaro: KeitaroClient = Depends(get_keitaro_with_key),
):
    # Тело — ровно ответ Keitaro; 404/403/502(HTML-логин) маппит KeitaroClient,
    # недоступность (5xx/сеть после ретряев) переводим в 502 — как в streams/campaigns.
    try:
        return await keitaro.get_offer(offer_id)
    except KeitaroUnavailable as e:
        raise HTTPException(502, "Keitaro unavailable") from e
