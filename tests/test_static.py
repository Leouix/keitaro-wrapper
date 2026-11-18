import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import DIST_DIR, INDEX_FILE, app

from tests.conftest import make_app_client

# web/dist/** — зона Pixel (артефакт сборки, в git не хранится). Пока сборки нет, тесты,
# сравнивающие ответ с файлами на диске, пропускаются с ясной причиной;
# контракт без файлов на диске (404/503) проверяется всегда.
requires_dist = pytest.mark.skipif(
    not INDEX_FILE.is_file(),
    reason="web/dist/index.html ещё не собран (зона Pixel); проверяется, когда появится сборка",
)


@pytest.fixture()
def client():
    c, _ = make_app_client(lambda request: httpx.Response(200, json=[]))
    yield c
    app.dependency_overrides.clear()


SPA_ROUTES = [
    "/",
    "/campaigns",
    "/fb/campaigns/212502/streams",
    "/fb/campaigns/not-a-number/streams",
]


@requires_dist
@pytest.mark.parametrize("path", SPA_ROUTES)
def test_spa_fallback_serves_dist_index(client, path):
    # SPA-fallback: все три маршрута отдают один и тот же собранный index.html;
    # нечисловой campaign_id — ошибка ссылки, а не 404 бэкенда.
    r = client.get(path)
    assert r.status_code == 200, f"{path}: {r.status_code}"
    assert r.headers["content-type"].startswith("text/html")
    assert r.text == INDEX_FILE.read_text(encoding="utf-8")


@requires_dist
def test_index_html_no_store(client):
    # После нового деплоя браузер обязан брать свежий index.html, не из кэша.
    assert client.get("/").headers["cache-control"] == "no-store"


@requires_dist
def test_hashed_asset_served_from_dist(client):
    # Бандл — только текст: рядом с js/css в сборке лежат картинки (png).
    assets = sorted((DIST_DIR / "assets").glob("*.js"))
    assert assets, "в web/dist/assets нет ассетов — сборка пуста?"
    target = assets[0]
    r = client.get(f"/assets/{target.name}")
    assert r.status_code == 200
    assert r.text == target.read_text(encoding="utf-8")
    # Хешированные ассеты можно кэшировать бессрочно.
    assert r.headers["cache-control"] == "public, max-age=31536000, immutable"


@requires_dist
def test_hashed_asset_content_types(client):
    # JS и CSS отдаются с правильным content-type (по расширению файла).
    by_suffix = {p.suffix: p for p in (DIST_DIR / "assets").glob("*")}
    r = client.get(f"/assets/{by_suffix['.js'].name}")
    assert r.status_code == 200
    assert "javascript" in r.headers["content-type"]
    r = client.get(f"/assets/{by_suffix['.css'].name}")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/css")


def test_frontend_not_built_503(client, monkeypatch):
    # Сборки нет — понятная 503 с текстом «frontend не собран», без трейсбека.
    monkeypatch.setattr("app.main.INDEX_FILE", DIST_DIR / "index.html.not-built")
    for path in ("/", "/campaigns", "/fb/campaigns/212502/streams"):
        r = client.get(path)
        assert r.status_code == 503, f"{path}: {r.status_code}"
        assert "frontend не собран" in r.json()["detail"]


def test_assets_hidden_files_blocked(client):
    # Скрытые имена (.env, .keitaro_api_key) не раздаются на любом уровне.
    assert client.get("/assets/.env").status_code == 404
    assert client.get("/assets/.keitaro_api_key").status_code == 404
    assert client.get("/assets/sub/.env").status_code == 404


def test_assets_missing_404(client):
    # Никакого SPA-fallback для ассетов: отсутствующий файл — 404.
    assert client.get("/assets/nope.css").status_code == 404


def test_assets_traversal_blocked(client):
    # %2e%2e доходит до раздачи как ".." и не выходит за пределы web/dist/assets.
    assert client.get("/assets/%2e%2e/index.html").status_code == 404
    assert client.get("/assets/%2e%2e/%2e%2e/app/main.py").status_code == 404


def test_campaigns_page_is_static_not_api(client):
    # /api/campaigns — данные, /campaigns — HTML: "/"-суффикс API-пути
    # не превращается в страницу, а канонизируется редиректом на API-эндпоинт.
    r = client.get("/api/campaigns/", follow_redirects=False)
    assert r.status_code == 307
    assert r.headers["location"] == "http://testserver/api/campaigns"


def test_docs_still_work(client):
    assert client.get("/docs").status_code == 200
