"""Тесты local-first удаления/возврата офера: PUT .../pending (набор
ожидающих изменений) и POST .../apply (один PUT в Keitaro по кнопке
«Отправить в Кейтаро»).

Все запросы идут в httpx.MockTransport — в живой Keitaro тесты не ходят;
БД — in-memory SQLite (make_app_client). Каркас StreamsHandler и
CAMPAIGN_ID переиспользуются из test_stream_offer_add, seed_state/
read_state (архив) — из test_stream_offer_delete.
"""

import httpx
import pytest

import app.routers.streams as streams_module
from app.keybox import KeyStore, get_key_store
from app.main import app
from app.models import StreamOfferPending
from app.routers.campaigns import get_keitaro_with_key

from tests.conftest import make_app_client, make_keitaro
from tests.test_stream_offer_add import CAMPAIGN_ID, StreamsHandler
from tests.test_stream_offer_delete import read_state, seed_state

STREAM_ID = 1313231
OTHER_CAMPAIGN_ID = 211903
UNKNOWN_OFFER = 999999

# Оферы, известные моку GET /offers/{id}.
OFFERS_KNOWN = {
    25327: {"id": 25327, "name": "Offer A", "payout": 1.5, "currency": "USD"},
    25328: {"id": 25328, "name": "Offer B", "payout": 2.0, "currency": "USD"},
    25331: {"id": 25331, "name": "Offer E", "payout": 0.5, "currency": "USD"},
}

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

LANDINGS_4 = {
    **LANDINGS_3,
    "offers": [
        {"offer_id": 25327, "share": 25, "state": "active"},
        {"offer_id": 25329, "share": 25, "state": "paused"},
        {"offer_id": 25330, "share": 25, "state": "active"},
        {"offer_id": 25331, "share": 25, "state": "active"},
    ],
}

LANDINGS_1 = {
    **LANDINGS_3,
    "offers": [{"offer_id": 25327, "share": 100, "state": "active"}],
}

REDIRECT = {
    **LANDINGS_3,
    "schema": "redirect",
    "offers": [],
}


class PendingHandler(StreamsHandler):
    """StreamsHandler, знающий все оферы из OFFERS_KNOWN."""

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and "/admin_api/v1/offers/" in request.url.path:
            tail = request.url.path.rsplit("/", 1)[-1]
            if tail.isdigit() and int(tail) in OFFERS_KNOWN:
                return httpx.Response(200, json=OFFERS_KNOWN[int(tail)])
            return httpx.Response(404, json={"error": "not found"})
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


def seed_pending(
    Session,
    stream_id: int,
    offer_id: int,
    action: str,
    *,
    campaign_id: int = CAMPAIGN_ID,
) -> None:
    db = Session()
    db.add(
        StreamOfferPending(
            campaign_id=campaign_id, stream_id=stream_id,
            offer_id=offer_id, action=action,
        )
    )
    db.commit()
    db.close()


def read_pending(Session, stream_id: int = STREAM_ID) -> list[tuple[int, str]]:
    db = Session()
    rows = (
        db.query(StreamOfferPending)
        .filter(StreamOfferPending.stream_id == stream_id)
        .order_by(StreamOfferPending.id)
        .all()
    )
    data = [(r.offer_id, r.action) for r in rows]
    db.close()
    return data


def put_pending(c, body, *, cid=CAMPAIGN_ID, sid=STREAM_ID):
    return c.put(f"/api/campaigns/{cid}/streams/{sid}/pending", json=body)


def apply_pending(c, *, cid=CAMPAIGN_ID, sid=STREAM_ID):
    return c.post(f"/api/campaigns/{cid}/streams/{sid}/apply")


# --- 1. PUT заменяет набор ожидающих целиком --------------------------------


def test_put_pending_replaces_whole_set_and_dedups():
    h = PendingHandler(LANDINGS_3)
    c, Session = make_client(h)

    r = put_pending(c, {"add": [25328, 25328], "remove": [25329]})
    assert r.status_code == 200
    body = r.json()["pending"]
    # Дубли схлопнуты; порядок — add, затем remove (как в теле).
    assert [(p["offer_id"], p["action"]) for p in body] == [(25328, "add"), (25329, "remove")]
    assert read_pending(Session) == [(25328, "add"), (25329, "remove")]

    # Повторный PUT заменяет набор целиком, а не дополняет.
    r2 = put_pending(c, {"add": [25330], "remove": []})
    assert r2.status_code == 200
    assert [(p["offer_id"], p["action"]) for p in r2.json()["pending"]] == [(25330, "add")]
    assert read_pending(Session) == [(25330, "add")]

    # Пустые списки = «ожидающих нет».
    r3 = put_pending(c, {"add": [], "remove": []})
    assert r3.status_code == 200
    assert r3.json()["pending"] == []
    assert read_pending(Session) == []
    assert h.put_bodies == []  # pending — без похода в Keitaro


def test_put_pending_same_id_in_both_lists_400():
    h = PendingHandler(LANDINGS_3)
    c, Session = make_client(h)
    r = put_pending(c, {"add": [25328], "remove": [25328]})
    assert r.status_code == 400
    assert "25328" in r.json()["detail"]
    assert read_pending(Session) == []


@pytest.mark.parametrize(
    "body",
    [
        {"add": [25328]},                       # нет remove
        {"remove": [25329]},                    # нет add
        {"add": [25328], "remove": [25329], "campaign_id": 5},  # лишнее поле
        {"add": [-1], "remove": []},            # отрицательный id
        {"add": [], "remove": [0]},             # нулевой id
        {"add": ["x"], "remove": []},           # не целое
    ],
)
def test_put_pending_body_validation_422(body):
    h = PendingHandler(LANDINGS_3)
    c, Session = make_client(h)
    r = put_pending(c, body)
    assert r.status_code == 422
    assert read_pending(Session) == []


# --- 2. apply: add+remove одним PUT, точные доли -----------------------------


def test_apply_add_and_remove_one_put_exact_shares():
    h = PendingHandler(LANDINGS_4)
    c, Session = make_client(h)
    put_pending(c, {"add": [25328], "remove": [25329]})

    r = apply_pending(c)
    assert r.status_code == 200
    body = r.json()
    assert body["applied"] is True
    assert body["noop"] is False
    assert body["added"] == [25328]
    assert body["removed"] == [25329]
    # Ровно один PUT: 4 живых - 1 remove + 1 add = 4 офера по 25.
    assert len(h.put_bodies) == 1
    assert h.put_bodies[0] == {
        "campaign_id": CAMPAIGN_ID,
        "offers": [
            {"offer_id": 25327, "share": 25, "state": "active"},
            {"offer_id": 25330, "share": 25, "state": "active"},
            {"offer_id": 25331, "share": 25, "state": "active"},
            {"offer_id": 25328, "share": 25, "state": "active"},
        ],
    }
    assert body["stream"]["offers"] == h.put_bodies[0]["offers"]

    # БД: архив для remove (последние share/state), живая строка для add,
    # pending очищен.
    archived = read_state(Session, STREAM_ID, 25329)
    assert archived["archived_at"] is not None
    assert archived["archive_reason"] == "user"
    assert archived["share"] == 25
    assert archived["state"] == "paused"

    live_row = read_state(Session, STREAM_ID, 25328)
    assert live_row is not None
    assert live_row["archived_at"] is None
    assert live_row["share"] == 25
    assert live_row["state"] == "active"

    assert read_pending(Session) == []


def test_apply_three_live_plus_one_add_shares_25_each():
    # 3 живых + 1 add = 4 офера -> 25/25/25/25 (порядок add в конце).
    h = PendingHandler(LANDINGS_3)
    c, Session = make_client(h)
    put_pending(c, {"add": [25328], "remove": []})

    r = apply_pending(c)
    assert r.status_code == 200
    assert h.put_bodies[0]["offers"] == [
        {"offer_id": 25327, "share": 25, "state": "active"},
        {"offer_id": 25329, "share": 25, "state": "paused"},
        {"offer_id": 25330, "share": 25, "state": "active"},
        {"offer_id": 25328, "share": 25, "state": "active"},
    ]
    assert read_pending(Session) == []


def test_apply_four_to_three_shares_34_33_33():
    h = PendingHandler(LANDINGS_4)
    c, Session = make_client(h)
    put_pending(c, {"add": [], "remove": [25331]})

    r = apply_pending(c)
    assert r.status_code == 200
    assert r.json()["removed"] == [25331]
    assert h.put_bodies[0]["offers"] == [
        {"offer_id": 25327, "share": 34, "state": "active"},
        {"offer_id": 25329, "share": 33, "state": "paused"},
        {"offer_id": 25330, "share": 33, "state": "active"},
    ]
    assert read_pending(Session) == []
    assert read_state(Session, STREAM_ID, 25331)["archive_reason"] == "user"


# --- 3. noop: Keitaro не вызывается, pending очищается -----------------------


def test_apply_noop_when_nothing_changes_no_put():
    h = PendingHandler(LANDINGS_3)
    c, Session = make_client(h)
    # add офера, который уже в потоке, remove которого там нет.
    put_pending(c, {"add": [25327], "remove": [UNKNOWN_OFFER]})

    r = apply_pending(c)
    assert r.status_code == 200
    body = r.json()
    assert body == {"applied": True, "noop": True, "stream": LANDINGS_3}
    assert h.put_bodies == []
    assert read_pending(Session) == []


def test_apply_with_empty_pending_is_noop_no_put():
    h = PendingHandler(LANDINGS_3)
    c, _ = make_client(h)
    r = apply_pending(c)
    assert r.status_code == 200
    assert r.json()["noop"] is True
    assert h.put_bodies == []


# --- 4. Отказы: 409/404, pending не тронут -----------------------------------


def test_apply_removing_last_offer_200_put_empty_and_archive_row():
    # Запрет снят: apply с remove последнего офера разрешён — один PUT
    # с offers: [], поток остаётся без оферов, офер архивируется.
    h = PendingHandler(LANDINGS_1)
    c, Session = make_client(h)
    put_pending(c, {"add": [], "remove": [25327]})

    r = apply_pending(c)
    assert r.status_code == 200
    body = r.json()
    assert body["applied"] is True
    assert body["noop"] is False
    assert body["removed"] == [25327]
    assert len(h.put_bodies) == 1
    assert h.put_bodies[0] == {"campaign_id": CAMPAIGN_ID, "offers": []}
    assert body["stream"]["offers"] == []
    # Архивная строка: последние известные share/state офера.
    archived = read_state(Session, STREAM_ID, 25327)
    assert archived is not None
    assert archived["archived_at"] is not None
    assert archived["archive_reason"] == "user"
    assert archived["share"] == 100
    assert archived["state"] == "active"
    # pending очищен.
    assert read_pending(Session) == []


def test_apply_remove_last_and_add_other_one_offer_share_100():
    # remove последнего + add другого: поток не пустеет — остаётся один
    # офер с долей 100 (PUT уходит только с новым офером).
    h = PendingHandler(LANDINGS_1)
    c, Session = make_client(h)
    put_pending(c, {"add": [25328], "remove": [25327]})

    r = apply_pending(c)
    assert r.status_code == 200
    body = r.json()
    assert body["applied"] is True
    assert body["noop"] is False
    assert body["added"] == [25328]
    assert body["removed"] == [25327]
    assert len(h.put_bodies) == 1
    assert h.put_bodies[0] == {
        "campaign_id": CAMPAIGN_ID,
        "offers": [{"offer_id": 25328, "share": 100, "state": "active"}],
    }
    assert body["stream"]["offers"] == h.put_bodies[0]["offers"]
    # 25327 архивирован (user), 25328 — живая строка с share 100.
    archived = read_state(Session, STREAM_ID, 25327)
    assert archived["archive_reason"] == "user"
    assert archived["share"] == 100
    live_row = read_state(Session, STREAM_ID, 25328)
    assert live_row is not None
    assert live_row["archived_at"] is None
    assert live_row["share"] == 100
    assert read_pending(Session) == []


class StatefulPendingHandler(PendingHandler):
    """Мок отражает успешный PUT: GET потока после него отдаёт новые offers —
    как живой Keitaro. Нужен для «повторный apply после пустого потока»."""

    def __call__(self, request: httpx.Request) -> httpx.Response:
        resp = super().__call__(request)
        if request.method == "PUT" and resp.status_code == 200:
            self.stream = {**self.stream, "offers": self.put_bodies[-1]["offers"]}
        return resp


def test_apply_again_after_emptied_stream_is_noop_no_put():
    # Регрессия на снятый запрет: первый apply опустошил поток (200, PUT
    # offers: []), повторный apply — noop без PUT (поток уже пуст).
    h = StatefulPendingHandler(LANDINGS_1)
    c, Session = make_client(h)
    put_pending(c, {"add": [], "remove": [25327]})

    r1 = apply_pending(c)
    assert r1.status_code == 200
    assert r1.json()["noop"] is False
    assert h.put_bodies == [{"campaign_id": CAMPAIGN_ID, "offers": []}]

    # В моке (как в Keitaro) поток теперь без оферов; pending пуст.
    r2 = apply_pending(c)
    assert r2.status_code == 200
    body = r2.json()
    assert body["applied"] is True
    assert body["noop"] is True
    assert body["stream"]["offers"] == []
    assert len(h.put_bodies) == 1  # второй PUT не ушёл
    assert read_pending(Session) == []


def test_apply_remove_already_gone_on_empty_stream_noop_no_put():
    # Pending с remove, а в Keitaro поток уже пуст (offers: []): менять
    # нечего — noop без PUT, pending очищается.
    h = PendingHandler({**LANDINGS_1, "offers": []})
    c, Session = make_client(h)
    put_pending(c, {"add": [], "remove": [25327]})

    r = apply_pending(c)
    assert r.status_code == 200
    assert r.json()["noop"] is True
    assert h.put_bodies == []
    assert read_pending(Session) == []


def test_apply_add_unknown_offer_404_pending_intact():
    h = PendingHandler(LANDINGS_3)
    c, Session = make_client(h)
    put_pending(c, {"add": [UNKNOWN_OFFER], "remove": []})

    r = apply_pending(c)
    assert r.status_code == 404
    assert r.json()["detail"] == "Офер не найден в Keitaro"
    assert h.put_bodies == []
    assert read_pending(Session) == [(UNKNOWN_OFFER, "add")]


def test_apply_campaign_mismatch_409_no_put():
    h = PendingHandler(LANDINGS_3)
    c, Session = make_client(h)
    seed_pending(Session, STREAM_ID, 25329, "remove", campaign_id=999)
    r = apply_pending(c, cid=999)
    assert r.status_code == 409
    assert "212502" in r.json()["detail"]
    assert h.put_bodies == []


def test_apply_redirect_schema_409_pending_intact():
    h = PendingHandler(REDIRECT)
    c, Session = make_client(h)
    put_pending(c, {"add": [25328], "remove": []})

    r = apply_pending(c)
    assert r.status_code == 409
    assert "schema=redirect" in r.json()["detail"]
    assert h.put_bodies == []
    assert read_pending(Session) == [(25328, "add")]


def test_apply_keitaro_down_502_pending_intact():
    class Down5xx(PendingHandler):
        def __call__(self, request: httpx.Request) -> httpx.Response:
            if request.method == "GET" and "/admin_api/v1/streams/" in request.url.path:
                return httpx.Response(500, json={"error": "boom"})
            return super().__call__(request)

    h = Down5xx(LANDINGS_3)
    c, Session = make_client(h)
    put_pending(c, {"add": [25328], "remove": [25329]})

    r = apply_pending(c)
    assert r.status_code == 502
    assert r.json() == {"detail": "Keitaro unavailable"}
    assert read_pending(Session) == [(25328, "add"), (25329, "remove")]


# --- 5. Ошибка БД после успешного PUT не отменяет 200 ------------------------


def test_apply_db_error_after_put_still_200(monkeypatch):
    h = PendingHandler(LANDINGS_3)
    c, Session = make_client(h)
    put_pending(c, {"add": [25328], "remove": [25329]})

    def broken(*args, **kwargs):
        raise RuntimeError("db exploded")

    monkeypatch.setattr(streams_module, "_apply_pending_to_db", broken)
    r = apply_pending(c)
    assert r.status_code == 200
    body = r.json()
    assert body["applied"] is True
    assert body["noop"] is False
    assert len(h.put_bodies) == 1
    # PUT прошёл, локальная запись нет — pending остался на повторный apply.
    assert read_pending(Session) == [(25328, "add"), (25329, "remove")]


# --- 6. GET pending: только своя кампания, порядок по id ---------------------


def test_get_pending_only_own_campaign_ordered_by_id():
    h = PendingHandler(LANDINGS_3)
    c, Session = make_client(h)
    seed_pending(Session, STREAM_ID, 25328, "add")
    seed_pending(Session, STREAM_ID, 25329, "remove")
    seed_pending(Session, 777, 25330, "add", campaign_id=OTHER_CAMPAIGN_ID)

    r = c.get(f"/api/campaigns/{CAMPAIGN_ID}/streams/pending")
    assert r.status_code == 200
    rows = r.json()["pending"]
    assert [(p["stream_id"], p["offer_id"], p["action"]) for p in rows] == [
        (STREAM_ID, 25328, "add"),
        (STREAM_ID, 25329, "remove"),
    ]
    assert set(rows[0].keys()) == {"stream_id", "offer_id", "action", "created_at"}
    assert rows[0]["created_at"] is not None

    r2 = c.get(f"/api/campaigns/{OTHER_CAMPAIGN_ID}/streams/pending")
    assert r2.status_code == 200
    rows2 = r2.json()["pending"]
    assert [(p["stream_id"], p["offer_id"], p["action"]) for p in rows2] == [
        (777, 25330, "add")
    ]


# --- 7. pending работает без API-ключа (apply — нет) -------------------------


def test_pending_without_api_key_but_apply_needs_one(tmp_path, monkeypatch):
    h = PendingHandler(LANDINGS_3)
    c, Session = make_app_client(h)
    # Никакого ключа нет: data-эндпоинты дают 409, pending всё равно работает.
    app.dependency_overrides[get_key_store] = lambda: KeyStore(tmp_path / "absent.key")
    monkeypatch.setattr(
        "app.keybox.get_settings", lambda: __import__("types").SimpleNamespace(keitaro_api_key="")
    )

    r_streams = c.get(f"/api/campaigns/{CAMPAIGN_ID}/streams")
    assert r_streams.status_code == 409
    assert r_streams.json() == {"detail": "API key is not configured"}

    r_put = put_pending(c, {"add": [25328], "remove": []})
    assert r_put.status_code == 200
    assert read_pending(Session) == [(25328, "add")]

    r_get = c.get(f"/api/campaigns/{CAMPAIGN_ID}/streams/pending")
    assert r_get.status_code == 200
    assert len(r_get.json()["pending"]) == 1

    r_apply = apply_pending(c)
    assert r_apply.status_code == 409
    assert r_apply.json() == {"detail": "API key is not configured"}
    assert h.put_bodies == []


# --- 8. Синхронизация не трогает pending -------------------------------------


def test_sync_keeps_pending_rows():
    from tests.test_stream_offer_delete import CampaignStreamsHandler

    sync_payload = [
        {
            **LANDINGS_3,
            # Внешние изменения Keitaro: 25329 пропал, доля 25327 сменилась.
            "offers": [
                {"offer_id": 25327, "share": 40, "state": "active"},
                {"offer_id": 25330, "share": 60, "state": "active"},
            ],
        }
    ]
    h = CampaignStreamsHandler(LANDINGS_3, sync_payload)
    c, Session = make_client(h)
    seed_state(Session, STREAM_ID, 25329, share=33, state="paused")  # живая строка
    put_pending(c, {"add": [25328], "remove": []})

    r = c.get(f"/api/campaigns/{CAMPAIGN_ID}/streams")
    assert r.status_code == 200
    # stream_offer_state сверился с Keitaro, pending не потерялся и не очищен.
    gone = read_state(Session, STREAM_ID, 25329)
    assert gone["archive_reason"] == "keitaro"
    assert read_pending(Session) == [(25328, "add")]
