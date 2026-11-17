from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from app.keybox import KeyStore, get_key_store
from app.main import app
from app.routers.campaigns import get_keitaro_with_key

from tests.conftest import make_app_client, make_keitaro

# Тело Keitaro с «опасными» полями: whitelist обязан их вырезать.
KEITARO_CAMPAIGNS = [
    {
        "id": 211903,
        "name": "test_leo_camp_1",
        "alias": "tMsV2N",
        "state": "active",
        "group": "FORTESTS",
        "updated_at": "2026-11-17 04:21:00",
        "token": "SECRET-CAMPAIGN-TOKEN",
        "postbacks": [{"id": 1, "url": "https://postback.example"}],
        "domain": "tlgk.host",
        "traffic_source_id": 836,
    },
    {"id": 2, "name": "other_camp", "state": "disabled"},
    {"id": 3, "name": "LEO second one", "state": "active"},
]
PUBLIC_KEYS = {"id", "name", "alias", "state", "group", "updated_at"}


def _dict_wrapper_handler(request: httpx.Request) -> httpx.Response:
    # Часть сборок Keitaro отдаёт список, завёрнутый в {"campaigns": [...]}.
    return httpx.Response(200, json={"campaigns": KEITARO_CAMPAIGNS})


def _plain_list_handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json=KEITARO_CAMPAIGNS)


def _network_fail(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("boom", request=request)


def _forbidden_handler(request: httpx.Request) -> httpx.Response:
    raise AssertionError(f"Keitaro must not be called for this request: {request.url}")


class _Counter:
    def __init__(self, payload):
        self.calls = 0
        self.payload = payload

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        return httpx.Response(200, json=self.payload)


def _client(handler):
    c, _ = make_app_client(
        handler, extra_overrides={get_keitaro_with_key: lambda: make_keitaro(handler)}
    )
    return c


def _assert_public_shape(body: dict):
    assert body["stale"] is False
    for item in body["campaigns"]:
        # Ровно whitelist-набор ключей: ничего лишнего (и прежде всего token).
        assert set(item.keys()) == PUBLIC_KEYS, item.keys()
    assert "token" not in httpx.Response(200, json=body).text


@pytest.fixture(autouse=True)
def _clear_overrides():
    yield
    app.dependency_overrides.clear()


def test_empty_query_returns_empty_without_calling_keitaro():
    c = _client(_forbidden_handler)
    for q in ("", "   "):
        r = c.get("/api/campaigns", params={"query": q})
        assert r.status_code == 200
        assert r.json() == {"campaigns": [], "stale": False, "query": ""}


def test_query_filters_by_name_substring():
    c = _client(_dict_wrapper_handler)
    r = c.get("/api/campaigns", params={"query": "leo"})
    assert r.status_code == 200
    body = r.json()
    _assert_public_shape(body)
    assert [i["id"] for i in body["campaigns"]] == [211903, 3]
    assert body["query"] == "leo"
    assert body["campaigns"][0]["name"] == "test_leo_camp_1"
    assert body["campaigns"][0]["updated_at"] == "2026-11-17 04:21:00"


def test_query_is_case_insensitive_and_stripped():
    c = _client(_plain_list_handler)
    r = c.get("/api/campaigns", params={"query": "  LEO  "})
    assert r.status_code == 200
    assert [i["id"] for i in r.json()["campaigns"]] == [211903, 3]
    assert r.json()["query"] == "leo"


def test_no_matches_returns_empty_list():
    c = _client(_plain_list_handler)
    r = c.get("/api/campaigns", params={"query": "zzz-nothing"})
    assert r.status_code == 200
    assert r.json()["campaigns"] == []
    assert r.json()["stale"] is False


def test_every_request_hits_keitaro_for_fresh_data():
    counter = _Counter(KEITARO_CAMPAIGNS)
    c = _client(counter)
    for _ in range(2):
        r = c.get("/api/campaigns", params={"query": "leo"})
        assert r.status_code == 200
    assert counter.calls == 2


def test_list_never_leaks_token():
    c = _client(_dict_wrapper_handler)
    r = c.get("/api/campaigns", params={"query": "camp"})
    assert "SECRET-CAMPAIGN-TOKEN" not in r.text
    assert "postbacks" not in r.text
    assert "domain" not in r.text


def test_list_409_without_configured_key(tmp_path, monkeypatch):
    app.dependency_overrides[get_key_store] = lambda: KeyStore(tmp_path / "absent.key")
    monkeypatch.setattr(
        "app.keybox.get_settings",
        lambda: SimpleNamespace(keitaro_api_key=""),
    )
    try:
        c = TestClient(app)
        r = c.get("/api/campaigns", params={"query": "leo"})
    finally:
        app.dependency_overrides.pop(get_key_store, None)
    assert r.status_code == 409
    assert r.json() == {"detail": "API key is not configured"}


def test_list_502_when_keitaro_down():
    c = _client(_network_fail)
    r = c.get("/api/campaigns", params={"query": "leo"})
    assert r.status_code == 502
    assert r.json() == {"detail": "Keitaro unavailable"}
