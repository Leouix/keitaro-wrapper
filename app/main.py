from fastapi import Depends, FastAPI, HTTPException

from .db import Base, engine
from .keitaro import KeitaroClient, KeitaroUnavailable
from .routers import campaigns
from .routers.campaigns import get_keitaro

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Keitaro Wrapper API", version="0.1.0")
app.include_router(campaigns.router)


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/healthz/keitaro")
async def healthz_keitaro(keitaro: KeitaroClient = Depends(get_keitaro)):
    # Пинг Admin API: после добавления IP в белый список проверка — один запрос.
    try:
        await keitaro.get_campaigns()
    except KeitaroUnavailable:
        raise HTTPException(502, "Keitaro unavailable")
    # 401/403/502 приходят как HTTPException от клиента сами.
    return {"keitaro": "ok"}
