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

function renderCard() {
  return render(
    <StreamCard
      stream={stream}
      pendingRows={[]}
      archive={[]}
      offersMap={new Map()}
      sending={false}
      busy={false}
      error={null}
      serverDown={false}
      onDelete={vi.fn()}
      onCancel={vi.fn()}
      onBringBack={vi.fn()}
      onAdd={vi.fn(async () => {})}
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
