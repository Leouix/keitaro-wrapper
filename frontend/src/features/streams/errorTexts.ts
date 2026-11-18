import { detailToText } from '../../api/client';
import type { RequestResult } from '../../api/types';

/** Строка офера при 403: имя недоступно из-за прав ключа (сам офер не трогаем). */
export const offerNameForbiddenText = 'название недоступно: нет прав';

/** Баннер страницы при 403 от GET /api/offers/{id}: в detail — реальный текст Keitaro. */
export function offersForbiddenBanner(body: unknown): string {
  const detail = detailToText((body as { detail?: unknown } | null)?.detail, '');
  return `Keitaro: нет прав на оферы${detail ? `: ${detail}` : ''} — замените API-ключ на ключ с правом Offers`;
}

/** Тексты ошибок POST .../apply. */
export function applyErrorText(status: number, body: unknown): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (status === 404) return detailToText(detail, 'Поток или офер не найден в Keitaro.');
  if (status === 409) return detailToText(detail, 'Поток не принимает оферы: не совпадает схема или кампания.');
  if (status === 502) return 'Keitaro недоступен.';
  if (status === 0) return 'Сеть недоступна.';
  return detailToText(detail, `Ошибка отправки (код ${status}).`);
}

/** Тексты ошибок PUT/GET .../pending. */
export function pendingChangeErrorText(status: number, body: unknown, fallback: string): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (status === 0) return 'Сеть недоступна, попробуйте ещё раз.';
  // 404 у PUT/GET pending бывает только на старом бэкенде без pending-роутов.
  if (status === 404) return 'Сервер не поддерживает отложенные изменения — нужен бэкенд с коммитом 0e8dc9b.';
  if (status === 400) return detailToText(detail, fallback);
  return detailToText(detail, `${fallback} (код ${status}).`);
}

/** Тексты ошибок кнопки «Обновить из Кейтаро» (повторный GET /streams). */
export function refreshErrorText(status: number, body: unknown): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (status === 0) return 'Сеть недоступна.';
  if (status === 502) return 'Keitaro недоступен.';
  // 403 — честный detail от бэка (права ключа), остальные — с кодом.
  return detailToText(detail, `Не удалось обновить (код ${status}).`);
}

export type RequestBody = RequestResult<unknown>['body'];
