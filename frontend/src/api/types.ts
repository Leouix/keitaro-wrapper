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

/** Ответ GET /api/campaigns/{id}: свежий ответ отдаёт name, stale кладёт кампанию внутрь. */
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
