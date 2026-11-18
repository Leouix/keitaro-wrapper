// Streams page: the shared block on status 0 (server/network unavailable).
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StreamsContent } from './StreamsContent';

const json = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

const streamsBody = [
  {
    id: 1313478,
    name: 'Flow 1',
    schema: 'landings',
    offers: [{ offer_id: 4440, share: 100, state: 'active' }],
  },
];

function makeFetch(offerImpl: (url: string) => Promise<unknown>) {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/streams')) return json(200, streamsBody);
    if (url.endsWith('/streams/archive')) return json(200, { archived: [] });
    if (url.endsWith('/streams/pending')) return json(200, { pending: [] });
    if (/\/api\/campaigns\/\d+$/.test(url)) return json(200, { name: 'Campaign 1' });
    if (url.startsWith('/api/offers/')) return offerImpl(url);
    return json(404, null);
  });
}

function renderStreams() {
  return render(
    <MemoryRouter>
      <StreamsContent campaignId="211903" />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StreamsContent — server unavailable (status 0)', () => {
  it('offers fail with status 0: one shared block, rows show a dash without error repeats', async () => {
    vi.stubGlobal('fetch', makeFetch(() => Promise.reject(new TypeError('Failed to fetch'))));
    renderStreams();

    const alerts = await screen.findAllByText(
      'The server is not responding. Check that uvicorn is running and refresh the page.',
    );
    expect(alerts).toHaveLength(1); // exactly one shared block
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();

    // The rows show a dash; the "failed to load the offer" text is not duplicated.
    expect(screen.queryByText('failed to load the offer')).toBeNull();
    expect(screen.getByText('#4440')).toBeTruthy(); // строка на месте
  });

  it('"Retry" refetches the data; after success the block disappears', async () => {
    let offerOk = false;
    vi.stubGlobal(
      'fetch',
      makeFetch(() =>
        offerOk
          ? Promise.resolve(json(200, { id: 4440, name: 'Offer 4440' }))
          : Promise.reject(new TypeError('Failed to fetch')),
      ),
    );
    renderStreams();

    await screen.findByText('The server is not responding. Check that uvicorn is running and refresh the page.');

    offerOk = true;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    // The data was refetched: the offer name appeared, the shared block is gone.
    expect(await screen.findByText('Offer 4440', {}, { timeout: 3000 })).toBeTruthy();
    expect(
      screen.queryByText('The server is not responding. Check that uvicorn is running and refresh the page.'),
    ).toBeNull();
  });

  it('a single offer failure (502) with the server alive — as before, in its own row, without the shared block', async () => {
    vi.stubGlobal('fetch', makeFetch(() => Promise.resolve(json(502, null))));
    renderStreams();

    expect(await screen.findByText('failed to load the offer')).toBeTruthy();
    expect(
      screen.queryByText('The server is not responding. Check that uvicorn is running and refresh the page.'),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('StreamsContent — weight pins', () => {
  const pinSelector =
    'button[data-pin-stream-id="1313478"][data-pin-offer-id="4440"]';
  const pinBtn = () => document.querySelector<HTMLButtonElement>(pinSelector)!;

  function makeStreamsFetch(opts: {
    pinsInPending?: Array<{ stream_id: number; offer_id: number; share: number }>;
    pinsPut?: (body: { pins: unknown[] }) => { status: number; body: unknown };
    pendingPut?: () => { status: number; body: unknown };
  }) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'PUT' && url.endsWith('/pins')) {
        const out = opts.pinsPut
          ? opts.pinsPut(JSON.parse(String(init!.body)))
          : { status: 200, body: { pins: [] } };
        return json(out.status, out.body);
      }
      if (method === 'PUT' && url.endsWith('/pending')) {
        const out = opts.pendingPut
          ? opts.pendingPut()
          : { status: 200, body: { pending: [] } };
        return json(out.status, out.body);
      }
      if (url.endsWith('/streams')) return json(200, streamsBody);
      if (url.endsWith('/streams/archive')) return json(200, { archived: [] });
      if (url.endsWith('/streams/pending')) {
        return json(200, { pending: [], pins: opts.pinsInPending ?? [] });
      }
      if (/\/api\/campaigns\/\d+$/.test(url)) return json(200, { name: 'Campaign 1' });
      if (url.startsWith('/api/offers/')) {
        const id = Number(url.replace('/api/offers/', ''));
        return json(200, { id, name: `Offer ${id}` });
      }
      return json(404, null);
    });
  }

  it('pin: PUT .../pins with the full flow set, aria-pressed=true after the response', async () => {
    const fetchMock = makeStreamsFetch({
      pinsPut: (body) => ({
        status: 200,
        body: { pins: body.pins.map((p: any) => ({ stream_id: 1313478, ...p })) },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderStreams();

    await screen.findByText('#4440');
    expect(pinBtn().getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(pinBtn());

    await waitFor(() => expect(pinBtn().getAttribute('aria-pressed')).toBe('true'));
    const pinsCall = fetchMock.mock.calls.find(
      ([u, i]) => u === '/api/campaigns/211903/streams/1313478/pins' && i?.method === 'PUT',
    );
    expect(pinsCall).toBeTruthy();
    expect(JSON.parse(String(pinsCall![1]!.body))).toEqual({
      pins: [{ offer_id: 4440, share: 100 }],
    });
  });

  it('unpinning: PUT without this offer, aria-pressed=false', async () => {
    const fetchMock = makeStreamsFetch({
      pinsInPending: [{ stream_id: 1313478, offer_id: 4440, share: 100 }],
    });
    vi.stubGlobal('fetch', fetchMock);
    renderStreams();

    await screen.findByText('#4440');
    expect(pinBtn().getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(pinBtn());

    await waitFor(() => expect(pinBtn().getAttribute('aria-pressed')).toBe('false'));
    const pinsCall = fetchMock.mock.calls.find(
      ([u, i]) => u === '/api/campaigns/211903/streams/1313478/pins' && i?.method === 'PUT',
    );
    expect(JSON.parse(String(pinsCall![1]!.body))).toEqual({ pins: [] });
  });

  it('PUT pins error (500): rollback — the pin is removed, the error text in the flow card', async () => {
    const fetchMock = makeStreamsFetch({
      pinsPut: () => ({ status: 500, body: null }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderStreams();

    await screen.findByText('#4440');
    fireEvent.click(pinBtn());

    await screen.findByText('Failed to change the pinned weight. (status 500).');
    expect(pinBtn().getAttribute('aria-pressed')).toBe('false');
  });

  it('404 on PUT pins (a backend without pin routes): the honest text "The server does not support pinned weights yet."', async () => {
    const fetchMock = makeStreamsFetch({
      pinsPut: () => ({ status: 404, body: null }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderStreams();

    await screen.findByText('#4440');
    fireEvent.click(pinBtn());

    expect(await screen.findByText('The server does not support pinned weights yet.')).toBeTruthy();
  });

  it('409 from PUT pending on add: the backend text next to the offer picker, no banner at the top', async () => {
    const fetchMock = makeStreamsFetch({
      pendingPut: () => ({
        status: 409,
        body: { detail: 'All offers are pinned at 100 — unpin first.' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderStreams();

    await screen.findByText('#4440');
    const input = document.getElementById('offer-id-1313478') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '4516' } });
    // The search has a 500 ms debounce: wait for the found hint, then "Add".
    await screen.findByText(/#4516 — Offer 4516/, {}, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(
      await screen.findByText('All offers are pinned at 100 — unpin first.'),
    ).toBeTruthy();
    // Exactly one error block — in the card, no page-level banner.
    expect(screen.getAllByText(/pinned at 100/)).toHaveLength(1);
    // Rollback: the draft is gone, the addition did not stay on screen.
    expect(screen.queryByText('draft')).toBeNull();
  });

  it('"Fetch from Keitaro" does not reset pins', async () => {
    const fetchMock = makeStreamsFetch({
      pinsInPending: [{ stream_id: 1313478, offer_id: 4440, share: 100 }],
    });
    vi.stubGlobal('fetch', fetchMock);
    renderStreams();

    await screen.findByText('#4440');
    fireEvent.click(screen.getByRole('button', { name: /Fetch from Keitaro/ }));
    await screen.findByText(/Updated at/);

    expect(pinBtn().getAttribute('aria-pressed')).toBe('true');
  });

  it('a draft pin → "Cancel" → re-adding the same offer is unpinned', async () => {
    // The pending server side in the mock lives between requests — like the DB.
    let pendingNow: Array<{ stream_id: number; offer_id: number; action: 'add' | 'remove' }> = [];
    const base = makeStreamsFetch({
      pendingPut: () => ({ status: 200, body: { pending: pendingNow } }),
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'PUT' && url.endsWith('/pending')) {
          const body = JSON.parse(String(init!.body)) as { add: number[]; remove: number[] };
          pendingNow = [
            ...body.add.map((offer_id) => ({ stream_id: 1313478, offer_id, action: 'add' as const })),
            ...body.remove.map((offer_id) => ({ stream_id: 1313478, offer_id, action: 'remove' as const })),
          ];
          // The server (after Lin's fix) removes the pin of a cancelled add — a mirror of its behavior.
          return json(200, { pending: pendingNow });
        }
        return base(url, init);
      }),
    );
    renderStreams();

    const input = () => document.getElementById('offer-id-1313478') as HTMLInputElement;
    const draftPin = () =>
      document.querySelector<HTMLButtonElement>(
        'button[data-pin-stream-id="1313478"][data-pin-offer-id="4516"]',
      )!;

    // 1. Add draft 4516 and pin its weight.
    await screen.findByText('#4440');
    fireEvent.change(input(), { target: { value: '4516' } });
    await screen.findByText(/#4516 — Offer 4516/, {}, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByText('draft');
    expect(draftPin().getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(draftPin());
    await waitFor(() => expect(draftPin().getAttribute('aria-pressed')).toBe('true'));

    // 2. "Cancel" — the draft disappears, the pair pin is removed locally.
    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel the pending change of offer #4516 in flow Flow 1' }),
    );
    await waitFor(() => expect(screen.queryByText('draft')).toBeNull());

    // 3. Immediately add the same offer: unpinned, the pin.png icon.
    fireEvent.change(input(), { target: { value: '4516' } });
    await screen.findByText(/#4516 — Offer 4516/, {}, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByText('draft');

    expect(draftPin().getAttribute('aria-pressed')).toBe('false');
  });

  it('the live offer pin stays when another offer draft is cancelled', async () => {
    let pendingNow: Array<{ stream_id: number; offer_id: number; action: 'add' | 'remove' }> = [];
    const base = makeStreamsFetch({
      pinsInPending: [{ stream_id: 1313478, offer_id: 4440, share: 100 }],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'PUT' && url.endsWith('/pending')) {
          const body = JSON.parse(String(init!.body)) as { add: number[]; remove: number[] };
          pendingNow = [
            ...body.add.map((offer_id) => ({ stream_id: 1313478, offer_id, action: 'add' as const })),
            ...body.remove.map((offer_id) => ({ stream_id: 1313478, offer_id, action: 'remove' as const })),
          ];
          return json(200, { pending: pendingNow });
        }
        return base(url, init);
      }),
    );
    renderStreams();

    const input = () => document.getElementById('offer-id-1313478') as HTMLInputElement;

    await screen.findByText('#4440');
    expect(pinBtn().getAttribute('aria-pressed')).toBe('true'); // живой запаян

    // Draft 4516 and its cancel: PUT pins is not called, the 4440 pin stays.
    fireEvent.change(input(), { target: { value: '4516' } });
    await screen.findByText(/#4516 — Offer 4516/, {}, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByText('draft');

    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel the pending change of offer #4516 in flow Flow 1' }),
    );
    await waitFor(() => expect(screen.queryByText('draft')).toBeNull());

    expect(pinBtn().getAttribute('aria-pressed')).toBe('true');
    const pinsCall = base.mock.calls.filter(
      ([u, i]) => u === '/api/campaigns/211903/streams/1313478/pins' && i?.method === 'PUT',
    );
    expect(pinsCall).toHaveLength(0);
  });
});

describe('StreamsContent — 403 on offers (a key without the Offers permission)', () => {
  it('one banner with the detail text; the offer row keeps id and share, "name unavailable: no permission" instead of "failed to load the offer"', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch(() =>
        Promise.resolve(
          json(403, { detail: 'You have no permission to access this page - Offers' }),
        ),
      ),
    );
    renderStreams();

    const banner = await screen.findByText(/Keitaro: no permission for offers/);
    expect(banner.textContent).toBe(
      'Keitaro: no permission for offers: You have no permission to access this page - Offers — replace the API key with one that has the Offers permission',
    );
    // Exactly one banner per page, not per row.
    expect(screen.getAllByText(/no permission for offers/)).toHaveLength(1);

    // The row is not hidden or touched: id, share and status from the streams payload.
    expect(screen.getByText('#4440')).toBeTruthy();
    expect(screen.getByText('100%')).toBeTruthy();
    expect(screen.getByText('name unavailable: no permission')).toBeTruthy();
    expect(screen.queryByText('failed to load the offer')).toBeNull();

    // «Повторить» не предлагаем: права меняются в Keitaro, запрос не поможет.
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('403 and 404 mixed: one banner for 403, 404 stays per row', async () => {
    const twoOffersBody = [
      {
        id: 1313478,
        name: 'Flow 1',
        schema: 'landings',
        offers: [
          { offer_id: 4440, share: 100, state: 'active' },
          { offer_id: 4516, share: 0, state: 'active' },
        ],
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/streams')) return json(200, twoOffersBody);
        if (url.endsWith('/streams/archive')) return json(200, { archived: [] });
        if (url.endsWith('/streams/pending')) return json(200, { pending: [] });
        if (/\/api\/campaigns\/\d+$/.test(url)) return json(200, { name: 'Campaign 1' });
        if (url.endsWith('/api/offers/4440'))
          return json(403, { detail: 'You have no permission to access this page - Offers' });
        if (url.startsWith('/api/offers/')) return json(404, null);
        return json(404, null);
      }),
    );
    renderStreams();

    expect(await screen.findByText(/Keitaro: no permission for offers/)).toBeTruthy();
    expect(screen.getByText('name unavailable: no permission')).toBeTruthy(); // 403 — the honest text
    expect(screen.getByText('failed to load the offer')).toBeTruthy(); // 404 — построчно
  });
});

describe('StreamsContent — "Add" offer (#4518)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function makeAddFetch(
    offerById: Record<number, unknown>,
    putPending: () => Promise<unknown>,
  ) {
    return vi.fn(async (url: string, opts?: RequestInit) => {
      if (url.endsWith('/streams')) return json(200, streamsBody);
      if (url.endsWith('/streams/archive')) return json(200, { archived: [] });
      if (url.endsWith('/streams/pending')) return json(200, { pending: [] });
      if (/\/api\/campaigns\/\d+$/.test(url)) return json(200, { name: 'Campaign 1' });
      if (/\/pending$/.test(url) && opts?.method === 'PUT') return putPending();
      const m = url.match(/^\/api\/offers\/(\d+)$/);
      if (m) {
        const body = offerById[Number(m[1])];
        return body === undefined ? json(404, null) : json(200, body);
      }
      return json(404, null);
    });
  }

  const offersById = {
    4440: { id: 4440, name: 'Offer 4440', state: 'active' },
    4518: {
      id: 4518,
      name: 'Offer 4518',
      payout_value: '1.5',
      payout_currency: 'USD',
      state: 'active',
    },
  };
  const inputEl = () => document.getElementById('offer-id-1313478') as HTMLInputElement;

  it('after "Add" the row immediately shows the name, payout and status — without "failed to load the offer"', async () => {
    vi.stubGlobal(
      'fetch',
      makeAddFetch(offersById, () =>
        Promise.resolve(
          json(200, {
            pending: [{ stream_id: 1313478, offer_id: 4518, action: 'add', created_at: null }],
          }),
        ),
      ),
    );
    renderStreams();

    // The page loaded: the live offer 4440 is visible, the form waits for input.
    expect(await screen.findByText('Offer 4440')).toBeTruthy();

    // Search by ID (500 ms debounce), then "Add".
    fireEvent.change(inputEl(), { target: { value: '4518' } });
    await sleep(600);
    expect(await screen.findByText(/#4518/, {}, { timeout: 3000 })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    // Regression #4518: the offer name and data — immediately, without an error text.
    expect(await screen.findByText('Offer 4518', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByText('failed to load the offer')).toBeNull();
    expect(screen.getByText('1.5 USD')).toBeTruthy(); // выплата из найденного офера
    expect(screen.getByText('draft')).toBeTruthy(); // бейдж отложенного добавления
    // The status in the #4518 row itself.
    expect(screen.getByText('#4518').closest('tr')?.textContent).toContain('active');
  });

  it('a PUT error: the row disappears without a phantom — neither the name nor "failed to load the offer"', async () => {
    vi.stubGlobal(
      'fetch',
      makeAddFetch(offersById, () => Promise.resolve(json(500, null))),
    );
    renderStreams();

    expect(await screen.findByText('Offer 4440')).toBeTruthy();

    fireEvent.change(inputEl(), { target: { value: '4518' } });
    await sleep(600);
    expect(await screen.findByText(/#4518/, {}, { timeout: 3000 })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    // The flow error is shown, pending was rolled back — the added row is gone.
    expect(
      await screen.findByText('Failed to mark the offer for addition. (status 500).', {}, { timeout: 3000 }),
    ).toBeTruthy();
    expect(screen.queryByText('#4518')).toBeNull();
    expect(screen.queryByText('Offer 4518')).toBeNull();
    // The offersMap entry remains, but it does not affect the render: no rows.
    expect(screen.queryByText('failed to load the offer')).toBeNull();
  });
});

describe('StreamsContent — "Fetch from Keitaro"', () => {
  /** A draft in flow 1313478: offer 18813 is marked for addition, lives in the DB. */
  const draftPending = [{ stream_id: 1313478, offer_id: 18813, action: 'add', created_at: null }];

  function makeRefreshFetch({
    streamsImpl = () => Promise.resolve(json(200, streamsBody)),
    offerById = {
      4440: { id: 4440, name: 'Offer 4440', state: 'active' },
      18813: { id: 18813, name: 'Offer 18813', state: 'active' },
    },
    pending = [],
    applyImpl = () => Promise.resolve(json(200, { applied: true, added: [], removed: [] })),
  }: {
    streamsImpl?: () => Promise<unknown>;
    offerById?: Record<number, unknown>;
    pending?: unknown[];
    applyImpl?: () => Promise<unknown>;
  } = {}) {
    return vi.fn(async (url: string, opts?: RequestInit) => {
      if (url.endsWith('/streams')) return streamsImpl();
      if (url.endsWith('/streams/archive')) return json(200, { archived: [] });
      if (/\/pending$/.test(url) && opts?.method === 'PUT') return json(200, { pending });
      if (url.endsWith('/streams/pending')) return json(200, { pending });
      if (/\/apply$/.test(url)) return applyImpl();
      if (/\/api\/campaigns\/\d+$/.test(url)) return json(200, { name: 'Campaign 1' });
      if (url.startsWith('/api/offers/')) {
        const m = url.match(/^\/api\/offers\/(\d+)$/);
        const body = m ? offerById[Number(m[1])] : undefined;
        return body === undefined ? json(404, null) : json(200, body);
      }
      return json(404, null);
    });
  }

  const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

  it('success: a second GET /streams without unmounting or a skeleton, draft 18813 and the counter survive the refresh, focus stays on the button', async () => {
    let release!: () => void;
    let blockRefresh = false;
    const streamsImpl = vi.fn(() => {
      if (!blockRefresh) return Promise.resolve(json(200, streamsBody));
      return new Promise((res) => {
        release = () => res(json(200, streamsBody));
      });
    });
    vi.stubGlobal('fetch', makeRefreshFetch({ streamsImpl, pending: draftPending }));
    const { container } = renderStreams();

    // The page loaded: the live offer and the yellow draft row are in place.
    expect(await screen.findByText('Offer 4440')).toBeTruthy();
    expect(screen.getByText('draft')).toBeTruthy();
    expect(screen.getByText('Changes: +1')).toBeTruthy();

    blockRefresh = true;
    const btn = screen.getByRole('button', { name: 'Fetch from Keitaro' });
    btn.focus();
    fireEvent.click(btn);

    // During the request: the old rows are visible, no skeleton, both buttons disabled.
    expect(button('Refreshing…').disabled).toBe(true);
    expect(button('Send to Keitaro').disabled).toBe(true);
    expect(screen.getByText('Offer 4440')).toBeTruthy();
    expect(screen.queryByText('Loading flows…')).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();

    release();
    expect(await screen.findByText(/Updated at /)).toBeTruthy();

    // Pending survived the refresh: the yellow row and the counter are unchanged.
    expect(screen.getByText('draft')).toBeTruthy();
    expect(screen.getByText('Changes: +1')).toBeTruthy();
    // The button is enabled again, focus on it (it did not unmount).
    const btnAfter = button('Fetch from Keitaro');
    expect(btnAfter.disabled).toBe(false);
    expect(document.activeElement).toBe(btnAfter);
    // The second GET /streams happened.
    expect(streamsImpl).toHaveBeenCalledTimes(2);
  });

  it('502: the error status "Keitaro is unavailable.", rows in place, no pageError, the button enabled again', async () => {
    let fail = false;
    const streamsImpl = vi.fn(() =>
      fail ? Promise.resolve(json(502, null)) : Promise.resolve(json(200, streamsBody)),
    );
    vi.stubGlobal('fetch', makeRefreshFetch({ streamsImpl, pending: draftPending }));
    renderStreams();

    expect(await screen.findByText('Offer 4440')).toBeTruthy();

    fail = true;
    fireEvent.click(screen.getByRole('button', { name: 'Fetch from Keitaro' }));

    expect(await screen.findByText('Keitaro is unavailable.')).toBeTruthy();
    // The page was not replaced by a pageError, the rows and the draft are in place.
    expect(screen.queryByText('Campaign not found.')).toBeNull();
    expect(screen.getByText('Offer 4440')).toBeTruthy();
    expect(screen.getByText('draft')).toBeTruthy();
    expect(button('Fetch from Keitaro').disabled).toBe(false);
  });

  it('status 0 (network): "Network unavailable.", rows in place, no pageError', async () => {
    let fail = false;
    const streamsImpl = vi.fn(() =>
      fail
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(json(200, streamsBody)),
    );
    vi.stubGlobal('fetch', makeRefreshFetch({ streamsImpl, pending: draftPending }));
    renderStreams();

    expect(await screen.findByText('Offer 4440')).toBeTruthy();

    fail = true;
    fireEvent.click(screen.getByRole('button', { name: 'Fetch from Keitaro' }));

    expect(await screen.findByText('Network unavailable.')).toBeTruthy();
    expect(screen.getByText('Offer 4440')).toBeTruthy();
    expect(screen.getByText('draft')).toBeTruthy();
    expect(
      screen.queryByText('The server is not responding. Check that uvicorn is running and refresh the page.'),
    ).toBeNull();
  });

  it('while apply is running, "Fetch from Keitaro" is disabled; enabled again after it finishes', async () => {
    let release!: () => void;
    const applyResult = json(200, { applied: true, added: [18813], removed: [] });
    const applyImpl = () =>
      new Promise((res) => {
        release = () => res(applyResult);
      });
    vi.stubGlobal('fetch', makeRefreshFetch({ pending: draftPending, applyImpl }));
    renderStreams();

    expect(await screen.findByText('Offer 4440')).toBeTruthy();
    expect(button('Fetch from Keitaro').disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Send to Keitaro' }));

    // While sending, refresh is unavailable (mutual exclusion).
    expect(button('Fetch from Keitaro').disabled).toBe(true);
    expect(button('Send to Keitaro').disabled).toBe(true);

    release();
    expect(await screen.findByText(/Flows updated: 1/)).toBeTruthy();
    expect(button('Fetch from Keitaro').disabled).toBe(false);
  });

  it('empty state: the "Fetch from Keitaro" button pulls in flows that appeared in Keitaro without F5', async () => {
    let hasStreams = false;
    vi.stubGlobal(
      'fetch',
      makeRefreshFetch({
        streamsImpl: () => Promise.resolve(json(200, hasStreams ? streamsBody : [])),
      }),
    );
    renderStreams();

    expect(await screen.findByText('This campaign has no flows.')).toBeTruthy();

    hasStreams = true;
    fireEvent.click(screen.getByRole('button', { name: 'Fetch from Keitaro' }));

    expect(await screen.findByText('Offer 4440', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByText('This campaign has no flows.')).toBeNull();
  });
});
