import os

# Ключ обязан существовать до первого импорта app.* (get_settings кэшируется).
# Значение фиктивное — тесты ходят только в MockTransport.
os.environ.setdefault("KEITARO_API_KEY", "dummy-test-key-not-a-real-secret")

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base, get_db
from app.keitaro import KeitaroClient
from app.main import app
from app.models import CampaignCache
from app.routers.campaigns import get_keitaro

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
    return KeitaroClient(transport=httpx.MockTransport(handler))


def make_app_client(handler) -> tuple[TestClient, sessionmaker]:
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
    app.dependency_overrides[get_keitaro] = lambda: make_keitaro(handler)
    return TestClient(app), Session


@pytest.fixture()
def client():
    c, _ = make_app_client(_legacy_response)
    yield c
    app.dependency_overrides.clear()
