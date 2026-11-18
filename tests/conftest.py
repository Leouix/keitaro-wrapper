import hashlib
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base, get_db
from app.deps import get_keitaro_with_key
from app.keitaro import KeitaroClient
from app.main import app

TEST_KEY = "dummy-test-key-not-a-real-secret"

CAMPAIGNS = [
    {
        "id": 211903,
        "name": "test_leo_camp_1",
        "alias": "tMsV2N",
        "state": "active",
        "group": "FORTESTS",
        "traffic_source_id": 836,
        "cost_auto": True,
    },
    {"id": 2, "name": "other_camp", "state": "disabled"},
]

HTML_LOGIN_PAGE = "<html><head><title>Login</title></head><body>Sign in to Keitaro</body></html>"
PERMISSION_ERROR = "You have no permission to access this page to AffiliateNetworks"


def _legacy_response(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if path.endswith("/admin_api/v1/campaigns/211903"):
        return httpx.Response(200, json=CAMPAIGNS[0])
    if path.endswith("/admin_api/v1/campaigns"):
        return httpx.Response(200, json=CAMPAIGNS)
    return httpx.Response(404, json={"error": "not found"})


def make_keitaro(handler) -> KeitaroClient:
    # Ключ фиктивный — реального запроса не будет: транспорт подменён.
    return KeitaroClient(api_key=TEST_KEY, transport=httpx.MockTransport(handler))


def make_app_client(handler, extra_overrides=None) -> tuple[TestClient, sessionmaker]:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autocommit=False, autoflush=False)

    def override_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_db
    # Единая фабрика клиента для всех data-эндпоинтов (app/deps.py).
    app.dependency_overrides[get_keitaro_with_key] = lambda: make_keitaro(handler)
    app.dependency_overrides.update(extra_overrides or {})
    return TestClient(app), Session


@pytest.fixture()
def client():
    c, _ = make_app_client(_legacy_response)
    yield c
    app.dependency_overrides.clear()


@pytest.fixture(scope="session", autouse=True)
def _web_dir_immutable():
    """Тесты не имеют права писать в web/** — это зона Pixel.

    Сравнение sha256 всех файлов web/ до и после прогона: любое изменение
    (даже запись от тестовой фикстуры) роняет сессию.
    """

    def snapshot() -> dict[str, str]:
        return {
            str(p.relative_to(web_dir)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(web_dir.rglob("*"))
            if p.is_file()
        }

    web_dir = Path(__file__).resolve().parent.parent / "web"
    if not web_dir.is_dir():
        yield
        return
    before = snapshot()
    yield
    after = snapshot()
    assert after == before, f"тесты изменили web/**: {set(after.items()) ^ set(before.items())}"
