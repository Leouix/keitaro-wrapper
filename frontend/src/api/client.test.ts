import { describe, expect, it, vi } from 'vitest';
import { detailToText, requestJson } from './client';

describe('detailToText', () => {
  it('строка → как есть (без трима — как в web/app.js)', () => {
    expect(detailToText('Ключ отклонён', 'fallback')).toBe('Ключ отклонён');
    expect(detailToText('  x  ', 'fallback')).toBe('  x  ');
  });

  it('массив {msg} → склейка через ; ', () => {
    expect(detailToText([{ msg: 'a' }, { msg: 'b' }], 'fallback')).toBe('a; b');
  });

  it('массив без msg / пустой → fallback', () => {
    expect(detailToText([{}], 'fallback')).toBe('fallback');
    expect(detailToText([], 'fallback')).toBe('fallback');
  });

  it('null/undefined/число → fallback', () => {
    expect(detailToText(null, 'fallback')).toBe('fallback');
    expect(detailToText(undefined, 'fallback')).toBe('fallback');
    expect(detailToText(42, 'fallback')).toBe('fallback');
  });

  it('пустая строка → fallback', () => {
    expect(detailToText('   ', 'fallback')).toBe('fallback');
  });
});

describe('requestJson', () => {
  it('JSON-ответ разбирается, ok по статусу', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ configured: true }), { status: 200 })),
    );
    const r = await requestJson<{ configured: boolean }>('/api/settings');
    expect(r).toEqual({ status: 200, ok: true, body: { configured: true } });
    vi.unstubAllGlobals();
  });

  it('не-JSON тело → body null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>', { status: 500 })),
    );
    const r = await requestJson('/x');
    expect(r.status).toBe(500);
    expect(r.ok).toBe(false);
    expect(r.body).toBeNull();
    vi.unstubAllGlobals();
  });

  it('сетевая ошибка → status 0, исключений наружу нет', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );
    const r = await requestJson('/x');
    expect(r).toEqual({ status: 0, ok: false, body: null });
    vi.unstubAllGlobals();
  });
});
