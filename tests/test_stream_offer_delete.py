"""Тесты DELETE /api/streams/{stream_id}/offers/{offer_id} и связанной
архитектуры архива: stream_offer_state, восстановление POST-ом,
GET /api/campaigns/{id}/streams/archive и синхронизации списком.

Все запросы идут в httpx.MockTransport — в живой Keitaro тесты не ходят.
Каркас (make_app_client, StreamsHandler) переиспользуется из
test_stream_offer_add.py; здесь добавляется только мок списка потоков
кампании для синхронизации.
"""

import httpx
import pytest

from sqlalchemy import event

from app.keybox import KeyStore, get_key_store
from app.main import app
from app.models import StreamOfferState, utcnow
from app.deps import get_keitaro_with_key
from app.routers.campaigns import sync_stream_offer_state
from app.routers.streams import reshare

from tests.conftest import HTML_LOGIN_PAGE, make_app_client, make_keitaro
from tests.test_stream_offer_add import CAMPAIGN_ID, StreamsHandler

STREAM_ID = 1313231

LANDINGS_3 = {
    "id": STREAM_ID,
    "type": "regular",
    "name": "Flow 3",
    "campaign_id": CAMPAIGN_ID,
    "schema": "landings",
    "offers": [
        {"offer_id": 25327, "share": 33, "state": "active"},
        {"offer_id": 25329, "share": 33, "state": "paused"},
        {"offer_id": 25330, "share": 33, "state": "active"},
    ],
}

# Поток, из которого офер 25329 уже удалён (payload после PUT).
LANDINGS_AFTER = {
    **LANDINGS_3,
    "offers": [
        {"offer_id": 25327, "share": 50, "state": "active"},
        {"offer_id": 25330, "share": 50, "state": "active"},
    ],
}

LANDINGS_1 = {
    **LANDINGS_3,
    "offers": [{"offer_id": 25327, "share": 100, "state": "active"}],
}

# Payload синхронизации: 25327 ещё жив (share изменился), 25329 пропал,
# 25330 добавлен на стороне Keitaro.
SYNC_PAYLOAD = [
    {
        "id": STREAM_ID,
        "type": "regular",
        "name": "Flow 3",
        "campaign_id": CAMPAIGN_ID,
        "schema": "landings",
        "offers": [
            {"offer_id": 25327, "share": 40, "state": "active"},
            {"offer_id": 25330, "share": 60, "state": "active"},
        ],
    }
]


class CampaignStreamsHandler(StreamsHandler):
    """StreamsHandler + мок GET /campaigns/{id}/streams (список потоков)."""

    def __init__(self, stream, streams_payload):
        super().__init__(stream)
        self.streams_payload = streams_payload

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method == "GET" and path.endswith(
            f"/admin_api/v1/campaigns/{CAMPAIGN_ID}/streams"
        ):
            return httpx.Response(200, json=self.streams_payload)
        return super().__call__(request)


# Оферы LANDINGS_3, которых нет в базовом OFFERS_BY_ID каркаса:
# POST-восстановление проверяет get_offer до снятия архива.
OFFERS_EXTRA = {
    25329: {"id": 25329, "name": "Offer C", "payout": 1.0, "currency": "USD"},
    25330: {"id": 25330, "name": "Offer D", "payout": 3.0, "currency": "USD"},
}


class DeleteStreamsHandler(StreamsHandler):
    """StreamsHandler, знающий все оферы LANDINGS_3."""

    def __call__(self, request: httpx.Request) -> httpx.Response:
        offer_id = request.url.path.rsplit("/", 1)[-1]
        if request.method == "GET" and "/admin_api/v1/offers/" in request.url.path:
            if offer_id.isdigit() and int(offer_id) in OFFERS_EXTRA:
                return httpx.Response(200, json=OFFERS_EXTRA[int(offer_id)])
        return super().__call__(request)


def make_client(handler) -> tuple:
    c, Session = make_app_client(
        handler, extra_overrides={get_keitaro_with_key: lambda: make_keitaro(handler)}
    )
    return c, Session


@pytest.fixture(autouse=True)
def _clear_overrides():
    # overrides вешаются на общий app; без очистки они утекают в следующие тесты.
    yield
    app.dependency_overrides.clear()


def delete_offer(c, stream_id: int = STREAM_ID, offer_id: int = 25329):
    return c.delete(f"/api/streams/{stream_id}/offers/{offer_id}")


def seed_state(
    Session,
    stream_id: int,
    offer_id: int,
    *,
    campaign_id: int = CAMPAIGN_ID,
    share=None,
    state=None,
    archived_at=None,
    archive_reason=None,
) -> None:
    db = Session()
    db.add(
        StreamOfferState(
            stream_id=stream_id,
            offer_id=offer_id,
            campaign_id=campaign_id,
            share=share,
            state=state,
            archived_at=archived_at,
            archive_reason=archive_reason,
        )
    )
    db.commit()
    db.close()


def read_state(Session, stream_id: int, offer_id: int) -> dict | None:
    db = Session()
    row = (
        db.query(StreamOfferState)
        .filter(
            StreamOfferState.stream_id == stream_id,
            StreamOfferState.offer_id == offer_id,
        )
        .one_or_none()
    )
    data = None
    if row is not None:
        data = {
            "campaign_id": row.campaign_id,
            "share": row.share,
            "state": row.state,
            "last_seen_at": row.last_seen_at,
            "archived_at": row.archived_at,
            "archive_reason": row.archive_reason,
        }
    db.close()
    return data


# --- 1. Успешное удаление: один PUT, пересчёт долей, архивная строка ---------


def test_delete_three_offers_one_put_reshare_and_archive_row():
    h = StreamsHandler(LANDINGS_3)
    c, Session = make_client(h)
    r = delete_offer(c)
    assert r.status_code == 200
    body = r.json()
    assert body["removed"] is True
    assert body["already"] is False
    # Ровно один PUT: оставшимся двум оферам 50/50, состояние сохранено.
    assert len(h.put_bodies) == 1
    assert h.put_bodies[0] == {
        "campaign_id": CAMPAIGN_ID,
        "offers": [
            {"offer_id": 25327, "share": 50, "state": "active"},
            {"offer_id": 25330, "share": 50, "state": "active"},
        ],
    }
    # В ответе — обновлённый поток из Keitaro.
    assert body["stream"]["offers"] == h.put_bodies[0]["offers"]
    # Архивная строка: последние известные share/state удалённого офера.
    row = read_state(Session, STREAM_ID, 25329)
    assert row is not None
    assert row["campaign_id"] == CAMPAIGN_ID
    assert row["share"] == 33  # доля удалённого на момент удаления
    assert row["state"] == "paused"
    assert row["archived_at"] is not None
    assert row["archive_reason"] == "user"
    assert row["last_seen_at"] is not None


def test_delete_put_body_only_offers_and_campaign():
    # В PUT уходят только campaign_id и offers (без name/type/... потока).
    h = StreamsHandler(LANDINGS_3)
    c, _ = make_client(h)
    delete_offer(c)
    assert set(h.put_bodies[0].keys()) == {"campaign_id", "offers"}
    for o in h.put_bodies[0]["offers"]:
        assert set(o.keys()) == {"offer_id", "share", "state"}
    # Удаление масштабирует оставшиеся веса к 100 с сохранением пропорций:
    # 2 офера 33/33 -> 50/50.
    assert reshare(LANDINGS_3["offers"][:2], rescale=True) == [
        {"offer_id": 25327, "share": 50, "state": "active"},
        {"offer_id": 25329, "share": 50, "state": "paused"},
    ]


# --- 2. Единственный офер: 200, один PUT с offers: [], архивная строка -------


def test_delete_last_offer_200_put_empty_and_archive_row():
    # Запрет снят: удаление единственного офера разрешено — поток уходит
    # в Keitaro с пустым списком оферов (offers: []), офер архивируется.
    h = StreamsHandler(LANDINGS_1)
    c, Session = make_client(h)
    r = delete_offer(c, offer_id=25327)
    assert r.status_code == 200
    body = r.json()
    assert body["removed"] is True
    assert body["already"] is False
    # Ровно один PUT: пустой список оферов.
    assert len(h.put_bodies) == 1
    assert h.put_bodies[0] == {"campaign_id": CAMPAIGN_ID, "offers": []}
    # В ответе — обновлённый поток из Keitaro (мок отражает PUT-тело).
    assert body["stream"]["offers"] == []
    # Архивная строка: последние известные share/state удалённого офера.
    row = read_state(Session, STREAM_ID, 25327)
    assert row is not None
    assert row["campaign_id"] == CAMPAIGN_ID
    assert row["share"] == 100  # доля единственного офера на момент удаления
    assert row["state"] == "active"
    assert row["archived_at"] is not None
    assert row["archive_reason"] == "user"
    assert row["last_seen_at"] is not None


class StatefulStreamsHandler(StreamsHandler):
    """Мок отражает успешный PUT: GET потока после него отдаёт новые offers —
    как живой Keitaro. Нужен для «повторное удаление после пустого потока»."""

    def __call__(self, request: httpx.Request) -> httpx.Response:
        resp = super().__call__(request)
        if request.method == "PUT" and resp.status_code == 200:
            self.stream = {**self.stream, "offers": self.put_bodies[-1]["offers"]}
        return resp


def test_delete_last_offer_twice_second_is_already_no_put():
    # После опустошения потока повторное удаление — идемпотентный noop
    # без второго PUT: архивная строка уже есть.
    h = StatefulStreamsHandler(LANDINGS_1)
    c, Session = make_client(h)
    r1 = delete_offer(c, offer_id=25327)
    assert r1.status_code == 200
    assert h.put_bodies == [{"campaign_id": CAMPAIGN_ID, "offers": []}]

    before = read_state(Session, STREAM_ID, 25327)
    r2 = delete_offer(c, offer_id=25327)
    assert r2.status_code == 200
    assert r2.json() == {
        "removed": False,
        "already": True,
        "stream": {**LANDINGS_1, "offers": []},
    }
    assert h.put_bodies == [{"campaign_id": CAMPAIGN_ID, "offers": []}]  # второй PUT не ушёл
    assert read_state(Session, STREAM_ID, 25327) == before


def test_delete_redirect_stream_409_no_put():
    # Регрессия: redirect-поток по-прежнему не принимает оферы —
    # 409 до offer-lookup, PUT не уходит (снятие запрета этого не меняет).
    REDIRECT = {**LANDINGS_1, "schema": "redirect"}
    h = StreamsHandler(REDIRECT)
    c, Session = make_client(h)
    r = delete_offer(c, offer_id=25327)
    assert r.status_code == 409
    assert "schema=redirect" in r.json()["detail"]
    assert h.put_bodies == []
    assert read_state(Session, STREAM_ID, 25327) is None


# --- 3. Офера нет ни в потоке, ни в архиве: 404 ------------------------------


def test_delete_unknown_offer_404_no_put():
    h = StreamsHandler(LANDINGS_3)
    c, Session = make_client(h)
    r = delete_offer(c, offer_id=999999)
    assert r.status_code == 404
    assert r.json()["detail"] == "Офер не найден в потоке"
    assert h.put_bodies == []
    assert read_state(Session, STREAM_ID, 999999) is None


# --- 4. Повторное удаление уже удалённого: идемпотентный 200 -----------------


def test_delete_already_archived_idempotent_no_put():
    h = StreamsHandler(LANDINGS_AFTER)  # 25329 в живом payload больше нет
    c, Session = make_client(h)
    seed_state(
        Session, STREAM_ID, 25329, share=33, state="paused",
        archived_at=utcnow(), archive_reason="user",
    )
    before = read_state(Session, STREAM_ID, 25329)
    r = delete_offer(c)
    assert r.status_code == 200
    assert r.json() == {"removed": False, "already": True, "stream": LANDINGS_AFTER}
    assert h.put_bodies == []
    # Архивная строка не перезаписывается повторным удалением.
    after = read_state(Session, STREAM_ID, 25329)
    assert after == before


# --- 5. PUT в Keitaro падает: 502, БД не тронута -----------------------------


@pytest.mark.parametrize(
    "fail",
    [
        "5xx",  # Keitaro отдаёт 500, ретраи исчерпаны
        "html-login",  # 403 + HTML вместо JSON (не ключ-JSON, значит отказ в правах)
    ],
)
def test_delete_put_failure_502_db_untouched(fail):
    h = StreamsHandler(LANDINGS_3)
    if fail == "5xx":
        h.put_status = 500
    else:
        h.put_status = 403
        h.put_text = HTML_LOGIN_PAGE
    c, Session = make_client(h)
    seed_state(Session, STREAM_ID, 25329, share=33, state="paused")  # живая строка
    before = read_state(Session, STREAM_ID, 25329)
    r = delete_offer(c)
    if fail == "html-login":
        # 401/403 от Keitaro всегда 403 — и в БД тоже НЕ появляется архивная строка.
        assert r.status_code == 403
        assert "denied" in r.json()["detail"]
    else:
        assert r.status_code == 502
        assert r.json() == {"detail": "Keitaro unavailable"}
    # Откат: строка осталась живой, без архивных полей.
    after = read_state(Session, STREAM_ID, 25329)
    assert after == before
    assert after["archived_at"] is None
    assert after["archive_reason"] is None


# --- 6. Восстановление офера POST-ом -----------------------------------------


def test_post_restores_user_archived_offer_no_put():
    h = DeleteStreamsHandler(LANDINGS_3)
    c, Session = make_client(h)
    # Шаг 1: удаляем (PUT + архивная строка).
    r = delete_offer(c)
    assert r.status_code == 200
    assert read_state(Session, STREAM_ID, 25329)["archive_reason"] == "user"
    # Шаг 2: POST тем же offer_id снимает архив. Офер в мок-потоке есть,
    # поэтому PUT не нужен.
    r2 = c.post(f"/api/streams/{STREAM_ID}/offers", json={"offer_id": 25329})
    assert r2.status_code == 200
    assert r2.json()["added"] is False
    assert r2.json()["already"] is True
    # PUT был только на шаге удаления; восстановление без PUT.
    assert len(h.put_bodies) == 1
    row = read_state(Session, STREAM_ID, 25329)
    assert row["archived_at"] is None
    assert row["archive_reason"] is None
    assert row["share"] == 33  # восстановлен по данным потока
    assert row["state"] == "paused"


def test_post_lifts_keitaro_archive_row_no_put():
    # Строка, заархивированная синхронизацией (reason="keitaro"),
    # снимается тем же POST-ом.
    h = DeleteStreamsHandler(LANDINGS_3)
    c, Session = make_client(h)
    seed_state(
        Session, STREAM_ID, 25329, share=33, state="paused",
        archived_at=utcnow(), archive_reason="keitaro",
    )
    r = c.post(f"/api/streams/{STREAM_ID}/offers", json={"offer_id": 25329})
    assert r.status_code == 200
    assert r.json()["already"] is True
    assert h.put_bodies == []
    row = read_state(Session, STREAM_ID, 25329)
    assert row["archived_at"] is None
    assert row["archive_reason"] is None


# --- 7. GET /api/campaigns/{id}/streams/archive ------------------------------


def test_archive_endpoint_fields_and_ordering():
    h = StreamsHandler(LANDINGS_3)
    c, Session = make_client(h)
    older = utcnow()
    newer = utcnow()
    seed_state(Session, STREAM_ID, 25329, share=33, state="paused",
               archived_at=older, archive_reason="user")
    seed_state(Session, STREAM_ID, 25330, share=10, state="active",
               archived_at=newer, archive_reason="keitaro")
    r = c.get(f"/api/campaigns/{CAMPAIGN_ID}/streams/archive")
    assert r.status_code == 200
    rows = r.json()["archived"]
    assert [row["offer_id"] for row in rows] == [25330, 25329]  # новые сверху
    top = rows[0]
    assert set(top.keys()) == {
        "stream_id", "offer_id", "share", "state", "archived_at", "reason",
    }
    assert top["stream_id"] == STREAM_ID
    assert top["share"] == 10
    assert top["state"] == "active"
    assert top["reason"] == "keitaro"
    # SQLite отдаёт datetime без таймзоны — сравниваем наивную форму.
    assert top["archived_at"] == newer.replace(tzinfo=None).isoformat()


def test_archive_endpoint_works_without_api_key(tmp_path):
    h = StreamsHandler(LANDINGS_3)
    c, Session = make_client(h)
    # Реальная проверка ключа вместо тестового оверрайда: файла ключа нет
    # (env-фолбэка больше нет) — data-эндпоинты дают 409, а архив всё равно 200.
    app.dependency_overrides.pop(get_keitaro_with_key, None)
    app.dependency_overrides[get_key_store] = lambda: KeyStore(tmp_path / "absent.key")
    seed_state(Session, STREAM_ID, 25329, share=33, state="paused",
               archived_at=utcnow(), archive_reason="user")

    r_streams = c.get(f"/api/campaigns/{CAMPAIGN_ID}/streams")
    assert r_streams.status_code == 409
    assert r_streams.json() == {"detail": "API key is not configured"}

    r_arch = c.get(f"/api/campaigns/{CAMPAIGN_ID}/streams/archive")
    assert r_arch.status_code == 200
    rows = r_arch.json()["archived"]
    assert len(rows) == 1
    assert rows[0]["offer_id"] == 25329
    assert rows[0]["reason"] == "user"


# --- 8. Синхронизация списком ------------------------------------------------


def test_sync_constant_number_of_queries():
    """Регрессия N+1 SQL: sync делал SELECT на каждый офер каждого потока
    (K×N запросов). Теперь — одна выборка WHERE stream_id IN (...) плюс
    выборка на архивацию, независимо от числа потоков и оферов."""
    streams = [
        {
            "id": STREAM_ID + i,
            "type": "regular",
            "name": f"Flow {i}",
            "campaign_id": CAMPAIGN_ID,
            "schema": "landings",
            "offers": [
                {"offer_id": 25327 + j, "share": 10, "state": "active"}
                for j in range(3)
            ],
        }
        for i in range(4)  # 4 потока × 3 офера — раньше было бы 12 SELECT'ов
    ]
    c, Session = make_client(CampaignStreamsHandler(LANDINGS_3, streams))
    db = Session()
    engine = db.get_bind()
    statements: list[str] = []

    def before_cursor_execute(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", before_cursor_execute)
    try:
        sync_stream_offer_state(db, CAMPAIGN_ID, streams)
    finally:
        event.remove(engine, "before_cursor_execute", before_cursor_execute)
    selects = [s for s in statements if s.lstrip().upper().startswith("SELECT")]
    assert len(selects) <= 3

    # Функциональный итог не изменился: все 12 пар живые.
    rows = (
        db.query(StreamOfferState)
        .filter(StreamOfferState.campaign_id == CAMPAIGN_ID)
        .all()
    )
    assert len(rows) == 12
    for row in rows:
        assert row.archived_at is None
    db.close()


def test_sync_archives_missing_and_upserts_live_offers():
    h = CampaignStreamsHandler(LANDINGS_3, SYNC_PAYLOAD)
    c, Session = make_client(h)
    # 25327 — живой (upsert), 25329 — живой, но пропал из payload (архив),
    # 999 — уже архивный (не перезаписывается).
    seed_state(Session, STREAM_ID, 25327, share=33, state="active")
    seed_state(Session, STREAM_ID, 25329, share=33, state="paused")
    seed_state(Session, STREAM_ID, 999, share=7, state="active",
               archived_at=utcnow(), archive_reason="user")
    before_999 = read_state(Session, STREAM_ID, 999)

    r = c.get(f"/api/campaigns/{CAMPAIGN_ID}/streams")
    assert r.status_code == 200
    assert r.json() == SYNC_PAYLOAD  # тело — ровно ответ Keitaro
    assert h.put_bodies == []  # синхронизация без PUT

    # Живой офер: upsert (новая доля), архив не ставится.
    live = read_state(Session, STREAM_ID, 25327)
    assert live["share"] == 40
    assert live["state"] == "active"
    assert live["archived_at"] is None
    assert live["archive_reason"] is None

    # Пропавший из payload: архив reason="keitaro".
    gone = read_state(Session, STREAM_ID, 25329)
    assert gone["archived_at"] is not None
    assert gone["archive_reason"] == "keitaro"
    assert gone["share"] == 33  # последние известные данные сохранены

    # Новый для нас офер: заведена живая строка.
    added = read_state(Session, STREAM_ID, 25330)
    assert added is not None
    assert added["archived_at"] is None
    assert added["campaign_id"] == CAMPAIGN_ID
    assert added["share"] == 60

    # Уже архивная строка не тронута (не «перезаписана» reason="keitaro").
    assert read_state(Session, STREAM_ID, 999) == before_999
