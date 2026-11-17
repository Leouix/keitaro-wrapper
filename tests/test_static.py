import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import WEB_DIR, app

from tests.conftest import make_app_client


@pytest.fixture()
def client():
    c, _ = make_app_client(lambda request: httpx.Response(200, json=[]))
    yield c
    app.dependency_overrides.clear()


def _serve(client, path: str):
    r = client.get(path)
    assert r.status_code == 200, f"{path}: {r.status_code}"
    assert r.headers["content-type"].startswith("text/html")
    return r


def test_root_serves_index_html(client):
    # Статика — зона Pixel: тест сравнивает ответ с файлом на диске,
    # а не с конкретным текстом страницы.
    r = _serve(client, "/")
    assert r.text == (WEB_DIR / "index.html").read_text(encoding="utf-8")
    # Контракт JS: главная помечена data-page="home".
    assert 'data-page="home"' in r.text


CAMPAIGNS_HTML = WEB_DIR / "campaigns.html"


@pytest.mark.skipif(
    not CAMPAIGNS_HTML.is_file(),
    reason="web/campaigns.html ещё не создан (зона Pixel); маршрут проверяется, когда файл появится",
)
def test_campaigns_page_served(client):
    r = _serve(client, "/campaigns")
    # Тело байт-в-байт равно файлу на диске — тест не пишет в web/**.
    assert r.text == CAMPAIGNS_HTML.read_text(encoding="utf-8")
    # Контракт JS: страница списка кампаний помечена data-page="campaigns".
    assert 'data-page="campaigns"' in r.text


def test_campaigns_page_is_static_not_api(client):
    # /api/campaigns — данные, /campaigns — HTML: "/"-суффикс API-пути
    # не превращается в страницу, а канонизируется редиректом на API-эндпоинт.
    r = client.get("/api/campaigns/", follow_redirects=False)
    assert r.status_code == 307
    assert r.headers["location"] == "http://testserver/api/campaigns"


def test_streams_page_served_for_any_campaign_id(client):
    r = _serve(client, "/fb/campaigns/211903/streams")
    assert r.text == (WEB_DIR / "streams.html").read_text(encoding="utf-8")
    # Контракт JS: страница потоков помечена data-page="streams".
    assert 'data-page="streams"' in r.text


def test_streams_page_served_for_nonnumeric_id_too(client):
    # Нечисловой id — это проблема фронта/ссылки, HTML-страница всё равно отдаётся.
    assert client.get("/fb/campaigns/not-a-number/streams").status_code == 200


def test_assets_serve_app_files(client):
    # /assets/{name} раздаёт файлы приложения из web/ — проверяем реальную отдачу.
    for name in ("app.js", "styles.css"):
        path = WEB_DIR / name
        assert path.is_file(), f"ожидался файл web/{name}"
        r = client.get(f"/assets/{name}")
        assert r.status_code == 200
        assert r.text == path.read_text(encoding="utf-8")


def test_assets_index_served(client):
    # /assets/index.html — тот же файл, что и главная; текст не проверяем.
    assert client.get("/assets/index.html").status_code == 200


def test_assets_hidden_files_blocked(client):
    # .env и прочие скрытые файлы не раздаются: имя обязано начинаться с буквы/цифры.
    assert client.get("/assets/.env").status_code == 404
    assert client.get("/assets/.keitaro_api_key").status_code == 404


def test_assets_missing_404(client):
    assert client.get("/assets/nope.css").status_code == 404


def test_docs_still_work(client):
    assert client.get("/docs").status_code == 200
