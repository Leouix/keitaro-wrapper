"""Тесты POST /api/streams/{stream_id}/offers (добавление офера в поток).

Все запросы идут в httpx.MockTransport — в живой Keitaro тесты не ходят.
PUT-запросы считаются и запоминаются: половина контракта — «PUT НЕ делается».
"""

import json as jsonlib
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from app.keybox import KeyStore, get_key_store
from app.main import app
from app.routers.campaigns import get_keitaro_with_key

from tests.conftest import HTML_LOGIN_PAGE, PERMISSION_ERROR, make_app_client, make_keitaro

CAMPAIGN_ID = 212502
NEW_OFFER_ID = 25328
NEW_OFFER = {"id": NEW_OFFER_ID, "name": "Offer B", "payout": 2.0, "currency": "USD"}

LANDINGS_EMPTY = {
    "id": 1313230,
    "type": "regular",
    "name": "Flow empty",
    "campaign_id": CAMPAIGN_ID,
    "schema": "landings",
    "offers": [],
}

LANDINGS_3 = {
    "id": 1313231,
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

REDIRECT = {
    "id": 1313229,
    "type": "regular",
    "name": "Flow redirect",
    "campaign_id": CAMPAIGN_ID,
    "schema": "redirect",
    "offers": [],
}


OFFERS_BY_ID = {
    25327: {"id": 25327, "name": "Offer A", "payout": 1.5, "currency": "USD"},
    25328: NEW_OFFER,
}


class StreamsHandler:
    """Мокает GET /streams/{id}, GET /offers/{id} и PUT /streams/{id}.

    put_bodies — распарсенные тела всех PUT-запросов (порядок как пришли).
    put_status/text/json — что ответить на PUT (по умолчанию 200).
    """

    def __init__(self, stream):
        self.stream = stream
        self.put_bodies: list[dict] = []
        self.put_status = 200
        self.put_response_json: dict | None = None
        self.put_text: str | None = None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        method, path = request.method, request.url.path
        sid = self.stream["id"]
        if method == "GET" and path.endswith(f"/admin_api/v1/streams/{sid}"):
            return httpx.Response(200, json=self.stream)
        if method == "GET" and "/admin_api/v1/offers/" in path:
            offer_id = int(path.rsplit("/", 1)[1])
            if offer_id in OFFERS_BY_ID:
                return httpx.Response(200, json=OFFERS_BY_ID[offer_id])
            return httpx.Response(404, json={"error": "not found"})
        if method == "PUT" and path.endswith(f"/admin_api/v1/streams/{sid}"):
            self.put_bodies.append(jsonlib.loads(request.read()))
            if self.put_text is not None:
                return httpx.Response(
                    self.put_status, text=self.put_text, headers={"content-type": "text/html"}
                )
            body = self.put_response_json if self.put_response_json is not None else {
                **self.stream,
                "offers": self.put_bodies[-1]["offers"],
            }
            return httpx.Response(self.put_status, json=body)
        return httpx.Response(404, json={"error": "not found"})


def make_client(handler) -> TestClient:
    c, _ = make_app_client(
        handler, extra_overrides={get_keitaro_with_key: lambda: make_keitaro(handler)}
    )
    return c


@pytest.fixture(autouse=True)
def _clear_overrides():
    # make_client вешает overrides на общий app; без очистки они утекают
    # в следующие тесты (например, в тест «нет ключа»).
    yield
    app.dependency_overrides.clear()


def add_offer(client: TestClient, stream_id: int, offer_id: int = NEW_OFFER_ID, **extra):
    return client.post(f"/api/streams/{stream_id}/offers", json={"offer_id": offer_id, **extra})


def test_add_to_empty_landings_share_100():
    h = StreamsHandler(LANDINGS_EMPTY)
    c = make_client(h)
    r = add_offer(c, LANDINGS_EMPTY["id"])
    assert r.status_code == 200
    assert r.json()["added"] is True
    assert r.json()["already"] is False
    assert len(h.put_bodies) == 1
    assert h.put_bodies[0] == {
        "campaign_id": CAMPAIGN_ID,
        "offers": [{"offer_id": NEW_OFFER_ID, "share": 100, "state": "active"}],
    }
    # В ответе — ответ Keitaro с обновлённым списком оферов.
    assert r.json()["stream"]["offers"] == h.put_bodies[0]["offers"]


def test_add_to_three_offers_reshare_25_state_preserved():
    h = StreamsHandler(LANDINGS_3)
    c = make_client(h)
    r = add_offer(c, LANDINGS_3["id"])
    assert r.status_code == 200
    assert len(h.put_bodies) == 1
    assert h.put_bodies[0] == {
        "campaign_id": CAMPAIGN_ID,
        "offers": [
            {"offer_id": 25327, "share": 25, "state": "active"},
            {"offer_id": 25329, "share": 25, "state": "paused"},  # state сохранён
            {"offer_id": 25330, "share": 25, "state": "active"},
            {"offer_id": NEW_OFFER_ID, "share": 25, "state": "active"},  # в конец
        ],
    }
    # В PUT уходит только offer_id/share/state + campaign_id —
    # поля потока (name, type, position, ...) не трогаем.
    assert set(h.put_bodies[0].keys()) == {"campaign_id", "offers"}
    for o in h.put_bodies[0]["offers"]:
        assert set(o.keys()) == {"offer_id", "share", "state"}


def test_duplicate_offer_no_put():
    h = StreamsHandler(LANDINGS_3)
    c = make_client(h)
    r = add_offer(c, LANDINGS_3["id"], offer_id=25327)  # уже в потоке
    assert r.status_code == 200
    assert r.json() == {"added": False, "already": True, "stream": LANDINGS_3}
    assert h.put_bodies == []  # PUT не делали


def test_redirect_schema_409_no_put():
    h = StreamsHandler(REDIRECT)
    c = make_client(h)
    r = add_offer(c, REDIRECT["id"])
    assert r.status_code == 409
    assert "schema=redirect" in r.json()["detail"]
    assert h.put_bodies == []


def test_redirect_schema_checked_before_offer_lookup():
    # Порядок проверок: schema отсекается до GET /offers —
    # несуществующий офер в redirect-потоке тоже даёт 409 про schema.
    h = StreamsHandler(REDIRECT)
    c = make_client(h)
    r = add_offer(c, REDIRECT["id"], offer_id=999999)
    assert r.status_code == 409
    assert "schema=redirect" in r.json()["detail"]


def test_stream_404_message():
    h = StreamsHandler(LANDINGS_EMPTY)
    c = make_client(h)
    r = add_offer(c, 424242)  # другого потока в моке нет
    assert r.status_code == 404
    assert r.json()["detail"] == "Поток не найден"
    assert h.put_bodies == []


def test_offer_404_no_put():
    h = StreamsHandler(LANDINGS_EMPTY)
    c = make_client(h)
    r = add_offer(c, LANDINGS_EMPTY["id"], offer_id=999999)  # офера нет в моке
    assert r.status_code == 404
    assert r.json()["detail"] == "Офер не найден в Keitaro"
    assert h.put_bodies == []


def test_put_403_permission_propagates():
    h = StreamsHandler(LANDINGS_EMPTY)
    h.put_status = 403
    h.put_response_json = {"error": PERMISSION_ERROR}
    c = make_client(h)
    r = add_offer(c, LANDINGS_EMPTY["id"])
    assert r.status_code == 403
    assert "permission" in r.json()["detail"]


def test_put_html_login_502():
    h = StreamsHandler(LANDINGS_EMPTY)
    h.put_status = 403
    h.put_text = HTML_LOGIN_PAGE
    c = make_client(h)
    r = add_offer(c, LANDINGS_EMPTY["id"])
    assert r.status_code == 502
    assert "IP" in r.json()["detail"]


def test_no_api_key_409(tmp_path, monkeypatch):
    app.dependency_overrides[get_key_store] = lambda: KeyStore(tmp_path / "absent.key")
    monkeypatch.setattr(
        "app.keybox.get_settings",
        lambda: SimpleNamespace(keitaro_api_key=""),
    )
    try:
        c = TestClient(app)
        r = add_offer(c, LANDINGS_EMPTY["id"])
    finally:
        app.dependency_overrides.pop(get_key_store, None)
    assert r.status_code == 409
    assert r.json() == {"detail": "API key is not configured"}


@pytest.mark.parametrize("bad", ["0", "-1", "abc"])
def test_stream_id_must_be_positive_422(bad):
    h = StreamsHandler(LANDINGS_EMPTY)
    c = make_client(h)
    assert c.post(f"/api/streams/{bad}/offers", json={"offer_id": NEW_OFFER_ID}).status_code == 422


@pytest.mark.parametrize("bad", [0, -5])
def test_offer_id_must_be_positive_422(bad):
    h = StreamsHandler(LANDINGS_EMPTY)
    c = make_client(h)
    r = add_offer(c, LANDINGS_EMPTY["id"], offer_id=bad)
    assert r.status_code == 422
    assert h.put_bodies == []


def test_campaign_id_not_accepted_from_client():
    # campaign_id берётся из потока; присланный клиентом — отклоняется,
    # а не молча используется.
    h = StreamsHandler(LANDINGS_EMPTY)
    c = make_client(h)
    r = add_offer(c, LANDINGS_EMPTY["id"], campaign_id=999)
    assert r.status_code == 422
    assert h.put_bodies == []
