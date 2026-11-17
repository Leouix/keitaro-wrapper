import type { RequestResult } from './types';

/** fetch + разбор JSON; сетевая ошибка → status 0, исключений наружу нет. */
export async function requestJson<T = unknown>(
  url: string,
  options: RequestInit = {},
): Promise<RequestResult<T>> {
  try {
    const res = await fetch(url, options);
    let body: T | null = null;
    try {
      body = (await res.json()) as T;
    } catch {
      // не JSON — оставляем null
    }
    return { status: res.status, ok: res.ok, body };
  } catch {
    return { status: 0, ok: false, body: null };
  }
}

/** detail от FastAPI бывает строкой или массивом объектов {msg}. */
export function detailToText(detail: unknown, fallback: string): string {
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const parts = detail
      .map((d) => {
        if (d && typeof d === 'object' && 'msg' in d) {
          const msg = (d as { msg?: unknown }).msg;
          if (msg) return String(msg);
        }
        return null;
      })
      .filter((x): x is string => Boolean(x));
    if (parts.length) return parts.join('; ');
  }
  return fallback;
}

/** Заголовки для POST/PUT с JSON-телом. */
export const jsonHeaders: Record<string, string> = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

/** Заголовки для GET. */
export const acceptJson: Record<string, string> = { Accept: 'application/json' };
