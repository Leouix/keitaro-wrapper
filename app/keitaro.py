import json

import httpx
from fastapi import HTTPException

from .config import get_settings


class KeitaroUnavailable(Exception):
    """5xx/сеть после ретрая — вызывающий код может упасть на кэш."""


class KeitaroClient:
    def __init__(self, api_key: str, api_base: str | None = None, transport=None):
        s = get_settings()
        self.base_url = s.keitaro_base_url.rstrip("/")
        self.api_base = (api_base or s.keitaro_api_base).rstrip("/")
        # Ключ обязателен: data-клиент строится только с явно переданным
        # ключом из resolve_key() (файл .keitaro_api_key). Env-фолбэка нет.
        self.api_key = api_key
        self.timeout, self.retries = s.keitaro_timeout, s.keitaro_retries
        self._transport, self._client = transport, None

    async def _request(
        self,
        method: str,
        path: str,
        json: dict | None = None,
        *,
        write: bool = False,
        retries: int | None = None,
    ):
        """write=True — write-вызовы создателя кампаний:

        - ретраев нет (POST с ретраем при 5xx/сети создаёт дубли кампаний
          или потоков);
        - маппинг ошибок — _handle_write: текст ошибки Keitaro из тела 4xx
          доходит до вызывающего кода, а не схлопывается в «Keitaro
          returned 400». Поведение read-роутов (_handle) не меняется.
        """
        base = self.api_base
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.base_url, timeout=self.timeout, transport=self._transport
            )
        headers = {"Api-Key": self.api_key, "Accept": "application/json"}
        attempts = self.retries if retries is None else retries
        last_error: Exception | None = None
        for _ in range(attempts + 1):
            try:
                resp = await self._client.request(
                    method, f"{base}{path}", headers=headers, json=json
                )
            except httpx.RequestError as e:
                last_error = e
                if write:
                    # Write-вызов: сетевой сбой тоже без ретрая — ретрай
                    # POST мог уже дойти до Keitaro и создал бы дубли.
                    break
                continue
            if resp.status_code >= 500 and not write:
                last_error = httpx.HTTPStatusError(
                    str(resp.status_code), request=resp.request, response=resp
                )
                continue
            return self._handle_write(resp) if write else self._handle(resp)
        raise KeitaroUnavailable(f"Keitaro unavailable: {last_error}")

    @staticmethod
    def _error_text(resp: httpx.Response) -> str | None:
        """Текст ошибки Keitaro из тела 4xx (error/message/detail).

        Только текст ошибки: ключ и заголовки сюда не попадают. Длинное
        тело (например, HTML-страница ошибки) обрезаем до 300 символов,
        чтобы не протаскивать простыню в detail ответа. Понимаем:
        - JSON с ключом error/message/detail (строкой или вложенным
          dict/list — например, валидационные ошибки Keitaro по полям);
        - не-JSON тело (plain text) — отдаём как есть, обрезав.
        """
        try:
            body = resp.json()
        except ValueError:
            text = (resp.text or "").strip()
            if not text:
                return None
            return text[:300] + "…" if len(text) > 300 else text
        text: str | None = None
        if isinstance(body, dict):
            for key in ("error", "message", "detail"):
                value = body.get(key)
                if isinstance(value, str) and value.strip():
                    text = value.strip()
                    break
                if isinstance(value, (dict, list)):
                    # Вложенная ошибка Keitaro (например, по полям) —
                    # сериализуем компактно, текст всё равно обрезается.
                    text = json.dumps(value, ensure_ascii=False)
                    break
        elif isinstance(body, str) and body.strip():
            text = body.strip()
        if text and len(text) > 300:
            text = text[:300] + "…"
        return text

    @staticmethod
    def _handle_write(resp: httpx.Response):
        """Маппинг ответа Keitaro для write-вызовов (создатель кампаний).

        Отличия от read-версии (_handle):
        - 401/403 → 403 с текстом Keitaro (как у read, честно видно «нет прав»);
        - прочие 4xx → 422 «Keitaro validation error: <текст Keitaro>»
          (ошибка валидации наших данных на стороне Keitaro, а не наш сбой);
        - 5xx → 502 (без ретрая — ретрай POST создаёт дубли);
        - 2xx + {"error": …} → 403, как у read (часть сборок отдаёт ошибку с 200).
        """
        status = resp.status_code
        if status in (401, 403):
            text = KeitaroClient._error_text(resp)
            if text:
                raise HTTPException(403, f"Keitaro permission denied: {text}")
            raise HTTPException(403, "Keitaro denied the request (403)")
        if status == 404:
            raise HTTPException(404, "Not found in Keitaro")
        if status >= 500:
            raise HTTPException(502, f"Keitaro returned {status}")
        if status >= 400:
            text = KeitaroClient._error_text(resp)
            if text:
                raise HTTPException(422, f"Keitaro validation error: {text}")
            raise HTTPException(422, f"Keitaro returned {status}")
        try:
            data = resp.json()
        except ValueError:
            raise HTTPException(502, "Keitaro returned non-JSON response")
        if isinstance(data, dict) and "error" in data:
            raise HTTPException(403, f"Keitaro permission denied: {data['error']}")
        return data

    @staticmethod
    def _handle(resp: httpx.Response):
        """Единая таблица маппинга ответа Keitaro → HTTP (фаза 3).

        Вся логика ошибок живёт только здесь — роутеры не маппят коды
        сами, они лишь переводят KeitaroUnavailable (сеть/5xx после
        ретряев) в 502:
        - 401/403            → 403 «Keitaro permission denied: <текст Keitaro>»
                               (текст доходит до фронта как есть — честно
                               видно «нет прав», а не «не удалось загрузить»);
        - 404                → 404 «Not found in Keitaro»;
        - прочие 4xx/5xx     → 502 «Keitaro returned <code>»;
        - не-JSON тело       → 502 «Keitaro returned non-JSON response»;
        - 200 + {"error": …} → 403 (часть сборок отдаёт ошибку с 200).
        Секреты (ключ, заголовки) в сообщения не попадают: только текст
        ошибки от Keitaro.
        """
        status = resp.status_code
        if status in (401, 403):
            # 401/403 от Keitaro — всегда проблема ключа или прав.
            try:
                body = resp.json()
            except ValueError:
                body = None
            if isinstance(body, dict) and "error" in body:
                raise HTTPException(403, f"Keitaro permission denied: {body['error']}")
            raise HTTPException(403, "Keitaro denied the request (403)")
        if status == 404:
            raise HTTPException(404, "Not found in Keitaro")
        if status >= 400:
            raise HTTPException(502, f"Keitaro returned {status}")
        try:
            data = resp.json()
        except ValueError:
            raise HTTPException(502, "Keitaro returned non-JSON response")
        # Некоторые сборки отдают 200 + {"error": "..."} — ловим и это.
        if isinstance(data, dict) and "error" in data:
            raise HTTPException(403, f"Keitaro permission denied: {data['error']}")
        return data

    async def get_campaign(self, campaign_id: int):
        return await self._request("GET", f"/campaigns/{campaign_id}")

    async def get_campaigns(self):
        return await self._request("GET", "/campaigns")

    async def get_campaign_streams(self, campaign_id: int):
        return await self._request("GET", f"/campaigns/{campaign_id}/streams")

    async def get_offer(self, offer_id: int):
        return await self._request("GET", f"/offers/{offer_id}")

    async def get_stream(self, stream_id: int):
        return await self._request("GET", f"/streams/{stream_id}")

    async def get_streams_by_campaign(self, campaign_id: int):
        """GET /streams?campaign_id= — перепроверка, что оффер реально
        пристал к потоку, когда ответ POST /streams его не показал
        (read-вызов: ретраи безопасны)."""
        return await self._request("GET", f"/streams?campaign_id={campaign_id}")

    async def update_stream_offers(self, stream_id: int, campaign_id, offers: list[dict]):
        """PUT /streams/{id} — частичный апдейт: присланные поля меняются,
        остальные (name, type, ...) Keitaro не трогает. Idempotent, поэтому
        ретраи только на сеть/5xx безопасны."""
        return await self._request(
            "PUT",
            f"/streams/{stream_id}",
            json={"campaign_id": campaign_id, "offers": offers},
        )

    async def aclose(self):
        if self._client:
            await self._client.aclose()

    # --- Write-методы создателя кампаний (write=True: без ретраев, текст
    # --- ошибок Keitaro пробрасывается в detail). DELETE /campaigns/{id}
    # --- не удаляет кампанию физически — переводит её в архив
    # --- (state=deleted), поэтому безопасен как компенсация.

    async def create_campaign(self, payload: dict):
        return await self._request("POST", "/campaigns", json=payload, write=True)

    async def create_stream(self, payload: dict):
        return await self._request("POST", "/streams", json=payload, write=True)

    async def enable_campaign(self, campaign_id: int):
        return await self._request(
            "POST", f"/campaigns/{campaign_id}/enable", write=True
        )

    async def archive_campaign(self, campaign_id: int):
        return await self._request("DELETE", f"/campaigns/{campaign_id}", write=True)

    # --- Справочники для формы создания: read-вызовы с обычными ретраями.

    async def get_domains(self):
        return await self._request("GET", "/domains")

    async def get_campaign_groups(self):
        return await self._request("GET", "/groups?type=campaigns")

    async def get_traffic_sources(self):
        return await self._request("GET", "/traffic_sources")
