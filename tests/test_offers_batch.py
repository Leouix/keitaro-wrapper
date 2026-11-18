"""Тесты батч-эндпоинта GET /api/offers?ids=1,2,3 (фаза 2).

Контракт: один запрос фронта на страницу оферов; ошибка/403/404/502
одного офера не валит весь батч — ошибки собираются в errors с кодом
и текстом, 403 доходит до фронта как есть («Keitaro permission denied»).
Старый GET /api/offers/{id} при этом не тронут.
"""

import httpx
import pytest
from fastapi.testclient import TestClient

from app.keybox import KeyStore, get_key_store
from app.main import app
from app.deps import get_keitaro_with_key

from tests.conftest import PERMISSION_ERROR, make_app_client, make_keitaro

OFFERS = {
    1: {"id": 1, "name": "Offer 1", "payout": 1.0, "currency": "USD"},
    2: {"id": 2, "name": "Offer 2", "payout": 2.0, "currency": "USD"},
}


class BatchHandler:
    """Считает походы в Keitaro по каждому оферу и возвращает заданный код."""

    def __init__(self, overrides: dict[int, tuple[int, dict | str]]):
        self.overrides = overrides
        self.calls: list[int] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if "/admin_api/v1/offers/" not in path:
            return httpx.Response(404, json={"error": "not found"})
        oid = int(path.rsplit("/", 1)[-1])
        self.calls.append(oid)
        code, payload = self.overrides.get(oid, (200, OFFERS.get(oid, {"id": oid})))
        if code == 403:
            return httpx.Response(403, json={"error": PERMISSION_ERROR})
        if isinstance(payload, str):
            return httpx.Response(code, text=payload)
        return httpx.Response(code, json=payload)


def _client(handler):
    c, _ = make_app_client(
        handler, extra_overrides={get_keitaro_with_key: lambda: make_keitaro(handler)}
    )
    return c


def test_batch_mixed_ok_and_errors():
    h = BatchHandler(
        {
            3: (404, {"error": "not found"}),
            4: (403, {"error": PERMISSION_ERROR}),
            5: (500, "boom"),
            6: (200, "not json"),
        }
    )
    r = _client(h).get("/api/offers", params={"ids": "1,2,3,4,5,6"})
    assert r.status_code == 200
    body = r.json()
    assert [o["id"] for o in body["offers"]] == [1, 2]
    assert body["errors"] == [
        {"offer_id": 3, "status": 404, "detail": "Not found in Keitaro"},
        {
            "offer_id": 4,
            "status": 403,
            "detail": f"Keitaro permission denied: {PERMISSION_ERROR}",
        },
        {"offer_id": 5, "status": 502, "detail": "Keitaro unavailable"},
        {"offer_id": 6, "status": 502, "detail": "Keitaro returned non-JSON response"},
    ]


def test_batch_all_ok_no_errors():
    r = _client(BatchHandler({})).get("/api/offers", params={"ids": "1,2"})
    assert r.status_code == 200
    body = r.json()
    assert body["offers"] == [OFFERS[1], OFFERS[2]]
    assert body["errors"] == []


def test_batch_all_failed_still_200():
    # Страница переживёт полный отказ: ошибки — в errors, не 500/502 целиком.
    h = BatchHandler({1: (403, {"error": PERMISSION_ERROR}), 2: (404, {})})
    r = _client(h).get("/api/offers", params={"ids": "1,2"})
    assert r.status_code == 200
    body = r.json()
    assert body["offers"] == []
    assert [e["offer_id"] for e in body["errors"]] == [1, 2]


def test_batch_dedupes_ids_keeps_order():
    h = BatchHandler({})
    r = _client(h).get("/api/offers", params={"ids": "2,1,2,1"})
    assert r.status_code == 200
    assert [o["id"] for o in r.json()["offers"]] == [2, 1]
    # Дубли не должны давать лишних походов в Keitaro.
    assert sorted(h.calls) == [1, 2]


@pytest.mark.parametrize(
    "ids",
    [
        "",          # пусто — нечего запрашивать
        "   ",
        "abc",       # не целое
        "1.5",
        "0",         # не положительное
        "-3,2",
        "1,,2",
    ],
)
def test_batch_invalid_ids_422(ids):
    r = _client(BatchHandler({})).get("/api/offers", params={"ids": ids})
    assert r.status_code == 422


def test_batch_missing_ids_param_422():
    r = _client(BatchHandler({})).get("/api/offers")
    assert r.status_code == 422


def test_batch_limit_50():
    h = BatchHandler({})
    ok = ",".join(str(i) for i in range(1, 51))
    r = _client(h).get("/api/offers", params={"ids": ok})
    assert r.status_code == 200
    assert len(r.json()["offers"]) == 50

    too_many = ",".join(str(i) for i in range(1, 52))
    r = _client(BatchHandler({})).get("/api/offers", params={"ids": too_many})
    assert r.status_code == 422
    assert "50" in r.json()["detail"]


def test_batch_409_without_configured_key(tmp_path):
    app.dependency_overrides.pop(get_keitaro_with_key, None)
    app.dependency_overrides[get_key_store] = lambda: KeyStore(tmp_path / "absent.key")
    try:
        c = TestClient(app)
        r = c.get("/api/offers", params={"ids": "1,2"})
    finally:
        app.dependency_overrides.pop(get_key_store, None)
    assert r.status_code == 409
    assert r.json() == {"detail": "API key is not configured"}


def test_old_single_offer_endpoint_still_works():
    # Не ломаем старый контракт: фронт перейдёт на батч следующим шагом.
    r = _client(BatchHandler({})).get("/api/offers/1")
    assert r.status_code == 200
    assert r.json() == OFFERS[1]
