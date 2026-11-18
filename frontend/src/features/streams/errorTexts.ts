import { detailToText } from '../../api/client';
import type { RequestResult } from '../../api/types';

/** Строка офера при 403: имя недоступно из-за прав ключа (сам офер не трогаем). */
export const offerNameForbiddenText = 'name unavailable: no permission';

/** Баннер страницы при 403 от GET /api/offers/{id}: в detail — реальный текст Keitaro. */
export function offersForbiddenBanner(body: unknown): string {
  const detail = detailToText((body as { detail?: unknown } | null)?.detail, '');
  return `Keitaro: no permission for offers${detail ? `: ${detail}` : ''} — replace the API key with one that has the Offers permission`;
}

/** Тексты ошибок POST .../apply. */
export function applyErrorText(status: number, body: unknown): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (status === 404) return detailToText(detail, 'The flow or offer was not found in Keitaro.');
  if (status === 409) return detailToText(detail, 'The flow does not accept offers: schema or campaign mismatch.');
  if (status === 502) return 'Keitaro is unavailable.';
  if (status === 0) return 'Network unavailable.';
  return detailToText(detail, `Send failed (status ${status}).`);
}

/** Тексты ошибок PUT/GET .../pending. */
export function pendingChangeErrorText(status: number, body: unknown, fallback: string): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (status === 0) return 'Network unavailable — try again.';
  // 404 у PUT/GET pending бывает только на старом бэкенде без pending-роутов.
  if (status === 404) return 'The server does not support pending changes — a backend with commit 0e8dc9b is required.';
  if (status === 400) return detailToText(detail, fallback);
  return detailToText(detail, `${fallback} (status ${status}).`);
}

/** Тексты ошибок PUT .../pins (кнопка-пин веса офера). */
export function pinsErrorText(status: number, body: unknown, fallback: string): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (status === 0) return 'Network unavailable — try again.';
  // 404 у PUT pins — бэкенд без роутов пинов: фиксация веса пока недоступна.
  if (status === 404) return 'The server does not support pinned weights yet.';
  if (status === 400) return detailToText(detail, fallback);
  return detailToText(detail, `${fallback} (status ${status}).`);
}

/** Тексты ошибок кнопки «Обновить из Кейтаро» (повторный GET /streams). */
export function refreshErrorText(status: number, body: unknown): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (status === 0) return 'Network unavailable.';
  if (status === 502) return 'Keitaro is unavailable.';
  // 403 — честный detail от бэка (права ключа), остальные — с кодом.
  return detailToText(detail, `Failed to refresh (status ${status}).`);
}

export type RequestBody = RequestResult<unknown>['body'];
