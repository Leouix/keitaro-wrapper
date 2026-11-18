/** Типы ответов обёртки Keitaro. Контракты зафиксированы по web/app.js, менять нельзя. */

export interface RequestResult<T = unknown> {
  status: number; // 0 — сетевая ошибка
  ok: boolean;
  body: T | null;
}

export interface SettingsInfo {
  configured?: boolean;
  key_masked?: string | null;
}

export interface Campaign {
  id: number;
  name?: string | null;
  alias?: string | null;
  group?: string | null;
  state?: string | null;
  updated_at?: string | null;
}

/** Ответ GET /api/campaigns/{id}: плоский, name приходит только из живого ответа Keitaro; при его недоступности бэкенд отвечает 503. */
export interface CampaignDetail {
  name?: string | null;
  campaign?: { name?: string | null } | null;
}

export interface StreamOfferEntry {
  offer_id: number;
  share?: number | null;
  state?: string | null;
}

export interface Stream {
  id: number;
  name?: string | null;
  schema?: string | null;
  offers?: StreamOfferEntry[] | null;
  campaign_id?: number | null;
}

export interface ArchivedEntry {
  stream_id: number;
  offer_id: number;
  share?: number | null;
  state?: string | null;
  archived_at?: string | null;
  reason?: string | null; // 'keitaro' | 'user' | ...
}

export interface PendingRow {
  stream_id: number;
  offer_id: number;
  action: 'add' | 'remove';
  created_at?: string | null;
}

/** Зафиксированный вес офера в потоке (кнопка-пин). */
export interface PinRow {
  stream_id: number;
  offer_id: number;
  share: number;
}

/** Тело PUT /api/campaigns/{cid}/streams/{sid}/pins — полный набор пинов потока. */
export interface PinsPayload {
  pins: Array<{ offer_id: number; share: number }>;
}

/** Ответ PUT .../pins; поле pins в GET .../streams/pending имеет ту же форму. */
export interface PinsResult {
  pins?: PinRow[] | null;
}

export interface Offer {
  id: number;
  name?: string | null;
  state?: string | null;
  payout_value?: number | string | null;
  payout_currency?: string | null;
}

export interface ApplyResult {
  applied?: boolean;
  noop?: boolean;
  stream?: Stream;
  added?: number[];
  removed?: number[];
}

/* --- Создание кампании: контракт — CAMPAIGN_CREATOR_PLAN.md, разделы 6–7. --- */

export interface CampaignOptionItem {
  id: number;
  name: string;
  state?: string | null;
}

/** Ответ GET /api/campaign-options. */
export interface CampaignOptions {
  domains: CampaignOptionItem[];
  groups: CampaignOptionItem[];
  sources: CampaignOptionItem[];
}

export interface CreateCampaignPayload {
  name: string;
  geos: string[];
  offer_ids: number[];
  domain_id: number;
  group_id: number;
  traffic_source_id: number;
  confirm_duplicate: boolean;
}

export interface CreatedCampaign {
  id: number;
  name?: string | null;
  alias?: string | null;
  url?: string | null;
  state?: string | null;
}

export interface CreatedStream {
  id: number;
  name?: string | null;
}

/** Ответ 201 на POST /api/campaigns. */
export interface CreateCampaignResult {
  campaign: CreatedCampaign;
  streams?: CreatedStream[] | null;
}
