import httpx

from app.models import CampaignCache

from tests.conftest import (
    CAMPAIGNS,
    HTML_LOGIN_PAGE,
    PERMISSION_ERROR,
    make_app_client,
    make_keitaro,
)


def test_healthz_ok(client):
    assert client.get("/healthz").json() == {"status": "ok"}


def test_by_name_returns_campaign(client):
    r = client.get("/api/campaigns/by-name/test_leo_camp_1")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == 211903
    assert body["name"] == "test_leo_camp_1"


def test_by_id_returns_campaign(client):
    r = client.get("/api/campaigns/211903")
    assert r.status_code == 200
    assert r.json()["name"] == "test_leo_camp_1"


def test_unknown_name_404(client):
    r = client.get("/api/campaigns/by-name/ghost")
    assert r.status_code == 404


def test_unknown_id_404(client):
    r = client.get("/api/campaigns/999")
    assert r.status_code == 404


def test_successful_fetch_writes_cache():
    c, Session = make_app_client(lambda request: httpx.Response(200, json=CAMPAIGNS))
    r = c.get("/api/campaigns/by-name/test_leo_camp_1")
    assert r.status_code == 200
    db = Session()
    row = db.get(CampaignCache, 211903)
    db.close()
    assert row is not None
    assert row.name == "test_leo_camp_1"


def _network_fail(request):
    raise httpx.ConnectError("boom", request=request)


def test_network_failure_falls_back_to_cache():
    c, Session = make_app_client(_network_fail)
    db = Session()
    db.add(CampaignCache(keitaro_id=211903, name="test_leo_camp_1", payload=CAMPAIGNS[0]))
    db.commit()
    db.close()
    r = c.get("/api/campaigns/by-name/test_leo_camp_1")
    assert r.status_code == 200
    body = r.json()
    assert body["stale"] is True
    assert body["campaign"]["id"] == 211903


def test_network_failure_no_cache_503():
    c, _ = make_app_client(_network_fail)
    assert c.get("/api/campaigns/by-name/test_leo_camp_1").status_code == 503


def test_5xx_maps_to_stale_503():
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
    r = c.get("/api/campaigns/by-name/test_leo_camp_1")
    assert r.status_code == 403
    assert "permission" in r.json()["detail"]


def test_html_login_403_maps_to_502():
    def handler(request):
        return httpx.Response(403, text=HTML_LOGIN_PAGE, headers={"content-type": "text/html"})

    c, _ = make_app_client(handler)
    r = c.get("/api/campaigns/211903")
    assert r.status_code == 502
    assert "IP" in r.json()["detail"]


def test_non_json_response_maps_to_502():
    c, _ = make_app_client(
        lambda request: httpx.Response(200, text="not json", headers={"content-type": "text/plain"})
    )
    r = c.get("/api/campaigns/211903")
    assert r.status_code == 502
