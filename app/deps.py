"""Общие FastAPI-зависимости роутеров.

get_keitaro_with_key — единственная фабрика Keitaro-клиента для
data-эндпоинтов (campaigns, offers, streams): ключ берётся из файла
`.keitaro_api_key` (resolve_key), без ключа — 409, похода в Keitaro нет.

Зависимость с yield и try/finally: httpx-клиент закрывается (aclose)
после обработки каждого запроса, даже если роутер упал с HTTPException.
Раньше клиент создавался лениво внутри _request() и закрывался только
в settings-ручке — на каждый data-запрос утекал один пул соединений.
"""

from fastapi import Depends, HTTPException

from .keitaro import KeitaroClient
from .keybox import KeyStore, get_key_store, resolve_key


async def get_keitaro_with_key(store: KeyStore = Depends(get_key_store)):
    """Клиент для data-эндпоинтов: без настроенного ключа — 409, а не поход в Keitaro."""
    resolved = resolve_key(store)
    if resolved is None:
        raise HTTPException(409, "API key is not configured")
    client = KeitaroClient(api_key=resolved[0])
    try:
        yield client
    finally:
        await client.aclose()
