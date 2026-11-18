from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def utcnow():
    return datetime.now(timezone.utc)


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


class StreamOfferPending(Base):
    """Ожидающие изменения оферов потока (local-first).

    Страница удаляет/возвращает офер мгновенно — только в этой таблице и
    в пересчёте весов на своей стороне; в Keitaro изменения уходят одним
    PUT по кнопке «Отправить в Кейтаро» (POST .../apply).
    UNIQUE(stream_id, offer_id): у пары не может быть двух действий сразу
    — последняя правка по оферу заменяет предыдущую (PUT pending заменяет
    набор целиком).
    """

    __tablename__ = "stream_offer_pending"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    campaign_id: Mapped[int] = mapped_column(Integer, index=True)
    stream_id: Mapped[int] = mapped_column(Integer, index=True)
    offer_id: Mapped[int] = mapped_column(Integer)
    action: Mapped[str] = mapped_column(String(8))  # "add" | "remove"
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow
    )

    __table_args__ = (UniqueConstraint("stream_id", "offer_id"),)


class StreamOfferPin(Base):
    """Зафиксированный (пиновый) вес офера в потоке.

    Пин — свойство пары (stream_id, offer_id), хранится в БД и переживает
    перезагрузку. share — вес, зафиксированный в момент клика: для живого
    офера он обновляется из живого ответа Keitaro (синхронизация кампании
    и apply), для черновика (pending add) остаётся тем, что зафиксирован
    при клике. UNIQUE(stream_id, offer_id): у пары один пин, PUT .../pins
    заменяет набор целиком.
    """

    __tablename__ = "stream_offer_pin"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    campaign_id: Mapped[int] = mapped_column(Integer, index=True)
    stream_id: Mapped[int] = mapped_column(Integer, index=True)
    offer_id: Mapped[int] = mapped_column(Integer)
    share: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow
    )

    __table_args__ = (UniqueConstraint("stream_id", "offer_id"),)
