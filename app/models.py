from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def utcnow():
    return datetime.now(timezone.utc)


class CampaignCache(Base):
    __tablename__ = "campaigns"
    keitaro_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String, index=True)
    payload: Mapped[dict] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class StreamOfferState(Base):
    """Последнее известное состояние офера в потоке.

    archived_at IS NULL — офер живой в потоке (по нашим данным);
    архивная строка хранит последние известные share/state и причину
    archive_reason: "user" (удалили через обёртку) или "keitaro"
    (офер пропал из потока на стороне Keitaro).
    """

    __tablename__ = "stream_offer_state"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    stream_id: Mapped[int] = mapped_column(Integer, index=True)
    offer_id: Mapped[int] = mapped_column(Integer)
    campaign_id: Mapped[int] = mapped_column(Integer, index=True)
    share: Mapped[int | None] = mapped_column(Integer, nullable=True)
    state: Mapped[str | None] = mapped_column(String, nullable=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    archived_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    archive_reason: Mapped[str | None] = mapped_column(String, nullable=True)

    __table_args__ = (UniqueConstraint("stream_id", "offer_id"),)
