import httpx
import pytest
from fastapi.testclient import TestClient

from app.keybox import KeyStore, get_key_store
from app.keitaro import KeitaroClient
from app.main import app
from app.routers.settings import _verify_client

from tests.conftest import HTML_LOGIN_PAGE, PERMISSION_ERROR

# conftest задаёт KEITARO_API_KEY до импорта app.*
ENV_KEY = "dummy-test-key-not-a-real-secret"  # 32 символа


@pytest.fixture()
def key_store(tmp_path):
    return KeyStore(tmp_path / ".keitaro_api_key")


@pytest.fixture()
def client(key_store):
    app.dependency_overrides[get_key_store] = lambda: key_store
    yield TestClient(app)
    app.dependency_overrides.pop(get_key_store, None)


def _patch_verify(monkeypatch, handler):
    # Клиент проверки строится именно с кандидат-ключом, как в проде.
    monkeypatch.setattr(
        "app.routers.settings._verify_client",
        lambda key: KeitaroClient(api_key=key, transport=httpx.MockTransport(handler)),
    )


def test_settings_masks_env_key(client):
    r = client.get("/api/settings")
    assert r.status_code == 200
    assert r.json() == {"configured": True, "key_masked": "dumm…cret", "source": "env"}


def test_settings_never_returns_full_key(client):
    r = client.get("/api/settings")
    assert ENV_KEY not in r.text


def test_file_key_takes_precedence_over_env(client, key_store):
    key_store.write("f" * 20)
    r = client.get("/api/settings")
    assert r.status_code == 200
    assert r.json()["source"] == "file"
    assert r.json()["key_masked"] == "ffff…ffff"


def test_save_api_key_success(client, monkeypatch, key_store):
    seen = {}

    def handler(request):
        seen["sent"] = request.headers.get("Api-Key")
        return httpx.Response(200, json=[])

    _patch_verify(monkeypatch, handler)
    r = client.post("/api/settings/api-key", json={"api_key": "k" * 24})
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] is True
    assert body["source"] == "file"
    assert body["key_masked"] == "kkkk…kkkk"
    # Проверка шла именно новым ключом, не тем, что в .env.
    assert seen["sent"] == "k" * 24
    assert key_store.read() == "k" * 24
    # Файл 0600.
    assert (key_store.path.stat().st_mode & 0o777) == 0o600


def test_save_api_key_input_is_stripped(client, monkeypatch, key_store):
    _patch_verify(monkeypatch, lambda request: httpx.Response(200, json=[]))
    r = client.post("/api/settings/api-key", json={"api_key": "  " + "k" * 24 + "  "})
    assert r.status_code == 200
    assert key_store.read() == "k" * 24


def test_save_api_key_permission_json_400(client, monkeypatch, key_store):
    _patch_verify(
        monkeypatch, lambda request: httpx.Response(403, json={"error": PERMISSION_ERROR})
    )
    r = client.post("/api/settings/api-key", json={"api_key": "k" * 24})
    assert r.status_code == 400
    assert "rejected" in r.json()["detail"]
    assert key_store.read() is None  # ключ не сохранён


def test_save_api_key_html_login_400(client, monkeypatch, key_store):
    _patch_verify(
        monkeypatch,
        lambda request: httpx.Response(
            403, text=HTML_LOGIN_PAGE, headers={"content-type": "text/html"}
        ),
    )
    r = client.post("/api/settings/api-key", json={"api_key": "k" * 24})
    assert r.status_code == 400
    # HTML вместо JSON от Keitaro — всё равно отказ в доступе (403), это проблема ключа.
    assert "denied" in r.json()["detail"]
    assert key_store.read() is None


def test_save_api_key_keitaro_down_502(client, monkeypatch, key_store):
    def handler(request):
        raise httpx.ConnectError("boom", request=request)

    _patch_verify(monkeypatch, handler)
    r = client.post("/api/settings/api-key", json={"api_key": "k" * 24})
    assert r.status_code == 502
    assert key_store.read() is None


def test_save_api_key_too_short_422_no_keitaro_call(client, monkeypatch, key_store):
    def handler(request):
        raise AssertionError("Keitaro must not be called for an invalid key")

    _patch_verify(monkeypatch, handler)
    for bad in ("short", "", None):
        payload = {} if bad is None else {"api_key": bad}
        r = client.post("/api/settings/api-key", json=payload)
        assert r.status_code == 422, bad
    assert key_store.read() is None


def test_save_api_key_whitespace_only_422(client, monkeypatch, key_store):
    def handler(request):
        raise AssertionError("Keitaro must not be called for an invalid key")

    _patch_verify(monkeypatch, handler)
    # 16 пробелов проходят pydantic min_length, но после strip — пусто.
    r = client.post("/api/settings/api-key", json={"api_key": " " * 20})
    assert r.status_code == 422
    assert key_store.read() is None
