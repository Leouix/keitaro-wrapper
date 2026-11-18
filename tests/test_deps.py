"""Тесты зависимости get_keitaro_with_key (app/deps.py).

Регрессия: раньше KeitaroClient создавался на каждый запрос, а его
httpx-клиент закрывался только в settings-ручке — на каждый data-запрос
утекал один пул соединений. Зависимость с yield + try/finally обязана
вызывать aclose() и после нормального ответа, и когда роутер упал.
"""

import asyncio

import pytest
from fastapi import HTTPException

from app.deps import get_keitaro_with_key
from app.keybox import KeyStore


class FakeClient:
    """Подменяет KeitaroClient в app.deps: считает вызовы aclose()."""

    instances: list["FakeClient"] = []

    def __init__(self, api_key: str):
        self.api_key = api_key
        self.aclose_calls = 0
        FakeClient.instances.append(self)

    async def aclose(self):
        self.aclose_calls += 1


@pytest.fixture()
def fake_client(monkeypatch):
    FakeClient.instances = []
    monkeypatch.setattr("app.deps.KeitaroClient", FakeClient)
    return FakeClient


def test_dependency_closes_client_after_response(tmp_path, fake_client):
    store = KeyStore(tmp_path / ".keitaro_api_key")
    store.write("k" * 24)

    async def scenario() -> FakeClient:
        agen = get_keitaro_with_key(store)
        client = await agen.__anext__()
        await agen.aclose()  # как FastAPI после успешного ответа
        return client

    client = asyncio.run(scenario())
    assert isinstance(client, FakeClient)
    assert client.api_key == "k" * 24
    assert client.aclose_calls == 1


def test_dependency_closes_client_when_endpoint_raises(tmp_path, fake_client):
    store = KeyStore(tmp_path / ".keitaro_api_key")
    store.write("k" * 24)

    async def scenario() -> FakeClient:
        agen = get_keitaro_with_key(store)
        await agen.__anext__()
        try:
            # Как будто роутер после yield упал с HTTPException.
            await agen.athrow(HTTPException(500, "boom"))
        except HTTPException:
            pass
        return FakeClient.instances[0]

    client = asyncio.run(scenario())
    assert client.aclose_calls == 1


def test_dependency_409_without_key_file(tmp_path, fake_client):
    async def scenario() -> HTTPException:
        agen = get_keitaro_with_key(KeyStore(tmp_path / "absent.key"))
        try:
            await agen.__anext__()
        except HTTPException as e:
            return e
        raise AssertionError("must raise HTTPException")

    e = asyncio.run(scenario())
    assert e.status_code == 409
    assert e.detail == "API key is not configured"
    # Клиент не создавался: без ключа до Keitaro не доходим.
    assert FakeClient.instances == []
