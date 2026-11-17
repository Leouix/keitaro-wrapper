from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..keitaro import KeitaroClient, KeitaroUnavailable
from ..keybox import MIN_KEY_LENGTH, KeyStore, get_key_store, mask_key, resolve_key

router = APIRouter(prefix="/api", tags=["settings"])


class ApiKeyIn(BaseModel):
    api_key: str = Field(min_length=MIN_KEY_LENGTH, max_length=512)


@router.get("/settings")
def read_settings(store: KeyStore = Depends(get_key_store)):
    """Только факт настройки и маска; полный ключ не возвращается никогда."""
    resolved = resolve_key(store)
    if resolved is None:
        return {"configured": False, "key_masked": None, "source": None}
    key, source = resolved
    return {"configured": True, "key_masked": mask_key(key), "source": source}


def _verify_client(key: str) -> KeitaroClient:
    """Отдельная фабрика — в тестах подменяется на клиент с MockTransport."""
    return KeitaroClient(api_key=key)


@router.post("/settings/api-key")
async def save_api_key(payload: ApiKeyIn, store: KeyStore = Depends(get_key_store)):
    key = payload.api_key.strip()
    if len(key) < MIN_KEY_LENGTH:
        # После strip ключ мог стать короче минимума — проверяем отдельно.
        raise HTTPException(422, f"API key must be at least {MIN_KEY_LENGTH} characters")
    client = _verify_client(key)
    try:
        # Живая проверка: сохраняем ключ только после успешного ответа Keitaro.
        await client.get_campaigns()
    except KeitaroUnavailable:
        raise HTTPException(502, "Keitaro is unreachable, the key was not saved")
    except HTTPException as e:
        # Любой отказ Keitaro (401/403) — проблема ключа или доступа:
        # отдаём 400, ключ не сохраняем. Текст Keitaro секретов не содержит.
        raise HTTPException(400, f"The key was rejected: {e.detail}")
    finally:
        await client.aclose()
    store.write(key)
    return {"configured": True, "key_masked": mask_key(key), "source": "file"}
