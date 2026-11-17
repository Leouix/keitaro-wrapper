import re
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse

from .db import Base, engine
from .keitaro import KeitaroClient, KeitaroUnavailable
from .routers import campaigns, offers, streams
from .routers import settings as settings_router
from .routers.campaigns import get_keitaro

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Keitaro Wrapper API", version="0.1.0")
app.include_router(settings_router.router)
app.include_router(campaigns.router)
app.include_router(offers.router)
app.include_router(streams.router)

# Фронт — статика из web/ (файлы принадлежат Pixel, бэкенд только отдаёт их).
WEB_DIR = Path(__file__).resolve().parent.parent / "web"

# Один уровень вложенности: обычное имя файла без ведущей точки.
# Это же отсекает .env и любые скрытые/системные файлы от раздачи.
_ASSET_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


def _serve(name: str):
    path = WEB_DIR / name
    if not path.is_file():
        raise HTTPException(404, "Static file not found")
    return FileResponse(path)


@app.get("/", include_in_schema=False)
def index_page():
    return _serve("index.html")


@app.get("/campaigns", include_in_schema=False)
def campaigns_page():
    return _serve("campaigns.html")


@app.get("/fb/campaigns/{campaign_id}/streams", include_in_schema=False)
def streams_page(campaign_id: str):
    return _serve("streams.html")


@app.get("/assets/{name}", include_in_schema=False)
def asset_file(name: str):
    if not _ASSET_NAME.fullmatch(name):
        raise HTTPException(404, "Static file not found")
    return _serve(name)


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/healthz/keitaro")
async def healthz_keitaro(keitaro: KeitaroClient = Depends(get_keitaro)):
    # Пинг Admin API: проверка доступности — один запрос.
    try:
        await keitaro.get_campaigns()
    except KeitaroUnavailable:
        raise HTTPException(502, "Keitaro unavailable")
    # 401/403/502 приходят как HTTPException от клиента сами.
    return {"keitaro": "ok"}
