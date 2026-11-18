// Регрессионный тест: набор ID по цифре с паузами не должен порождать запросы
// на префиксах и вспышки красной ошибки; устойчивый ввод — один запрос и отложенный показ ошибки.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { StreamCard } from './StreamCard';
import type { Stream } from '../../api/types';

const json = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

const stream: Stream = { id: 1313478, schema: 'landings', offers: [] } as Stream;

function renderCard(overrides: Partial<Parameters<typeof StreamCard>[0]> = {}) {
  return render(
    <StreamCard
      stream={stream}
      pendingRows={[]}
      archive={[]}
      pins={[]}
      offersMap={new Map()}
      sending={false}
      busy={false}
      error={null}
      serverDown={false}
      onDelete={vi.fn()}
      onCancel={vi.fn()}
      onBringBack={vi.fn()}
      onAdd={vi.fn(async () => {})}
      onPinToggle={vi.fn()}
      {...overrides}
    />,
  );
}

const input = () => document.getElementById('offer-id-1313478') as HTMLInputElement;
const hintEl = () => document.getElementById('offer-hint-1313478') as HTMLElement;
const hint = () => hintEl().textContent ?? '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StreamCard — кнопка-пин веса', () => {
  const liveStream: Stream = {
    id: 1313478,
    name: 'Flow 1',
    schema: 'landings',
    offers: [
      { offer_id: 10, share: 60, state: 'active' },
      { offer_id: 11, share: 40, state: 'active' },
      { offer_id: 12, share: null, state: 'active' },
    ],
  };

  function pinBtn(offerId: number) {
    return document.querySelector<HTMLButtonElement>(
      `button[data-pin-stream-id="1313478"][data-pin-offer-id="${offerId}"]`,
    );
  }

  it('живой офер: кнопка есть, aria-pressed=false, подписи и клик отдают текущий вес', () => {
    const onPinToggle = vi.fn();
    renderCard({ stream: liveStream, onPinToggle });

    const btn = pinBtn(10)!;
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('Зафиксировать вес офера #10 в потоке Flow 1');
    expect(btn.getAttribute('title')).toContain('Зафиксировать вес 60%');
    expect(btn.querySelector('img')).toBeTruthy();

    fireEvent.click(btn);
    expect(onPinToggle).toHaveBeenCalledTimes(1);
    expect(onPinToggle.mock.calls[0][1]).toBe(10);
    expect(onPinToggle.mock.calls[0][2]).toBe(60);
  });

  it('зафиксированный офер: aria-pressed=true, подпись «Снять фиксацию…», иконка pined', () => {
    renderCard({
      stream: liveStream,
      pins: [{ stream_id: 1313478, offer_id: 10, share: 60 }],
      onPinToggle: vi.fn(),
    });

    const btn = pinBtn(10)!;
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.getAttribute('aria-label')).toBe('Снять фиксацию веса офера #10 в потоке Flow 1');
  });

  it('недоступна: архивная строка, pending-remove, доля «—»; доступна у pending-add', () => {
    renderCard({
      stream: liveStream,
      pendingRows: [
        { stream_id: 1313478, offer_id: 11, action: 'remove', created_at: null },
        { stream_id: 1313478, offer_id: 20, action: 'add', created_at: null },
      ],
      archive: [{ stream_id: 1313478, offer_id: 30, state: 'active', reason: 'user' }],
      onPinToggle: vi.fn(),
    });

    // remove → прочерк, кнопки нет
    expect(pinBtn(11)).toBeNull();
    // доля null у живого офера → кнопки нет
    expect(pinBtn(12)).toBeNull();
    // архив → кнопки нет
    expect(pinBtn(30)).toBeNull();
    // pending-add с показанным весом → кнопка есть
    expect(pinBtn(20)).toBeTruthy();
  });
});

describe('StreamCard: набор ID по цифре', () => {
  it('«4516» по цифре с паузами 200–400 мс: один запрос на финальное значение, без красного на префиксах', async () => {
    // 4516 существует, всё остальное — 404.
    const fetchMock = vi.fn(async (url: string) => {
      const id = Number(url.replace('/api/offers/', ''));
      return id === 4516 ? json(200, { id: 4516, name: 'Офер 4516', payout_value: '1.5', payout_currency: 'USD' }) : json(404, null);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderCard();

    // Набор по цифре, паузы в диапазоне Льва (200–400 мс).
    fireEvent.change(input(), { target: { value: '4' } });
    await sleep(350);
    expect(fetchMock).not.toHaveBeenCalled(); // 350 < 500: запроса ещё нет
    expect(hint()).toBe('Ищем оффер…');
    expect(hintEl().className).not.toMatch(/error/i);

    fireEvent.change(input(), { target: { value: '45' } });
    await sleep(250);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hint()).toBe('Ищем оффер…');

    fireEvent.change(input(), { target: { value: '451' } });
    await sleep(350);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hint()).toBe('Ищем оффер…');

    fireEvent.change(input(), { target: { value: '4516' } });
    // Пауза 400 мс — всё ещё нет запроса и нет ошибки.
    await sleep(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hint()).not.toMatch(/не найден/);

    // Финальный запрос — ровно один, на 4516.
    expect(await screen.findByText(/#4516/, {}, { timeout: 3000 })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/offers/4516');
    expect(hint()).not.toMatch(/не найден/);
  });

  it('устойчивый ввод несуществующего ID: ошибка показывается после задержки', async () => {
    const fetchMock = vi.fn(async () => json(404, null));
    vi.stubGlobal('fetch', fetchMock);
    renderCard();

    fireEvent.change(input(), { target: { value: '4517' } });
    // Сразу после запроса ошибки ещё нет (отложенный показ).
    await sleep(700);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hint()).not.toMatch(/не найден/);
    // Через ERROR_HINT_DELAY_MS после ответа — появляется.
    expect(await screen.findByText('Офер с ID 4517 не найден', {}, { timeout: 2000 })).toBeTruthy();
  });

  it('ошибка префикса не показывается, если ввод продолжился', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const id = Number(url.replace('/api/offers/', ''));
      return id === 4516 ? json(200, { id: 4516, name: 'Офер 4516' }) : json(404, null);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderCard();

    // Пауза >500 мс на «4» → запрос уходит, 404 приходит и откладывает ошибку
    // на ERROR_HINT_DELAY_MS. Продолжаем ввод до того, как она сработает, —
    // красный текст так и не показывается.
    fireEvent.change(input(), { target: { value: '4' } });
    await sleep(600);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.change(input(), { target: { value: '45' } });
    await sleep(300);
    fireEvent.change(input(), { target: { value: '451' } });
    await sleep(300);
    fireEvent.change(input(), { target: { value: '4516' } });
    await sleep(400);
    expect(hint()).not.toMatch(/не найден/); // окно ошибки префикса уже прошло

    // Финальный запрос на «4516» — и найденная подсказка.
    expect(await screen.findByText(/#4516/, {}, { timeout: 3000 })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2); // «4» и финальный «4516»
    expect(hint()).toMatch(/#4516/);
  });
});
