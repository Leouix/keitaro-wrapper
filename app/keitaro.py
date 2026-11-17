import httpx
from fastapi import HTTPException

from .config import get_settings


class KeitaroUnavailable(Exception):
    """5xx/сеть после ретрая — вызывающий код может упасть на кэш."""


class KeitaroClient:
    def __init__(self, api_key: str | None = None, api_base: str | None = None, transport=None):
        s = get_settings()
        self.base_url = s.keitaro_base_url.rstrip("/")
        self.api_base = (api_base or s.keitaro_api_base).rstrip("/")
        self.api_key = api_key or s.keitaro_api_key
        self.timeout, self.retries = s.keitaro_timeout, s.keitaro_retries
        self._transport, self._client = transport, None

    async def _request(self, method: str, path: str, json: dict | None = None):
        base = self.api_base
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.base_url, timeout=self.timeout, transport=self._transport
            )
        headers = {"Api-Key": self.api_key, "Accept": "application/json"}
        last_error: Exception | None = None
        for _ in range(self.retries + 1):
            try:
                resp = await self._client.request(
                    method, f"{base}{path}", headers=headers, json=json
                )
            except httpx.RequestError as e:
                last_error = e
                continue
            if resp.status_code >= 500:
                last_error = httpx.HTTPStatusError(
                    str(resp.status_code), request=resp.request, response=resp
                )
                continue
            return self._handle(resp)
        raise KeitaroUnavailable(f"Keitaro unavailable: {last_error}")

    @staticmethod
    def _handle(resp: httpx.Response):
        status = resp.status_code
        if status in (401, 403):
            # 403 различаем: JSON с полем error — права ключа,
            # HTML-страница логина — белый список IP.
            try:
                body = resp.json()
            except ValueError:
                body = None
            if isinstance(body, dict) and "error" in body:
                raise HTTPException(403, f"Keitaro permission denied: {body['error']}")
            raise HTTPException(
                502,
                "Keitaro admin blocked for this IP: 403 login page, check IP whitelist",
            )
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
