from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..keitaro import KeitaroClient, KeitaroUnavailable
from ..models import CampaignCache

router = APIRouter(prefix="/api/campaigns", tags=["campaigns"])


def get_keitaro() -> KeitaroClient:
    return KeitaroClient()


def _upsert(db: Session, campaigns: list[dict]):
    for c in campaigns:
        row = db.get(CampaignCache, c.get("id"))
        if row is None:
            db.add(CampaignCache(keitaro_id=c["id"], name=str(c.get("name", "")), payload=c))
        else:
            row.name = str(c.get("name", row.name))
            row.payload = c
    db.commit()


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
