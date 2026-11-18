"""Создатель кампаний Keitaro: справочники формы и создание кампании.

Контракт — CAMPAIGN_CREATOR_PLAN.md §6, согласован с брифом (2026-11-18):
- GET /api/campaign-options — домены/группы/источники для формы, только
  whitelist-поля (id/name/state), без секретов;
- POST /api/campaigns — строго по шагам: кампания (state=disabled) →
  гео-поток (regular, redirect, фильтр country с массивом стран — стран
  может быть несколько, отдельные потоки не нужны) → оффер-поток
  (default, landings, share=100) → enable последним. Любой сбой после
  создания кампании — компенсация DELETE /campaigns/{id} (в архив) и
  502 с указанием шага; если архивировать не удалось — id кампании в
  detail.

Границы безопасности:
- имя, гео и id валидируются здесь (не доверяем клиенту);
- поля кампании задаёт сервер (alias, type, state, cost_type) — из тела
  запроса их переопределить нельзя (pydantic игнорирует лишние поля);
- в ответах — только whitelist-поля, токены и служебные поля Keitaro не
  отдаём;
- текст ошибки Keitaro доходит до фронта как есть (секреты в него не
  попадают — ключ не логируется и не возвращается).
"""

import logging
import re
import secrets
import string

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, conint

from ..constants import equal_shares
from ..deps import get_keitaro_with_key
from ..keitaro import KeitaroClient, KeitaroUnavailable

logger = logging.getLogger(__name__)

router = APIRouter(tags=["campaign-creator"])

GEO_RE = re.compile(r"^[A-Z]{2}$")
MAX_GEOS = 20
MAX_OFFERS = 20
ALIAS_ALPHABET = string.ascii_letters + string.digits
GEO_REDIRECT_URL = "https://google.com"


class CreateCampaignBody(BaseModel):
    name: str
    geos: list[str]
    # offer_ids — основной способ (1..20 оферов, доли равные); offer_id —
    # одиночный офер для совместимости со старым контрактом (ещё этот
    # релиз). Пришли оба — offer_ids выигрывает.
    offer_id: int | None = Field(default=None, gt=0)
    offer_ids: list[conint(gt=0)] | None = None
    domain_id: int = Field(gt=0)
    group_id: int = Field(gt=0)
    traffic_source_id: int = Field(gt=0)
    confirm_duplicate: bool = False


def _normalize_geos(raw: list[str]) -> list[str]:
    """Uppercase, схлопывание дублей с сохранением порядка, 1..20 стран."""
    geos: list[str] = []
    seen: set[str] = set()
    for item in raw:
        code = item.strip().upper()
        if not GEO_RE.match(code):
            raise HTTPException(
                422, f"geos: invalid country code {item!r} (expected ISO-2, e.g. KZ)"
            )
        if code not in seen:
            seen.add(code)
            geos.append(code)
    if not geos:
        raise HTTPException(422, "geos: at least one country is required")
    if len(geos) > MAX_GEOS:
        raise HTTPException(422, f"geos: at most {MAX_GEOS} countries are allowed")
    return geos


def _validate_name(name: str) -> str:
    stripped = name.strip()
    if not stripped:
        raise HTTPException(422, "name: must not be empty")
    if len(stripped) > 255:
        raise HTTPException(422, "name: must be at most 255 characters")
    return stripped


def _generate_alias() -> str:
    # 6 символов [A-Za-z0-9], как генерирует сам Keitaro; занятый alias
    # Keitaro отклонит сам — предварительно проверять не нужно.
    return "".join(secrets.choice(ALIAS_ALPHABET) for _ in range(6))


def _as_campaign_list(data) -> list:
    if isinstance(data, dict) and "campaigns" in data:
        data = data["campaigns"]
    return data if isinstance(data, list) else []


def _find_duplicate(data, name: str) -> dict | None:
    # Точное совпадение имени без учёта регистра (plan §5).
    # Архивные не считаем дублем: на живом legacy /admin_api/v1 (GET,
    # проверено 2026-11-18) их в списке и так нет — DELETE переводит
    # кампанию в state=deleted и прямой GET отдаёт 404 (214213/214214);
    # скип по state страхует сборки, которые отдают удалённые в списке.
    needle = name.lower()
    for item in _as_campaign_list(data):
        if not isinstance(item, dict):
            continue
        if str(item.get("state") or "").lower() == "deleted":
            continue
        if str(item.get("name") or "").strip().lower() == needle:
            return item
    return None


def _normalize_offer_ids(
    offer_ids: list[int] | None, offer_id: int | None
) -> list[int]:
    """Итоговый список офферов: дубли схлопнуты, порядок ввода сохранён.

    offer_ids есть → он и используется (offer_id игнорируется); только
    offer_id → [offer_id] (совместимость со старым контрактом); ни того,
    ни другого (или пустой список) → 422 с формулировкой через offer_ids.
    """
    raw = offer_ids
    if raw is None and offer_id is not None:
        raw = [offer_id]
    if raw is None:
        raise HTTPException(422, "offer_ids: at least one offer is required")
    ids: list[int] = []
    seen: set[int] = set()
    for item in raw:
        if item not in seen:
            seen.add(item)
            ids.append(item)
    if not ids:
        raise HTTPException(422, "offer_ids: at least one offer is required")
    if len(ids) > MAX_OFFERS:
        raise HTTPException(422, f"offer_ids: at most {MAX_OFFERS} offers are allowed")
    return ids


def _campaign_id_of(campaign) -> int | None:
    try:
        return int(campaign.get("id"))
    except (TypeError, ValueError):
        return None


async def _campaign_url(
    keitaro: KeitaroClient, campaign: dict, domain_id: int, alias: str
) -> str | None:
    """Ссылка на кампанию: https://<домен>/<alias>.

    Домен берём из ответа POST /campaigns, если он там есть, иначе один
    read-запрос GET /domains. Ошибка справочника не должна ронять уже
    успешное создание — url в этом случае None.
    """
    host = None
    domain = campaign.get("domain")
    if isinstance(domain, str) and domain.strip():
        host = domain.strip()
    elif isinstance(domain, dict):
        host = domain.get("name") or domain.get("hostname")
    if not host:
        try:
            domains = await keitaro.get_domains()
        except Exception:
            logger.warning("could not fetch domains for campaign url", exc_info=True)
            domains = None
        for item in domains if isinstance(domains, list) else []:
            if isinstance(item, dict) and item.get("id") == domain_id:
                host = item.get("name") or item.get("hostname")
                break
    if not host:
        return None
    return f"https://{str(host).rstrip('/')}/{alias}"


class _OfferNotAttached(Exception):
    """Keitaro ответил 2xx, но не все офферы пристали к потоку.

    Живая кампания без трафика на оффер недопустима: уходим в обычную
    компенсацию (архив кампании) с этим текстом в detail.
    """

    def __init__(self, missing: list[int]):
        self.missing = list(missing)
        if len(missing) == 1:
            text = f"Offer {missing[0]} was not attached to the stream"
        else:
            text = (
                f"Offers {', '.join(str(i) for i in missing)} "
                "were not attached to the stream"
            )
        super().__init__(text)


def _stream_has_offer(stream, offer_id: int) -> bool:
    if not isinstance(stream, dict):
        return False
    return any(
        isinstance(o, dict) and o.get("offer_id") == offer_id
        for o in (stream.get("offers") or [])
    )


def _missing_offers(stream, offer_ids: list[int]) -> list[int]:
    return [oid for oid in offer_ids if not _stream_has_offer(stream, oid)]


async def _require_offers_attached(
    keitaro: KeitaroClient,
    offer_stream,
    campaign_id: int,
    offer_ids: list[int],
) -> None:
    """Все офферы должны реально присутствовать в созданном потоке.

    Сначала смотрим ответ POST /streams; если хоть одного не видно —
    перепроверяем списком потоков кампании (GET /streams?campaign_id=),
    часть сборок не возвращает offers в ответе на создание. Если хоть
    один оффер так и не найден (или перепроверка не удалась — нельзя
    подтвердить полный набор) — _OfferNotAttached → компенсация.
    Fail-closed: лучше откатить кампанию, чем оставить живую без части
    трафика на офферы.
    """
    missing = _missing_offers(offer_stream, offer_ids)
    if not missing:
        return
    try:
        streams = await keitaro.get_streams_by_campaign(campaign_id)
    except Exception:
        logger.warning(
            "offer re-check for campaign %s failed", campaign_id, exc_info=True
        )
        streams = None
    for stream in streams if isinstance(streams, list) else []:
        missing = _missing_offers(stream, offer_ids)
        if not missing:
            return
    raise _OfferNotAttached(missing)


def _step_failure(
    step: str, err: Exception, campaign_id: int | None, archive_error: Exception | None
) -> HTTPException:
    """502 с указанием шага; при неудавшейся компенсации — id кампании."""
    if isinstance(err, KeitaroUnavailable):
        reason = "Keitaro unavailable"
    elif isinstance(err, _OfferNotAttached):
        reason = str(err)
    elif isinstance(err, HTTPException):
        reason = str(err.detail)
    else:
        logger.exception("unexpected failure at step %s", step)
        reason = "unexpected error"
    detail = f"Keitaro failed at step '{step}': {reason}"
    if archive_error is not None:
        detail += (
            f". Campaign {campaign_id} could not be archived — remove it manually"
        )
    return HTTPException(502, detail)


@router.get("/api/campaign-options")
async def campaign_options(keitaro: KeitaroClient = Depends(get_keitaro_with_key)):
    """Справочники формы создания: домены, группы кампаний, источники.

    Только whitelist-поля: domains {id,name,state}, groups/sources
    {id,name}. Секретов здесь нет по определению, но лишние поля Keitaro
    (hostname, archived, ...) наружу не отдаём.
    """
    try:
        domains = await keitaro.get_domains()
        groups = await keitaro.get_campaign_groups()
        sources = await keitaro.get_traffic_sources()
    except KeitaroUnavailable as e:
        raise HTTPException(502, "Keitaro unavailable") from e

    def only_dicts(data) -> list[dict]:
        return [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []

    return {
        "domains": [
            {
                "id": d.get("id"),
                "name": d.get("name") or d.get("hostname"),
                "state": d.get("state"),
            }
            for d in only_dicts(domains)
        ],
        "groups": [{"id": g.get("id"), "name": g.get("name")} for g in only_dicts(groups)],
        "sources": [
            {"id": s.get("id"), "name": s.get("name")} for s in only_dicts(sources)
        ],
    }


@router.post("/api/campaigns", status_code=201)
async def create_campaign(
    body: CreateCampaignBody,
    keitaro: KeitaroClient = Depends(get_keitaro_with_key),
):
    """Создание кампании строго по шагам, с компенсацией при сбое.

    Шаги: POST /campaigns (state=disabled) → POST /streams (гео) →
    POST /streams (оффер) → POST /campaigns/{id}/enable. Сбой любого
    шага после создания кампании → DELETE /campaigns/{id} (в архив) и
    502 с шагом в detail. Ошибка на самом POST /campaigns компенсации
    не требует — кампании ещё нет.
    """
    name = _validate_name(body.name)
    geos = _normalize_geos(body.geos)
    offer_ids = _normalize_offer_ids(body.offer_ids, body.offer_id)

    # Дубль имени: точное совпадение без учёта регистра → 409, фронт
    # переспрашивает («Всё равно создать» → confirm_duplicate=true).
    try:
        existing_list = await keitaro.get_campaigns()
    except KeitaroUnavailable as e:
        raise HTTPException(502, "Keitaro unavailable") from e
    existing = _find_duplicate(existing_list, name)
    if existing is not None and not body.confirm_duplicate:
        return JSONResponse(
            status_code=409,
            content={
                "detail": f"Campaign name already exists: {name}",
                "existing_campaign_id": _campaign_id_of(existing),
            },
        )

    alias = _generate_alias()
    campaign_payload = {
        "name": name,
        "alias": alias,
        "type": "position",
        "state": "disabled",
        "group_id": body.group_id,
        "traffic_source_id": body.traffic_source_id,
        "domain_id": body.domain_id,
        "cost_type": "CPC",
        "cost_value": 0,
    }
    try:
        campaign = await keitaro.create_campaign(campaign_payload)
    except KeitaroUnavailable as e:
        raise HTTPException(502, "Keitaro unavailable") from e
    campaign_id = _campaign_id_of(campaign)
    if not isinstance(campaign, dict) or campaign_id is None:
        raise HTTPException(502, "Keitaro returned unexpected campaign format")

    geo_stream_payload = {
        "campaign_id": campaign_id,
        "type": "regular",
        "name": f"Geo {','.join(geos)} -> Google",
        "position": 1,
        "action_type": "http",
        "action_payload": GEO_REDIRECT_URL,
        "schema": "redirect",
        "collect_clicks": True,
        "filters": [{"name": "country", "mode": "accept", "payload": geos}],
    }
    offer_stream_payload = {
        "campaign_id": campaign_id,
        "type": "default",
        "name": "Offers",
        "position": 2,
        "action_type": "http",
        "schema": "landings",
        "collect_clicks": True,
        # Доли равные, сумма ровно 100 (equal_shares — общее правило со
        # streams.py): порядок офферов — как в вводе.
        "offers": [
            {"offer_id": oid, "share": share}
            for oid, share in zip(offer_ids, equal_shares(len(offer_ids)))
        ],
    }

    step = "geo stream"
    try:
        geo_stream = await keitaro.create_stream(geo_stream_payload)
        step = "offer stream"
        offer_stream = await keitaro.create_stream(offer_stream_payload)
        # Keitaro может молча создать поток без части офферов: проверяем,
        # что пристали ВСЕ (ответ POST → перепроверка списком потоков).
        # Неполный набор — кампанию не включаем, уход в компенсацию ниже.
        await _require_offers_attached(
            keitaro, offer_stream, campaign_id, offer_ids
        )
        step = "enable"
        enabled = await keitaro.enable_campaign(campaign_id)
    except Exception as e:
        # Компенсация на любой сбой после создания кампании — иначе в
        # Keitaro остаётся полусобранная кампания.
        archive_error: Exception | None = None
        try:
            await keitaro.archive_campaign(campaign_id)
        except Exception as ae:
            archive_error = ae
            logger.error(
                "compensation DELETE failed for campaign %s (step %s): %s",
                campaign_id,
                step,
                ae,
            )
        raise _step_failure(step, e, campaign_id, archive_error) from e

    state = "active"
    if isinstance(enabled, dict) and enabled.get("state"):
        state = enabled["state"]
    url = await _campaign_url(keitaro, campaign, body.domain_id, alias)
    return {
        "campaign": {
            "id": campaign_id,
            "name": name,
            "alias": alias,
            "url": url,
            "state": state,
        },
        "streams": [
            {
                "id": geo_stream.get("id") if isinstance(geo_stream, dict) else None,
                "name": (
                    geo_stream.get("name") if isinstance(geo_stream, dict) else None
                ),
            },
            {
                "id": offer_stream.get("id") if isinstance(offer_stream, dict) else None,
                "name": (
                    offer_stream.get("name") if isinstance(offer_stream, dict) else None
                ),
            },
        ],
    }
