"""Тесты создателя кампаний Keitaro (backend, MockTransport, без живого Keitaro).

Покрывают бриф (2026-11-18):
- payload кампании и обоих потоков (включая массив стран в фильтре country);
- enable последним и ровно один раз;
- компенсация DELETE при сбое на потоке 2 / enable; отсутствие DELETE при успехе;
- неудавшаяся компенсация — id кампании в detail;
- 409 на дубль имени (+confirm_duplicate), 422 на geos/имя/id, 403 с текстом Keitaro;
- отсутствие ретраев на POST (сеть/5xx — ровно одна попытка);
- GET /api/campaign-options: whitelist-поля, без лишнего.
"""

import json

import httpx
import pytest

from app.deps import get_keitaro_with_key
from app.main import app

from tests.conftest import make_app_client, make_keitaro

API_BASE = "/admin_api/v1"
DOMAIN_ID = 1813
GROUP_ID = 10332
SOURCE_ID = 836
OFFER_ID = 18813

DOMAINS = [
    {
        "id": DOMAIN_ID,
        "name": "kylovoa.com",
        "hostname": "kylovoa.com",
        "state": "active",
        "zone_name": "internal-secret-zone",
    }
]
GROUPS = [{"id": GROUP_ID, "name": "FORTESTS", "type": "campaigns", "archived": False}]
SOURCES = [{"id": SOURCE_ID, "name": "FORTESTS", "postback_secret": "SECRET"}]


def create_body(**overrides) -> dict:
    body = {
        "name": "leo_kz_offer_123",
        "geos": ["KZ", "UZ"],
        "offer_id": OFFER_ID,
        "domain_id": DOMAIN_ID,
        "group_id": GROUP_ID,
        "traffic_source_id": SOURCE_ID,
    }
    body.update(overrides)
    return body


class FakeKeitaro:
    """Аккаунт Keitaro в памяти + запись всех запросов.

    fail_at: "create_campaign" | "geo_stream" | "offer_stream" | "enable"
    (шаг определяется по содержимому запроса), fail_mode:
    "500" | "network" | "403" | "400". fail_archive: DELETE отвечает 500
    (компенсация не удалась).
    """

    def __init__(
        self,
        existing_campaigns=None,
        fail_at: str | None = None,
        fail_mode: str = "500",
        fail_archive: bool = False,
        drop_offer: bool = False,
        hide_offer_in_response: bool = False,
    ):
        self.requests: list[tuple[str, str, dict | None]] = []
        self.request_objs: list[httpx.Request] = []
        self.campaigns: dict[int, dict] = {
            c["id"]: dict(c) for c in existing_campaigns or []
        }
        self.streams: dict[int, dict] = {}
        self.next_campaign_id = 500000
        self.next_stream_id = 700000
        self.fail_at = fail_at
        self.fail_mode = fail_mode
        self.fail_archive = fail_archive
        self.created_ids: list[int] = []
        # drop_offer: Keitaro «молча» создал offer-поток без оффера.
        # hide_offer_in_response: в ответе POST /streams offers нет,
        # но оффер реально пристал (перепроверка через список потоков).
        self.drop_offer = drop_offer
        self.hide_offer_in_response = hide_offer_in_response

    # --- helpers -------------------------------------------------------------

    def _fail(self, step: str, request: httpx.Request) -> httpx.Response | None:
        if self.fail_at != step:
            return None
        if self.fail_mode == "network":
            raise httpx.ConnectError("boom", request=request)
        if isinstance(self.fail_mode, tuple):
            status, body = self.fail_mode
            if isinstance(body, str):
                return httpx.Response(status, text=body)  # не-JSON тело
            return httpx.Response(status, json=body)
        if self.fail_mode == "403":
            return httpx.Response(
                403, json={"error": "You have no permission to access this page"}
            )
        if self.fail_mode == "400":
            return httpx.Response(400, json={"error": "Name is required"})
        return httpx.Response(500)

    @staticmethod
    def _base(path: str, suffix: str) -> bool:
        return path.endswith(f"{API_BASE}{suffix}")

    @staticmethod
    def _campaign_id_from(path: str, suffix: str) -> int:
        return int(path.rsplit(f"{API_BASE}{suffix}", 1)[-1].split("/")[0])

    def _created_campaign_response(self, campaign: dict) -> httpx.Response:
        return httpx.Response(200, json=campaign)

    # --- transport -----------------------------------------------------------

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        method = request.method
        body = json.loads(request.content) if request.content else None
        self.requests.append((method, path, body))
        self.request_objs.append(request)

        # --- reads
        if method == "GET" and self._base(path, "/campaigns"):
            return httpx.Response(200, json=list(self.campaigns.values()))
        if method == "GET" and self._base(path, "/domains"):
            return httpx.Response(200, json=DOMAINS)
        if method == "GET" and self._base(path, "/groups"):
            return httpx.Response(200, json=GROUPS)
        if method == "GET" and self._base(path, "/traffic_sources"):
            return httpx.Response(200, json=SOURCES)

        # --- POST /campaigns (создание кампании)
        if method == "POST" and self._base(path, "/campaigns"):
            fail = self._fail("create_campaign", request)
            if fail is not None:
                return fail
            campaign = dict(body or {})
            campaign["id"] = self.next_campaign_id
            self.next_campaign_id += 1
            self.created_ids.append(campaign["id"])
            campaign.setdefault("state", "disabled")
            campaign["domain"] = DOMAINS[0]["name"]
            self.campaigns[campaign["id"]] = campaign
            return self._created_campaign_response(campaign)

        # --- POST /campaigns/{id}/enable
        if method == "POST" and "/enable" in path:
            cid = self._campaign_id_from(path, "/campaigns/")
            fail = self._fail("enable", request)
            if fail is not None:
                return fail
            self.campaigns[cid]["state"] = "active"
            return httpx.Response(200, json=self.campaigns[cid])

        # --- GET /streams?campaign_id= (перепроверка пристава офера)
        if method == "GET" and self._base(path, "/streams"):
            raw = request.url.params.get("campaign_id")
            try:
                cid = int(raw)
            except (TypeError, ValueError):
                return httpx.Response(400, json={"error": "campaign_id required"})
            return httpx.Response(
                200,
                json=[
                    s for s in self.streams.values() if s.get("campaign_id") == cid
                ],
            )

        # --- POST /streams
        if method == "POST" and self._base(path, "/streams"):
            step = "geo_stream" if (body or {}).get("type") == "regular" else "offer_stream"
            fail = self._fail(step, request)
            if fail is not None:
                return fail
            stream = dict(body or {})
            stream["id"] = self.next_stream_id
            self.next_stream_id += 1
            if step == "offer_stream" and (self.drop_offer or self.hide_offer_in_response):
                if self.hide_offer_in_response:
                    self.streams[stream["id"]] = stream  # пристал, но в ответе не показан
                else:
                    self.streams[stream["id"]] = dict(stream, offers=[])  # молча без офера
                response_stream = {k: v for k, v in stream.items() if k != "offers"}
                return httpx.Response(200, json=response_stream)
            self.streams[stream["id"]] = stream
            return httpx.Response(200, json=stream)

        # --- DELETE /campaigns/{id} (компенсация)
        if method == "DELETE" and "/campaigns/" in path:
            cid = self._campaign_id_from(path, "/campaigns/")
            if self.fail_archive:
                return httpx.Response(500)
            self.campaigns[cid]["state"] = "deleted"
            return httpx.Response(200, json=self.campaigns[cid])

        return httpx.Response(404, json={"error": f"unexpected {method} {path}"})

    # --- assertions helpers --------------------------------------------------

    def calls(self, method: str, suffix: str) -> list[tuple[str, str, dict | None]]:
        return [
            r for r in self.requests if r[0] == method and r[1].endswith(f"{API_BASE}{suffix}")
        ]

    def calls_on_campaign(self, method: str, campaign_id: int) -> list[tuple[str, str, dict | None]]:
        """Запросы ровно к /campaigns/{id} (например, DELETE-компенсация)."""
        target = f"{API_BASE}/campaigns/{campaign_id}"
        return [r for r in self.requests if r[0] == method and r[1] == target]

    @property
    def enable_calls(self) -> list[tuple[str, str, dict | None]]:
        return [r for r in self.requests if r[0] == "POST" and "/enable" in r[1]]


def fake_client(fake: FakeKeitaro):
    c, _ = make_app_client(
        fake, extra_overrides={get_keitaro_with_key: lambda: make_keitaro(fake)}
    )
    return c


@pytest.fixture(autouse=True)
def _clear_overrides():
    yield
    app.dependency_overrides.clear()


def assert_alias_format(alias: str):
    assert len(alias) == 6
    assert all(ch.isalnum() for ch in alias)


def test_create_success_payloads_and_response():
    fake = FakeKeitaro()
    c = fake_client(fake)
    # Лишние поля из тела игнорируются: alias/state/type задаёт сервер.
    r = c.post(
        "/api/campaigns",
        json=create_body(alias="HACKED", state="active", type="iframe"),
    )
    assert r.status_code == 201, r.text
    body = r.json()

    created = fake.calls("POST", "/campaigns")[0][2]
    assert created["name"] == "leo_kz_offer_123"
    assert created["state"] == "disabled"
    assert created["type"] == "position"
    assert created["group_id"] == GROUP_ID
    assert created["traffic_source_id"] == SOURCE_ID
    assert created["domain_id"] == DOMAIN_ID
    assert created["cost_type"] == "CPC"
    assert created["cost_value"] == 0
    assert_alias_format(created["alias"])
    assert created["alias"] != "HACKED"
    campaign_id = fake.created_ids[0]

    streams = fake.calls("POST", "/streams")
    assert len(streams) == 2
    geo = streams[0][2]
    assert geo["campaign_id"] == campaign_id
    assert geo["type"] == "regular"
    assert geo["name"] == "Geo KZ,UZ -> Google"
    assert geo["position"] == 1
    assert geo["action_type"] == "http"
    assert geo["action_payload"] == "https://google.com"
    assert geo["schema"] == "redirect"
    assert geo["collect_clicks"] is True
    assert geo["filters"] == [{"name": "country", "mode": "accept", "payload": ["KZ", "UZ"]}]
    offer = streams[1][2]
    assert offer["campaign_id"] == campaign_id
    assert offer["type"] == "default"
    assert offer["name"] == "Offers"
    assert offer["position"] == 2
    assert offer["action_type"] == "http"
    assert offer["schema"] == "landings"
    assert offer["collect_clicks"] is True
    assert offer["offers"] == [{"offer_id": OFFER_ID, "share": 100}]

    enables = fake.enable_calls
    assert len(enables) == 1
    assert enables[0][1].endswith(f"{API_BASE}/campaigns/{campaign_id}/enable")
    # enable — последний запрос, DELETE при успехе не было
    assert fake.requests[-1] == enables[0]
    assert not any(r[0] == "DELETE" for r in fake.requests)  # DELETE вообще не вызывался

    assert body["campaign"]["name"] == "leo_kz_offer_123"
    assert body["campaign"]["alias"] == created["alias"]
    assert body["campaign"]["state"] == "active"
    assert body["campaign"]["url"] == f"https://kylovoa.com/{created['alias']}"
    assert body["streams"] == [
        {"id": 700000, "name": "Geo KZ,UZ -> Google"},
        {"id": 700001, "name": "Offers"},
    ]


def test_geos_normalized_uppercase_dedup_order_preserved():
    fake = FakeKeitaro()
    c = fake_client(fake)
    r = c.post("/api/campaigns", json=create_body(geos=["uz", "KZ", "kz"]))
    assert r.status_code == 201, r.text
    geo = fake.calls("POST", "/streams")[0][2]
    assert geo["filters"][0]["payload"] == ["UZ", "KZ"]
    assert geo["name"] == "Geo UZ,KZ -> Google"


def test_validation_errors_never_reach_keitaro():
    fake = FakeKeitaro()
    c = fake_client(fake)
    bad_bodies = [
        create_body(name="   "),
        create_body(name="x" * 256),
        create_body(geos=[]),
        create_body(geos=["KZZ"]),
        create_body(geos=["K1"]),
        create_body(geos=["KZ X"]),
        create_body(geos=[f"K{i}" for i in range(21)]),  # 21 страна > MAX_GEOS=20
        create_body(offer_id=0),
        create_body(offer_id=-5),
        create_body(domain_id=0),
        create_body(group_id=0),
        create_body(traffic_source_id=0),
    ]
    for bad in bad_bodies:
        r = c.post("/api/campaigns", json=bad)
        assert r.status_code == 422, (bad, r.status_code)
    assert fake.requests == []


def test_duplicate_name_409_without_post():
    existing = [{"id": 211903, "name": "LEO_KZ_OFFER_123", "state": "active"}]
    fake = FakeKeitaro(existing_campaigns=existing)
    c = fake_client(fake)
    r = c.post("/api/campaigns", json=create_body(name="leo_kz_offer_123"))
    assert r.status_code == 409, r.text
    body = r.json()
    assert "detail" in body
    assert body["existing_campaign_id"] == 211903
    assert fake.calls("POST", "/campaigns") == []


def test_confirm_duplicate_creates():
    existing = [{"id": 211903, "name": "leo_kz_offer_123", "state": "active"}]
    fake = FakeKeitaro(existing_campaigns=existing)
    c = fake_client(fake)
    r = c.post("/api/campaigns", json=create_body(confirm_duplicate=True))
    assert r.status_code == 201, r.text
    assert len(fake.calls("POST", "/campaigns")) == 1


def test_offer_stream_failure_compensates_with_delete():
    fake = FakeKeitaro(fail_at="offer_stream", fail_mode="400")
    c = fake_client(fake)
    r = c.post("/api/campaigns", json=create_body())
    assert r.status_code == 502, r.text
    detail = r.json()["detail"]
    assert "offer stream" in detail
    assert "Name is required" in detail  # текст Keitaro дошёл
    campaign_id = fake.created_ids[0]
    deletes = fake.calls_on_campaign("DELETE", campaign_id)
    assert [d[1] for d in deletes] == [f"{API_BASE}/campaigns/{campaign_id}"]
    assert fake.campaigns[campaign_id]["state"] == "deleted"
    # enable после сбоя не вызывался
    assert fake.enable_calls == []


def test_enable_failure_compensates_with_delete():
    fake = FakeKeitaro(fail_at="enable")
    c = fake_client(fake)
    r = c.post("/api/campaigns", json=create_body())
    assert r.status_code == 502, r.text
    assert "enable" in r.json()["detail"]
    campaign_id = fake.created_ids[0]
    assert fake.campaigns[campaign_id]["state"] == "deleted"


def test_geo_stream_failure_compensates_with_delete():
    fake = FakeKeitaro(fail_at="geo_stream", fail_mode="network")
    c = fake_client(fake)
    r = c.post("/api/campaigns", json=create_body())
    assert r.status_code == 502, r.text
    assert "geo stream" in r.json()["detail"]
    campaign_id = fake.created_ids[0]
    assert fake.campaigns[campaign_id]["state"] == "deleted"


def test_failed_compensation_reports_campaign_id():
    fake = FakeKeitaro(fail_at="enable", fail_archive=True)
    c = fake_client(fake)
    r = c.post("/api/campaigns", json=create_body())
    assert r.status_code == 502, r.text
    detail = r.json()["detail"]
    campaign_id = fake.created_ids[0]
    assert str(campaign_id) in detail
    assert "archiv" in detail


def test_create_campaign_failure_no_compensation_and_403_text():
    fake = FakeKeitaro(fail_at="create_campaign", fail_mode="403")
    c = fake_client(fake)
    r = c.post("/api/campaigns", json=create_body())
    assert r.status_code == 403, r.text
    assert "You have no permission to access this page" in r.json()["detail"]
    # Компенсации не было: кампании ещё нет.
    assert not any(r[0] == "DELETE" for r in fake.requests)  # DELETE вообще не вызывался


def test_create_keitaro_validation_422_with_text():
    fake = FakeKeitaro(fail_at="create_campaign", fail_mode="400")
    c = fake_client(fake)
    r = c.post("/api/campaigns", json=create_body())
    assert r.status_code == 422, r.text
    assert "Name is required" in r.json()["detail"]


def test_no_retries_on_post_500_and_network():
    for fail_mode in ("500", "network"):
        fake = FakeKeitaro(fail_at="create_campaign", fail_mode=fail_mode)
        c = fake_client(fake)
        r = c.post("/api/campaigns", json=create_body())
        assert r.status_code == 502, (fail_mode, r.text)
        # Ровно одна попытка POST — ретрай создал бы дубли кампаний.
        assert len(fake.calls("POST", "/campaigns")) == 1, fail_mode


def test_campaign_options_whitelist_shape():
    fake = FakeKeitaro()
    c = fake_client(fake)
    r = c.get("/api/campaign-options")
    assert r.status_code == 200, r.text
    assert r.json() == {
        "domains": [{"id": DOMAIN_ID, "name": "kylovoa.com", "state": "active"}],
        "groups": [{"id": GROUP_ID, "name": "FORTESTS"}],
        "sources": [{"id": SOURCE_ID, "name": "FORTESTS"}],
    }
    # Служебные поля Keitaro наружу не утекают.
    assert "zone_name" not in r.text
    assert "postback_secret" not in r.text
    assert "archived" not in r.text


def test_campaign_options_groups_query_type():
    fake = FakeKeitaro()
    c = fake_client(fake)
    c.get("/api/campaign-options")
    groups_calls = [
        r
        for r in fake.request_objs
        if r.method == "GET" and r.url.path.endswith(f"{API_BASE}/groups")
    ]
    assert len(groups_calls) == 1
    # Справочник именно групп кампаний: GET /groups?type=campaigns.
    assert groups_calls[0].url.params["type"] == "campaigns"


def test_campaign_options_403_with_keitaro_text():
    class Domains403(FakeKeitaro):
        def __call__(self, request: httpx.Request) -> httpx.Response:
            if request.method == "GET" and self._base(request.url.path, "/domains"):
                self.requests.append(("GET", request.url.path, None))
                return httpx.Response(
                    403, json={"error": "You have no permission to access this page to Domains"}
                )
            return super().__call__(request)

    fake = Domains403()
    c = fake_client(fake)
    r = c.get("/api/campaign-options")
    assert r.status_code == 403, r.text
    assert "You have no permission to access this page to Domains" in r.json()["detail"]


def test_campaign_options_502_when_down():
    class DownKeitaro(FakeKeitaro):
        def __call__(self, request: httpx.Request) -> httpx.Response:
            if request.method == "GET" and self._base(request.url.path, "/domains"):
                raise httpx.ConnectError("boom", request=request)
            return super().__call__(request)

    fake = DownKeitaro()
    c = fake_client(fake)
    r = c.get("/api/campaign-options")
    assert r.status_code == 502, r.text
    assert r.json() == {"detail": "Keitaro unavailable"}


@pytest.mark.parametrize(
    "fail_body,expected_text",
    [
        ({"message": "The alias has already been taken"}, "The alias has already been taken"),
        ({"error": {"alias": ["The alias has already been taken"]}}, "The alias has already been taken"),
        ("The alias has already been taken", "The alias has already been taken"),
    ],
)
def test_alias_conflict_keitaro_text_reaches_detail(fail_body, expected_text):
    """Занятый alias: текст ошибки Keitaro (message/error, вложенный или
    plain text) доходит до detail, а не схлопывается в «Keitaro returned 400»."""
    fake = FakeKeitaro(fail_at="create_campaign", fail_mode=(400, fail_body))
    c = fake_client(fake)
    r = c.post("/api/campaigns", json=create_body())
    assert r.status_code == 422, r.text
    assert expected_text in r.json()["detail"]
    # Компенсации нет: кампании ещё не существовало.
    assert not any(req[0] == "DELETE" for req in fake.requests)


def test_offer_not_attached_compensates():
    """Keitaro ответил 2xx, но оффер к потоку не пристал: кампания не
    включается, уходит в архив, detail называет оффер и шаг."""
    fake = FakeKeitaro(drop_offer=True)
    c = fake_client(fake)
    r = c.post("/api/campaigns", json=create_body())
    assert r.status_code == 502, r.text
    detail = r.json()["detail"]
    assert "Offer 18813 was not attached to the stream" in detail
    assert "offer stream" in detail
    campaign_id = fake.created_ids[0]
    assert fake.calls_on_campaign("DELETE", campaign_id) != []
    assert fake.campaigns[campaign_id]["state"] == "deleted"
    assert fake.enable_calls == []


def test_offer_hidden_in_response_found_by_recheck():
    """В ответе POST /streams offers не видно, но перепроверка
    GET /streams?campaign_id= показывает приставший оффер — успех."""
    fake = FakeKeitaro(hide_offer_in_response=True)
    c = fake_client(fake)
    r = c.post("/api/campaigns", json=create_body())
    assert r.status_code == 201, r.text
    rechecks = [
        req
        for req in fake.request_objs
        if req.method == "GET" and req.url.path.endswith(f"{API_BASE}/streams")
    ]
    assert len(rechecks) == 1
    assert rechecks[0].url.params["campaign_id"] == str(fake.created_ids[0])
    assert not any(req[0] == "DELETE" for req in fake.requests)
    assert fake.enable_calls != []


def test_archived_campaign_same_name_is_not_duplicate():
    """Архивная кампания с тем же именем не даёт 409; та же кампания
    в состоянии active — даёт. На живом Keitaro архивные в списке
    GET /campaigns не приходят вовсе (404 на прямой GET, проверено
    2026-11-18); тест страхует и сборки, где deleted попадает в список."""
    fake = FakeKeitaro(
        existing_campaigns=[
            {"id": 214213, "name": "leo_kz_offer_123", "state": "active"}
        ]
    )
    c = fake_client(fake)
    r = c.post("/api/campaigns", json=create_body())
    assert r.status_code == 409, r.text
    assert r.json()["existing_campaign_id"] == 214213

    # «Заархивировали» — дублем больше не считается, создание проходит.
    fake.campaigns[214213]["state"] = "deleted"
    r2 = c.post("/api/campaigns", json=create_body())
    assert r2.status_code == 201, r2.text


def test_keitaro_client_write_post_not_retried_unit_level():
    """Прямая проверка клиента: 5xx на POST — одна попытка, без ретрая."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(500)

    client = make_keitaro(handler)
    import asyncio

    try:
        with pytest.raises(Exception):
            asyncio.run(client.create_campaign({"name": "x"}))
    finally:
        asyncio.run(client.aclose())
    assert calls["n"] == 1


def test_keitaro_client_read_still_retries():
    """Совместимость: read-роуты ретраят 5xx как раньше (retries=1 из Settings)."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(500)
        return httpx.Response(200, json=DOMAINS)

    import asyncio

    client = make_keitaro(handler)
    try:
        data = asyncio.run(client.get_domains())
    finally:
        asyncio.run(client.aclose())
    assert data == DOMAINS
    assert calls["n"] == 2
