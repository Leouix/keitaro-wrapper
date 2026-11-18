import httpx

from app.constants import CAMPAIGN_LIST_FIELDS as LIST_FIELDS

from tests.conftest import (
    HTML_LOGIN_PAGE,
    PERMISSION_ERROR,
    make_app_client,
    make_keitaro,
)


def test_healthz_ok(client):
    assert client.get("/healthz").json() == {"status": "ok"}


def test_by_id_returns_campaign(client):
    r = client.get("/api/campaigns/211903")
    assert r.status_code == 200
    assert r.json()["name"] == "test_leo_camp_1"


def test_unknown_id_404(client):
    r = client.get("/api/campaigns/999")
    assert r.status_code == 404


def _network_fail(request):
    raise httpx.ConnectError("boom", request=request)


def test_network_failure_503():
    # Недоступность Keitaro — 503, кэша больше нет.
    c, _ = make_app_client(_network_fail)
    assert c.get("/api/campaigns/211903").status_code == 503


def test_5xx_maps_to_503():
    c, _ = make_app_client(lambda request: httpx.Response(500, text="oops"))
    r = c.get("/api/campaigns/211903")
    assert r.status_code == 503


def test_permission_json_error_maps_to_403():
    def handler(request):
        return httpx.Response(403, json={"error": PERMISSION_ERROR})

    c, _ = make_app_client(handler)
    r = c.get("/api/campaigns/211903")
    assert r.status_code == 403
    assert "permission" in r.json()["detail"]


def test_200_with_error_body_maps_to_403():
    def handler(request):
        return httpx.Response(200, json={"error": PERMISSION_ERROR})

    c, _ = make_app_client(handler)
    r = c.get("/api/campaigns/211903")
    assert r.status_code == 403
    assert "permission" in r.json()["detail"]


def test_html_login_403_maps_to_403():
    def handler(request):
        return httpx.Response(403, text=HTML_LOGIN_PAGE, headers={"content-type": "text/html"})

    c, _ = make_app_client(handler)
    r = c.get("/api/campaigns/211903")
    assert r.status_code == 403
    assert "denied" in r.json()["detail"]


def test_non_json_response_maps_to_502():
    c, _ = make_app_client(
        lambda request: httpx.Response(200, text="not json", headers={"content-type": "text/plain"})
    )
    r = c.get("/api/campaigns/211903")
    assert r.status_code == 502


# --- GET /api/campaigns/{id}: whitelist ---

RAW_WITH_SECRETS = {
    "id": 211903,
    "name": "test_leo_camp_1",
    "alias": "tMsV2N",
    "state": "active",
    "group": "FORTESTS",
    "updated_at": "2026-11-17 09:00:00",
    # Секретные поля, которые Keitaro отдаёт, а мы отдавать не должны.
    "token": "SECRET_TOKEN_VALUE",
    "postbacks": [{"url": "https://example.com/postback"}],
    "domain": "secret-domain.example",
}


def test_by_id_whitelisted_fields_no_secrets():
    def handler(request):
        assert request.url.path.endswith("/admin_api/v1/campaigns/211903")
        return httpx.Response(200, json=RAW_WITH_SECRETS)

    c, Session = make_app_client(handler)
    r = c.get("/api/campaigns/211903")
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "test_leo_camp_1"
    assert set(body.keys()) == set(LIST_FIELDS)
    for secret in ("token", "postbacks", "domain"):
        assert secret not in body
