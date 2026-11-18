import { acceptJson, detailToText, jsonHeaders, requestJson } from '../../api/client';
import type {
  CampaignOptions,
  CreateCampaignResult,
  CreateCampaignPayload,
  Offer,
} from '../../api/types';

/** GET /api/campaign-options — домены, группы и источники для формы. */
export async function fetchCampaignOptions(): Promise<{
  status: number;
  options: CampaignOptions | null;
  detail: string;
}> {
  const { status, body } = await requestJson<CampaignOptions>('/api/campaign-options', {
    headers: acceptJson,
  });
  const ok = status === 200 && body && Array.isArray(body.domains) && Array.isArray(body.groups) && Array.isArray(body.sources);
  return {
    status,
    options: ok ? body : null,
    detail: detailToText((body as { detail?: unknown } | null)?.detail, ''),
  };
}

/** GET /api/offers/{id} — имя и статус оффера; 403 не блокирует создание. */
export async function checkOffer(
  offerId: number,
): Promise<{ status: number; name: string | null; state: string | null; detail: string }> {
  const { status, body } = await requestJson<Offer>(`/api/offers/${offerId}`, { headers: acceptJson });
  const ok = status === 200 && body;
  return {
    status,
    name: ok ? body.name ?? null : null,
    state: ok ? body.state ?? null : null,
    detail: detailToText((body as { detail?: unknown } | null)?.detail, ''),
  };
}

/** POST /api/campaigns — создание кампании. Тело контракта — план, раздел 6. */
export async function createCampaign(
  payload: CreateCampaignPayload,
): Promise<{ status: number; body: CreateCampaignResult | null; detail: string; bodyId: number | null }> {
  const { status, body } = await requestJson<CreateCampaignResult>('/api/campaigns', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(payload),
  });
  // В теле 409 бэкенд отдаёт id существующей кампании (имя поля не фиксировано в контракте).
  const dup = body as { campaign_id?: unknown; id?: unknown } | null;
  const bodyId =
    typeof dup?.campaign_id === 'number'
      ? dup.campaign_id
      : typeof dup?.id === 'number'
        ? dup.id
        : null;
  return {
    status,
    body: status === 201 ? body : null,
    detail: detailToText((body as { detail?: unknown } | null)?.detail, ''),
    bodyId,
  };
}
