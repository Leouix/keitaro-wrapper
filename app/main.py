from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .db import Base, engine
from .deps import get_keitaro_with_key
from .keitaro import KeitaroUnavailable
from .routers import campaigns, creator, offers, streams
from .routers import settings as settings_router

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Keitaro Wrapper API", version="0.1.0")
app.include_router(settings_router.router)
app.include_router(campaigns.router)
app.include_router(creator.router)
app.include_router(offers.router)
app.include_router(streams.router)
app.include_router(streams.pending_router)

# Фронтенд — собранный React (Vite): исходники в frontend/ (зона Pixel),
# сборка лежит в web/dist/ (в git не хранится), рантайму Node не нужен.
WEB_DIR = Path(__file__).resolve().parent.parent / "web"
DIST_DIR = WEB_DIR / "dist"
INDEX_FILE = DIST_DIR / "index.html"

FRONTEND_NOT_BUILT = (
    "frontend не собран: нет web/dist/index.html (cd frontend && npm ci && npm run build)"
)


def _spa_page() -> FileResponse:
    # Один и тот же index.html для всех SPA-маршрутов; no-store, чтобы после
    # нового деплоя браузер не оставался на старой сборке.
    if not INDEX_FILE.is_file():
        raise HTTPException(503, FRONTEND_NOT_BUILT)
    return FileResponse(INDEX_FILE, headers={"Cache-Control": "no-store"})


@app.get("/", include_in_schema=False)
def index_page():
    return _spa_page()


@app.get("/campaigns", include_in_schema=False)
def campaigns_page():
    return _spa_page()


@app.get("/campaigns/new", include_in_schema=False)
def campaigns_new_page():
    # Прямой заход/обновление страницы создания кампании — тот же SPA-бандл.
    return _spa_page()


@app.get("/fb/campaigns/{campaign_id}/streams", include_in_schema=False)
def streams_page(campaign_id: str):
    # Нечисловой campaign_id — ошибка ссылки, а не бэкенда: HTML всё равно отдаётся.
    return _spa_page()


class HashedAssets(StaticFiles):
    """Раздача web/dist/assets: имена файлов содержат хэш сборки.

    Скрытые имена (.env, .keitaro_api_key, "..") не раздаются ни на одном
    уровне вложенности; существующие файлы кэшируются бессрочно.
    """

    def lookup_path(self, path: str) -> tuple[str, object]:
        if any(part.startswith(".") for part in path.split("/")):
            return "", None
        return super().lookup_path(path)

    def file_response(self, full_path, stat_result, scope, status_code=200):
        response = super().file_response(full_path, stat_result, scope, status_code)
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


# check_dir=False: каталог появляется после `npm run build`, до сборки
# любой /assets/* честно отвечает 404.
app.mount(
    "/assets",
    HashedAssets(directory=str(DIST_DIR / "assets"), check_dir=False),
    name="assets",
)


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/healthz/keitaro")
async def healthz_keitaro(keitaro: KeitaroClient = Depends(get_keitaro_with_key)):
    # Пинг Admin API тем же ключом, что и data-эндпоинты (файл .keitaro_api_key).
    # Без настроенного ключа — 409 «API key is not configured».
    try:
        await keitaro.get_campaigns()
    except KeitaroUnavailable:
        raise HTTPException(502, "Keitaro unavailable")
    # 401/403/502 приходят как HTTPException от клиента сами.
    return {"keitaro": "ok"}
