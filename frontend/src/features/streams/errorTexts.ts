import { detailToText } from '../../api/client';
import type { RequestResult } from '../../api/types';

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

export type RequestBody = RequestResult<unknown>['body'];
