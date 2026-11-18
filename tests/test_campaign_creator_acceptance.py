"""Приёмочные тесты «создавателя кампаний» — независимая проверка Rigel.

Чёрный ящик по контракту CAMPAIGN_CREATOR_PLAN.md §6/§8: проверяется
только наблюдаемое поведение API-обёртки (POST /api/campaigns,
GET /api/campaign-options) через TestClient, живой Keitaro не вызывается —
транспорт подменён MockTransport'ом на stateful фейке.

Внутренности реализации Lin (app/routers/*, write-методы KeitaroClient)
здесь не импортируются и не инспектируются: только HTTP-ответы и
записи вызовов, ушедшие на фейковый Keitaro.

Запускается независимо от остальных тестов: pytest tests/test_campaign_creator_acceptance.py
"""

import re
from collections import Counter
from pathlib import Path

import httpx
import pytest

from app.main import app
from tests.conftest import make_app_client

ADMIN = "/admin_api/v1"
EXISTING_ID = 211903
EXISTING_NAME = "dup_camp"

# Пример ошибки прав Keitaro (как в PERMISSION_ERROR conftest, свой текст).
PERMISSION_TEXT = "You have no permission to access this page to Campaigns"


class FakeKeitaro:
    """Stateful фейк legacy /admin_api/v1 + счётчик вызовов.

    Флаги self.fail включают сбои отдельных шагов:
      None            — шаг проходит;
      "network"       — httpx.ConnectError (сеть);
      (status, body)  — HTTP-ошибка с телом.
    """

    def __init__(self):
        self.campaigns: dict[int, dict] = {
            EXISTING_ID: {"id": EXISTING_ID, "name": EXISTING_NAME, "alias": "dup001",
                          "state": "active", "group": "FORTESTS"}
        }
        self.streams: dict[int, dict] = {}
        self.next_campaign = 300000
        self.next_stream = 500
        self.calls: list[tuple[str, str, dict | None]] = []
        self.fail = {
            "create_campaign": None,
            "geo_stream": None,
            "offer_stream": None,
            "enable": None,
            "delete": None,
        }
        self.empty_dirs = False
        # offer_id, который «не пристал» к оффер-потоку (POST /streams
        # проходит, но оффера в созданном потоке нет — как на живом Keitaro).
        self.drop_offers: set[int] = set()

    # --- helpers для ассертов ---

    def calls_for(self, method: str, path_suffix: str) -> list:
        return [(m, p, b) for m, p, b in self.calls
                if m == method and p.endswith(path_suffix)]

    def bodies_for(self, method: str, path_suffix: str) -> list[dict | None]:
        return [b for m, p, b in self.calls_for(method, path_suffix)]

    def _fail(self, key, request):
        f = self.fail[key]
        if f is None:
            return None
        if f == "network":
            raise httpx.ConnectError("connection refused", request=request)
        status, body = f
        return httpx.Response(status, json=body)

    # --- диспетчер ---

    def handler(self, request: httpx.Request) -> httpx.Response:
        method = request.method
        path = request.url.path
        try:
            body = __import__("json").loads(request.content) if request.content else None
        except ValueError:
            body = None
        self.calls.append((method, path, body))
        rel = path[len(ADMIN):] if path.startswith(ADMIN) else path

        # --- справочники для /api/campaign-options ---
        if method == "GET" and rel == "/domains":
            data = [] if self.empty_dirs else [
                {"id": 1813, "name": "kylovoa.com", "state": "active"}]
            return httpx.Response(200, json=data)
        if method == "GET" and rel == "/groups":
            data = [] if self.empty_dirs else [{"id": 10332, "name": "FORTESTS"}]
            return httpx.Response(200, json=data)
        if method == "GET" and rel == "/traffic_sources":
            data = [] if self.empty_dirs else [{"id": 836, "name": "FORTESTS"}]
            return httpx.Response(200, json=data)

        # --- кампании ---
        if method == "GET" and rel == "/campaigns":
            return httpx.Response(200, json=list(self.campaigns.values()))
        if method == "POST" and rel == "/campaigns":
            r = self._fail("create_campaign", request)
            if r:
                return r
            cid = self.next_campaign
            self.next_campaign += 1
            camp = dict(body)
            camp["id"] = cid
            camp.setdefault("alias", f"a{cid % 100000:05d}x")
            self.campaigns[cid] = camp
            return httpx.Response(200, json=camp)
        m = re.fullmatch(r"/campaigns/(\d+)", rel)
        if m:
            cid = int(m.group(1))
            camp = self.campaigns.get(cid)
            if camp is None or camp.get("state") in ("deleted",):
                return httpx.Response(404, json={"error": "not found"})
            if method == "GET":
                return httpx.Response(200, json=camp)
            if method == "DELETE":
                r = self._fail("delete", request)
                if r:
                    return r
                camp["state"] = "deleted"
                return httpx.Response(200, json=camp)
            if method == "POST" and path.endswith("/enable"):
                r = self._fail("enable", request)
                if r:
                    return r
                camp["state"] = "active"
                return httpx.Response(200, json=camp)
        m = re.fullmatch(r"/campaigns/(\d+)/enable", rel)
        if m and method == "POST":
            cid = int(m.group(1))
            camp = self.campaigns.get(cid)
            if camp is None:
                return httpx.Response(404, json={"error": "not found"})
            r = self._fail("enable", request)
            if r:
                return r
            camp["state"] = "active"
            return httpx.Response(200, json=camp)
        m = re.fullmatch(r"/campaigns/(\d+)/streams", rel)
        if m and method == "GET":
            cid = int(m.group(1))
            camp = self.campaigns.get(cid)
            if camp is None or camp.get("state") == "deleted":
                return httpx.Response(404, json={"error": "not found"})
            return httpx.Response(200, json=[
                s for s in self.streams.values() if s["campaign_id"] == cid])

        # --- потоки ---
        if method == "POST" and rel == "/streams":
            sname = (body or {}).get("name") or ""
            if sname.startswith("Geo"):
                r = self._fail("geo_stream", request)
            else:
                r = self._fail("offer_stream", request)
            if r:
                return r
            sid = self.next_stream
            self.next_stream += 1
            stream = dict(body)
            if self.drop_offers:
                stream["offers"] = [
                    o for o in (stream.get("offers") or [])
                    if o.get("offer_id") not in self.drop_offers
                ]
            stream["id"] = sid
            self.streams[sid] = stream
            return httpx.Response(200, json=stream)

        return httpx.Response(404, json={"error": f"fake: no route {method} {rel}"})


VALID_BODY = {
    "name": "leo_kz_offer_123",
    "geos": ["KZ", "UZ"],
    "offer_ids": [18813],
    "domain_id": 1813,
    "group_id": 10332,
    "traffic_source_id": 836,
}


def _expected_shares(n: int) -> list[int]:
    """Правило дележа из плана §4: divmod(100, N), первые rest офферов
    получают base + 1 (3 оффера → 34/33/33). Сумма всегда 100."""
    base, rest = divmod(100, n)
    return [base + 1] * rest + [base] * (n - rest)


@pytest.fixture()
def api():
    fake = FakeKeitaro()
    client, _ = make_app_client(fake.handler)
    client.fake = fake
    yield client
    app.dependency_overrides.clear()


def _create(api, body=None, **over):
    payload = dict(VALID_BODY)
    payload.update(over or {})
    if body is not None:
        payload = body
    return api.post("/api/campaigns", json=payload)


def _campaign_payloads(fake):
    return fake.bodies_for("POST", "/campaigns")


# ---------------------------------------------------------------- happy path


def test_happy_path_two_geos(api):
    """Критерий готовности: кампания выключена при сборке, ровно два потока
    (country-фильтр с обоими кодами + оффер), enable последним и один раз,
    DELETE нет, ответ 201 с активной кампанией."""
    resp = _create(api)
    assert resp.status_code == 201, resp.text
    data = resp.json()
    fake = api.fake

    # POST /campaigns: state=disabled, служебные поля на месте, alias 6 символов
    creations = _campaign_payloads(fake)
    assert len(creations) == 1
    c = creations[0]
    assert c["name"] == "leo_kz_offer_123"
    assert c["state"] == "disabled"
    assert c["group_id"] == 10332
    assert c["traffic_source_id"] == 836
    assert c["domain_id"] == 1813
    assert re.fullmatch(r"[A-Za-z0-9]{6}", c["alias"])

    cid = data["campaign"]["id"]
    streams_posts = fake.bodies_for("POST", "/streams")
    assert len(streams_posts) == 2

    geo = streams_posts[0]
    assert geo["campaign_id"] == cid
    assert geo["type"] == "regular"
    assert geo["schema"] == "redirect"
    assert geo["action_payload"] == "https://google.com"
    # Состав и порядок стран — как в запросе, одним фильтром.
    filters = geo["filters"]
    assert len(filters) == 1
    assert filters[0]["name"] == "country"
    assert filters[0]["mode"] == "accept"
    assert filters[0]["payload"] == ["KZ", "UZ"]

    offer = streams_posts[1]
    assert offer["campaign_id"] == cid
    assert offer["type"] == "default"
    assert offer["schema"] == "landings"
    # Один оффер → ровно один элемент с долей 100.
    assert offer["offers"] == [{"offer_id": 18813, "share": 100}]

    # enable — ровно один раз и строго после обоих потоков
    enables = fake.calls_for("POST", "/enable")
    assert len(enables) == 1
    stream_idx = max(i for i, (m, p, _) in enumerate(fake.calls) if m == "POST" and p.endswith("/streams"))
    enable_idx = next(i for i, (m, p, _) in enumerate(fake.calls) if m == "POST" and p.endswith("/enable"))
    assert enable_idx > stream_idx

    # при успехе компенсации нет
    assert fake.calls_for("DELETE", f"/campaigns/{cid}") == []

    # ответ
    assert data["campaign"]["name"] == "leo_kz_offer_123"
    assert data["campaign"]["state"] == "active"
    assert len(data["streams"]) == 2


def test_geos_normalized_uppercase_dedupe_order(api):
    """geos нормализуются: верхний регистр, без дублей, порядок сохранён."""
    resp = _create(api, geos=["uz", "KZ", "UZ"])
    assert resp.status_code == 201, resp.text
    streams = api.fake.bodies_for("POST", "/streams")
    assert streams[0]["filters"][0]["payload"] == ["UZ", "KZ"]


def test_geos_more_than_20_rejected(api):
    geos = [f"C{i:02d}" for i in range(21)]
    resp = _create(api, geos=geos)
    assert resp.status_code == 422
    assert api.fake.bodies_for("POST", "/campaigns") == []


def test_geos_twenty_accepted(api):
    # 20 валидных ISO-2 кодов ([A-Z]{2}); "C00" и подобные — 3 символа,
    # контракт их отклоняет (см. test_geos_more_than_20_rejected).
    geos = ["RU", "US", "CA", "BR", "MX", "DE", "FR", "GB", "IT", "ES",
            "PL", "TR", "CN", "JP", "IN", "AU", "UA", "KZ", "UZ", "GE"]
    assert len(geos) == 20
    resp = _create(api, geos=geos)
    assert resp.status_code == 201, resp.text


def test_live_campaigns_list_prefilter_untouched(api):
    """Существующий GET /api/campaigns не должен измениться от новых
    write-методов (регрессия зоны Lin)."""
    resp = api.get("/api/campaigns", params={"query": "dup"})
    assert resp.status_code == 200
    names = [c["name"] for c in resp.json()["campaigns"]]
    assert names == [EXISTING_NAME]


# ---------------------------------------------------------------- 422 валидация


@pytest.mark.parametrize(
    "over",
    [
        {"geos": []},
        {"geos": ["KZ1"]},
        {"geos": ["kzz"]},
        {"geos": "KZ"},            # не список
        {"name": ""},
        {"name": "x" * 256},
        {"name": "   "},
        # offer_ids: 1..20, gt=0, только числа
        {"offer_ids": []},
        {"offer_ids": 18813},            # число вместо списка
        {"offer_ids": [0]},
        {"offer_ids": [-5]},
        {"offer_ids": ["abc"]},
        {"offer_ids": [18813, "abc"]},
        {"offer_id": 0},                 # старое поле тоже валидируется
        {"offer_id": -5},
    ],
)
def test_422_invalid_input(api, over):
    resp = _create(api, **over)
    assert resp.status_code == 422, f"{over}: {resp.status_code} {resp.text}"
    # ни одного похода на запись в Keitaro
    assert api.fake.bodies_for("POST", "/campaigns") == []
    assert api.fake.bodies_for("POST", "/streams") == []


def test_422_offer_ids_more_than_20(api):
    resp = _create(api, offer_ids=list(range(1, 22)))
    assert resp.status_code == 422
    assert api.fake.bodies_for("POST", "/campaigns") == []


def test_offer_ids_twenty_accepted(api):
    resp = _create(api, offer_ids=list(range(18800, 18820)))
    assert resp.status_code == 201, resp.text


@pytest.mark.parametrize("field", ["name", "geos"])
def test_422_missing_required_field(api, field):
    body = dict(VALID_BODY)
    del body[field]
    resp = _create(api, body=body)
    assert resp.status_code == 422
    assert api.fake.bodies_for("POST", "/campaigns") == []


def test_422_missing_offers_entirely(api):
    """Ни offer_ids, ни offer_id — 422."""
    body = dict(VALID_BODY)
    del body["offer_ids"]
    resp = _create(api, body=body)
    assert resp.status_code == 422
    assert api.fake.bodies_for("POST", "/campaigns") == []


# ------------------------------------------------- offer_ids нормализация


def test_offer_ids_dedupe_preserve_order(api):
    """Дубли офферов схлопываются, порядок сохраняется."""
    resp = _create(api, offer_ids=[18814, 18813, 18814])
    assert resp.status_code == 201, resp.text
    offers = api.fake.bodies_for("POST", "/streams")[1]["offers"]
    assert [o["offer_id"] for o in offers] == [18814, 18813]


# ------------------------------------------------- compat старого offer_id


def test_legacy_offer_id_accepted_as_single(api):
    """Старое поле offer_id (одно число) живёт ещё один релиз: == [offer_id]."""
    body = dict(VALID_BODY)
    del body["offer_ids"]
    # В новом VALID_BODY offer_id нет: легаси-поле нужно задать явно,
    # иначе тело не содержит ни offer_ids, ни offer_id (это 422 по контракту).
    body["offer_id"] = 18813
    resp = _create(api, body=body)
    assert resp.status_code == 201, resp.text
    offers = api.fake.bodies_for("POST", "/streams")[1]["offers"]
    assert offers == [{"offer_id": 18813, "share": 100}]


def test_both_fields_offer_ids_wins(api):
    """Пришли оба поля — offer_ids выигрывает."""
    resp = _create(api, offer_ids=[18813], offer_id=999)
    assert resp.status_code == 201, resp.text
    offers = api.fake.bodies_for("POST", "/streams")[1]["offers"]
    assert [o["offer_id"] for o in offers] == [18813]
    assert 999 not in [o["offer_id"] for o in offers]


# ------------------------------------------------- доли офферов


def test_two_offers_50_50(api):
    resp = _create(api, offer_ids=[18813, 18814])
    assert resp.status_code == 201, resp.text
    offers = api.fake.bodies_for("POST", "/streams")[1]["offers"]
    assert offers == [
        {"offer_id": 18813, "share": 50},
        {"offer_id": 18814, "share": 50},
    ]


def test_three_offers_34_33_33_sum_100(api):
    resp = _create(api, offer_ids=[18813, 18814, 18815])
    assert resp.status_code == 201, resp.text
    offers = api.fake.bodies_for("POST", "/streams")[1]["offers"]
    assert [o["share"] for o in offers] == [34, 33, 33]
    assert sum(o["share"] for o in offers) == 100
    assert [o["offer_id"] for o in offers] == [18813, 18814, 18815]


def test_offers_order_as_requested(api):
    """Порядок офферов в потоке — как в запросе (доли при этом равные)."""
    resp = _create(api, offer_ids=[18815, 18813])
    assert resp.status_code == 201, resp.text
    offers = api.fake.bodies_for("POST", "/streams")[1]["offers"]
    assert [o["offer_id"] for o in offers] == [18815, 18813]
    assert [o["share"] for o in offers] == _expected_shares(2)


def test_shares_rule_matches_plan_for_seven(api):
    """Правило §4 на неделимом остатке: divmod(100, 7) → 15,15,14,..."""
    ids = list(range(18800, 18807))
    resp = _create(api, offer_ids=ids)
    assert resp.status_code == 201, resp.text
    offers = api.fake.bodies_for("POST", "/streams")[1]["offers"]
    assert [o["share"] for o in offers] == _expected_shares(7)
    assert sum(o["share"] for o in offers) == 100


# ------------------------------------------------- оффер не пристал


def test_missing_offer_of_many_compensates(api):
    """Критерий §8: не все офферы пристали к потоку → архив, 502 с шагом
    "offer stream" и именем отсутствующего оффера; enable не звался."""
    api.fake.drop_offers = {18814}
    resp = _create(api, offer_ids=[18813, 18814])
    assert resp.status_code == 502
    fake = api.fake
    cid = fake.next_campaign - 1

    # имя (id) отсутствующего оффера в ответе
    assert str(18814) in resp.text
    assert "offer stream" in resp.text or ("offer" in resp.text.lower() and "stream" in resp.text.lower())

    # ровно один компенсирующий DELETE, кампания в архиве
    assert len(fake.calls_for("DELETE", f"/campaigns/{cid}")) == 1
    assert fake.campaigns[cid]["state"] == "deleted"

    # enable не звался: включённой полусобранной кампании нет
    assert fake.calls_for("POST", "/enable") == []


def test_missing_single_offer_compensates(api):
    """Единственный оффер не пристал → тоже архив и 502."""
    api.fake.drop_offers = {18813}
    resp = _create(api)
    assert resp.status_code == 502
    fake = api.fake
    cid = fake.next_campaign - 1
    assert str(18813) in resp.text
    assert len(fake.calls_for("DELETE", f"/campaigns/{cid}")) == 1
    assert fake.calls_for("POST", "/enable") == []


# ---------------------------------------------------------------- 409 дубль


def test_duplicate_name_409_with_existing_id(api):
    resp = _create(api, name=EXISTING_NAME)
    assert resp.status_code == 409
    assert str(EXISTING_ID) in resp.text
    assert api.fake.bodies_for("POST", "/campaigns") == []


def test_duplicate_confirm_creates(api):
    resp = _create(api, name=EXISTING_NAME, confirm_duplicate=True)
    assert resp.status_code == 201, resp.text
    assert len(api.fake.bodies_for("POST", "/campaigns")) == 1


def test_double_submit_second_gets_409(api):
    """Двойная отправка: первая создаёт, вторая ловится сервером по имени."""
    first = _create(api)
    assert first.status_code == 201
    second = _create(api)
    assert second.status_code == 409
    # создана ровно одна кампания
    assert len(api.fake.bodies_for("POST", "/campaigns")) == 1


# ---------------------------------------------------------------- 403 / 502


def test_403_text_passthrough(api):
    api.fake.fail["create_campaign"] = (403, {"error": PERMISSION_TEXT})
    resp = _create(api)
    assert resp.status_code == 403
    assert PERMISSION_TEXT in resp.text
    assert "Keitaro" in resp.text


def test_keitaro_unreachable_502(api):
    api.fake.fail["create_campaign"] = "network"
    resp = _create(api)
    assert resp.status_code == 502
    # Фейк записывает запрос до исключения: сетевой сбой = ровно одна
    # попытка (ретрай создал бы вторую запись). "== []" недостижимо.
    assert len(api.fake.bodies_for("POST", "/campaigns")) == 1


def test_500_mapped_to_502(api):
    api.fake.fail["create_campaign"] = (500, {"error": "boom"})
    resp = _create(api)
    assert resp.status_code == 502


# ---------------------------------------------------------------- ретраи


def test_no_retries_on_campaign_post(api):
    """Критерий: на POST ретраев нет — 500 должен уйти одним запросом."""
    api.fake.fail["create_campaign"] = (500, {"error": "boom"})
    resp = _create(api)
    assert resp.status_code == 502
    assert len(api.fake.calls_for("POST", "/campaigns")) == 1


def test_no_retries_on_stream_post(api):
    api.fake.fail["geo_stream"] = (500, {"error": "boom"})
    resp = _create(api)
    assert resp.status_code == 502
    assert len(api.fake.calls_for("POST", "/streams")) == 1
    cid = api.fake.next_campaign - 1
    # Путь DELETE содержит id: endswith("/campaigns/") не матчится никогда.
    assert len(api.fake.calls_for("DELETE", f"/campaigns/{cid}")) == 1


def test_no_retries_on_enable(api):
    api.fake.fail["enable"] = (500, {"error": "boom"})
    resp = _create(api)
    assert resp.status_code == 502
    assert len(api.fake.calls_for("POST", "/enable")) == 1


# ------------------------------------------------- компенсация при сбое


def _assert_archived(api, cid: int):
    deletes = api.fake.calls_for("DELETE", f"/campaigns/{cid}")
    assert len(deletes) == 1, "компенсирующий DELETE не выполнен"
    assert api.fake.campaigns[cid]["state"] == "deleted"


def test_compensation_geo_stream_fail(api):
    api.fake.fail["geo_stream"] = (500, {"error": "boom"})
    resp = _create(api)
    assert resp.status_code == 502
    assert "geo stream" in resp.text or "geo" in resp.text.lower()
    cid = api.fake.next_campaign - 1
    _assert_archived(api, cid)


def test_compensation_offer_stream_fail(api):
    api.fake.fail["offer_stream"] = (500, {"error": "boom"})
    resp = _create(api)
    assert resp.status_code == 502
    assert "offer stream" in resp.text or "offer" in resp.text.lower()
    cid = api.fake.next_campaign - 1
    _assert_archived(api, cid)
    # полусобранной включённой кампании не осталось
    assert api.fake.campaigns[cid]["state"] != "active"


def test_compensation_enable_fail(api):
    api.fake.fail["enable"] = (500, {"error": "boom"})
    resp = _create(api)
    assert resp.status_code == 502
    assert "enable" in resp.text.lower()
    cid = api.fake.next_campaign - 1
    _assert_archived(api, cid)
    assert api.fake.campaigns[cid]["state"] == "deleted"


def test_compensation_delete_also_fails(api):
    """Если компенсация тоже не удалась — 502 с id кампании и подсказкой."""
    api.fake.fail["geo_stream"] = (500, {"error": "boom"})
    api.fake.fail["delete"] = (500, {"error": "boom"})
    resp = _create(api)
    assert resp.status_code == 502
    cid = api.fake.next_campaign - 1
    assert str(cid) in resp.text
    assert "вручную" in resp.text or "manual" in resp.text.lower()


# ------------------------------------------------- справочники


def test_campaign_options_shape(api):
    resp = api.get("/api/campaign-options")
    assert resp.status_code == 200
    data = resp.json()
    assert data["domains"] == [{"id": 1813, "name": "kylovoa.com", "state": "active"}]
    assert data["groups"] == [{"id": 10332, "name": "FORTESTS"}]
    assert data["sources"] == [{"id": 836, "name": "FORTESTS"}]


def test_campaign_options_empty_dirs(api):
    """Пустые справочники — 200 с пустыми списками, а не 5xx."""
    api.fake.empty_dirs = True
    resp = api.get("/api/campaign-options")
    assert resp.status_code == 200
    data = resp.json()
    assert data["domains"] == []
    assert data["groups"] == []
    assert data["sources"] == []


def test_create_without_key_conflict(api):
    """Без ключа — 409 как у остальных data-эндпоинтов (регрессия deps)."""
    from app.deps import get_keitaro_with_key
    from app.keybox import KeyStore, get_key_store
    import tempfile, os

    tmpdir = tempfile.mkdtemp()
    orig = app.dependency_overrides[get_keitaro_with_key]
    # Пока get_keitaro_with_key переопределён фейком, resolve_key не
    # вызывается и 409 невозможен: снимаем override и оставляем
    # проверку ключа настоящей зависимости (KeyStore без файла ключа).
    app.dependency_overrides.pop(get_keitaro_with_key, None)
    app.dependency_overrides[get_key_store] = lambda: KeyStore(
        Path(tmpdir) / "absent.key"
    )
    try:
        resp = api.post("/api/campaigns", json=VALID_BODY)
        assert resp.status_code == 409
        assert api.fake.bodies_for("POST", "/campaigns") == []
    finally:
        app.dependency_overrides[get_keitaro_with_key] = orig
        app.dependency_overrides.pop(get_key_store, None)
