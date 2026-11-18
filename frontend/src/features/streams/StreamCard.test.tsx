// Regression test: typing an ID digit by digit with pauses must not fire requests
// on prefixes or flash a red error; steady input — one request and a delayed error.
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

describe('StreamCard — the weight pin button', () => {
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

  it('live offer: the button is present, aria-pressed=false, labels and click pass the current weight', () => {
    const onPinToggle = vi.fn();
    renderCard({ stream: liveStream, onPinToggle });

    const btn = pinBtn(10)!;
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('Pin the weight of offer #10 in flow Flow 1');
    expect(btn.getAttribute('title')).toContain('Pin weight 60%');
    expect(btn.querySelector('img')).toBeTruthy();

    fireEvent.click(btn);
    expect(onPinToggle).toHaveBeenCalledTimes(1);
    expect(onPinToggle.mock.calls[0][1]).toBe(10);
    expect(onPinToggle.mock.calls[0][2]).toBe(60);
  });

  it('pinned offer: aria-pressed=true, the "Unpin…" label, the pined icon', () => {
    renderCard({
      stream: liveStream,
      pins: [{ stream_id: 1313478, offer_id: 10, share: 60 }],
      onPinToggle: vi.fn(),
    });

    const btn = pinBtn(10)!;
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.getAttribute('aria-label')).toBe('Unpin the weight of offer #10 in flow Flow 1');
  });

  it('unavailable: an archived row, pending-remove, a "—" share; available for pending-add', () => {
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

describe('StreamCard: typing an ID digit by digit', () => {
  it('"4516" typed digit by digit with 200–400 ms pauses: one request for the final value, no red on prefixes', async () => {
    // 4516 существует, всё остальное — 404.
    const fetchMock = vi.fn(async (url: string) => {
      const id = Number(url.replace('/api/offers/', ''));
      return id === 4516 ? json(200, { id: 4516, name: 'Offer 4516', payout_value: '1.5', payout_currency: 'USD' }) : json(404, null);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderCard();

    // Typed digit by digit, pauses in the 200–400 ms range.
    fireEvent.change(input(), { target: { value: '4' } });
    await sleep(350);
    expect(fetchMock).not.toHaveBeenCalled(); // 350 < 500: запроса ещё нет
    expect(hint()).toBe('Looking up the offer…');
    expect(hintEl().className).not.toMatch(/error/i);

    fireEvent.change(input(), { target: { value: '45' } });
    await sleep(250);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hint()).toBe('Looking up the offer…');

    fireEvent.change(input(), { target: { value: '451' } });
    await sleep(350);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hint()).toBe('Looking up the offer…');

    fireEvent.change(input(), { target: { value: '4516' } });
    // A 400 ms pause — still no request and no error.
    await sleep(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hint()).not.toMatch(/not found/);

    // The final request — exactly one, for 4516.
    expect(await screen.findByText(/#4516/, {}, { timeout: 3000 })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/offers/4516');
    expect(hint()).not.toMatch(/not found/);
  });

  it('a steady input of a nonexistent ID: the error appears after the delay', async () => {
    const fetchMock = vi.fn(async () => json(404, null));
    vi.stubGlobal('fetch', fetchMock);
    renderCard();

    fireEvent.change(input(), { target: { value: '4517' } });
    // Right after the request there is no error yet (delayed display).
    await sleep(700);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hint()).not.toMatch(/not found/);
    // ERROR_HINT_DELAY_MS after the response — it appears.
    expect(await screen.findByText('Offer with ID 4517 not found', {}, { timeout: 2000 })).toBeTruthy();
  });

  it('the prefix error is not shown if typing continued', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const id = Number(url.replace('/api/offers/', ''));
      return id === 4516 ? json(200, { id: 4516, name: 'Offer 4516' }) : json(404, null);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderCard();

    // A >500 ms pause on "4" → the request fires, 404 comes back and delays the error
    // by ERROR_HINT_DELAY_MS. We keep typing before it fires —
    // the red text is never shown.
    fireEvent.change(input(), { target: { value: '4' } });
    await sleep(600);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.change(input(), { target: { value: '45' } });
    await sleep(300);
    fireEvent.change(input(), { target: { value: '451' } });
    await sleep(300);
    fireEvent.change(input(), { target: { value: '4516' } });
    await sleep(400);
    expect(hint()).not.toMatch(/not found/); // the prefix error window has already passed

    // The final request for "4516" — and the found hint.
    expect(await screen.findByText(/#4516/, {}, { timeout: 3000 })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2); // «4» и финальный «4516»
    expect(hint()).toMatch(/#4516/);
  });
});
