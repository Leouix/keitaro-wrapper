from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from app.keybox import KeyStore, get_key_store
from app.main import app
from app.routers.campaigns import get_keitaro_with_key

from tests.conftest import HTML_LOGIN_PAGE, PERMISSION_ERROR, make_app_client, make_keitaro

STREAMS = [
    {"id": 1, "type": "regular", "name": "Flow 1", "campaign_id": 211903, "offers": []},
    {
        "id": 2,
        "type": "regular",
        "name": "Flow 2",
        "campaign_id": 211903,
        "offers": [{"offer_id": 25327, "share": 50}],
    },
]
OFFER = {"id": 25327, "name": "Offer A", "payout": 1.5, "currency": "USD"}


def _streams_handler(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if path.endswith("/admin_api/v1/campaigns/211903/streams"):
        return httpx.Response(200, json=STREAMS)
    if path.endswith("/admin_api/v1/offers/25327"):
        return httpx.Response(200, json=OFFER)
    return httpx.Response(404, json={"error": "not found"})


@pytest.fixture()
def client():
    c, _ = make_app_client(
        _streams_handler,
        extra_overrides={get_keitaro_with_key: lambda: make_keitaro(_streams_handler)},
    )
    yield c
    app.dependency_overrides.clear()


def test_streams_passthrough_body(client):
    r = client.get("/api/campaigns/211903/streams")
    assert r.status_code == 200
    assert r.json() == STREAMS


def test_streams_404(client):
    r = client.get("/api/campaigns/999/streams")
    assert r.status_code == 404


def test_offers_passthrough_body(client):
    r = client.get("/api/offers/25327")
    assert r.status_code == 200
    assert r.json() == OFFER


def test_offers_404(client):
    r = client.get("/api/offers/999")
    assert r.status_code == 404


def test_offers_permission_json_403(client):
    def handler(request):
        return httpx.Response(403, json={"error": PERMISSION_ERROR})

    c, _ = make_app_client(handler, extra_overrides={get_keitaro_with_key: lambda: make_keitaro(handler)})
    r = c.get("/api/offers/25327")
    assert r.status_code == 403
    assert "permission" in r.json()["detail"]
    app.dependency_overrides.clear()


def test_offers_html_login_403(client):
    def handler(request):
        return httpx.Response(403, text=HTML_LOGIN_PAGE, headers={"content-type": "text/html"})

    c, _ = make_app_client(handler, extra_overrides={get_keitaro_with_key: lambda: make_keitaro(handler)})
    r = c.get("/api/offers/25327")
    assert r.status_code == 403
    assert "denied" in r.json()["detail"]
    app.dependency_overrides.clear()


@pytest.mark.parametrize("bad", ["0", "-5", "1.5", "abc", " "])
def test_streams_only_positive_int_422(client, bad):
    assert client.get(f"/api/campaigns/{bad}/streams").status_code == 422


@pytest.mark.parametrize("bad", ["0", "-1", "abc"])
def test_offers_only_positive_int_422(client, bad):
    assert client.get(f"/api/offers/{bad}").status_code == 422


def test_streams_502_when_keitaro_5xx():
    # Регрессия: GET /streams маппил KeitaroUnavailable в 500 с трейсбеком;
    # UI потока ждёт «Keitaro недоступен» (502).
    def down(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "boom"})

    c, _ = make_app_client(down, extra_overrides={get_keitaro_with_key: lambda: make_keitaro(down)})
    r = c.get("/api/campaigns/211903/streams")
    assert r.status_code == 502
    assert r.json() == {"detail": "Keitaro unavailable"}
    app.dependency_overrides.clear()


def test_offers_502_when_keitaro_5xx():
    # Регрессия: GET /api/offers маппил KeitaroUnavailable в 500; как в
    # streams/campaigns — недоступность Keitaro это 502, не 500.
    def down(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "boom"})

    c, _ = make_app_client(down, extra_overrides={get_keitaro_with_key: lambda: make_keitaro(down)})
    r = c.get("/api/offers/25327")
    assert r.status_code == 502
    assert r.json() == {"detail": "Keitaro unavailable"}
    app.dependency_overrides.clear()


def test_streams_409_without_configured_key(tmp_path, monkeypatch):
    # Нет файла ключа и нет ключа в env → 409 без похода в Keitaro.
    app.dependency_overrides[get_key_store] = lambda: KeyStore(tmp_path / "absent.key")
    monkeypatch.setattr(
        "app.keybox.get_settings",
        lambda: SimpleNamespace(keitaro_api_key=""),
    )
    try:
        c = TestClient(app)
        r = c.get("/api/campaigns/211903/streams")
    finally:
        app.dependency_overrides.pop(get_key_store, None)
    assert r.status_code == 409
    assert r.json() == {"detail": "API key is not configured"}


def test_offers_409_without_configured_key(tmp_path, monkeypatch):
    app.dependency_overrides[get_key_store] = lambda: KeyStore(tmp_path / "absent.key")
    monkeypatch.setattr(
        "app.keybox.get_settings",
        lambda: SimpleNamespace(keitaro_api_key=""),
    )
    try:
        c = TestClient(app)
        r = c.get("/api/offers/25327")
    finally:
        app.dependency_overrides.pop(get_key_store, None)
    assert r.status_code == 409
    assert r.json() == {"detail": "API key is not configured"}
