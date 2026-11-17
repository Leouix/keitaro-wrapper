// Страница потоков: общий блок при status 0 (сервер/сеть недоступны).
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

function makeFetch(offerImpl: () => Promise<unknown>) {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/streams')) return json(200, streamsBody);
    if (url.endsWith('/streams/archive')) return json(200, { archived: [] });
    if (url.endsWith('/streams/pending')) return json(200, { pending: [] });
    if (/\/api\/campaigns\/\d+$/.test(url)) return json(200, { name: 'Кампа 1' });
    if (url.startsWith('/api/offers/')) return offerImpl();
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

describe('StreamsContent — сервер недоступен (status 0)', () => {
  it('оферы падают со статусом 0: один общий блок, в строках прочерк без повторов ошибки', async () => {
    vi.stubGlobal('fetch', makeFetch(() => Promise.reject(new TypeError('Failed to fetch'))));
    renderStreams();

    const alerts = await screen.findAllByText(
      'Сервер не отвечает. Проверьте, что uvicorn запущен, и обновите страницу.',
    );
    expect(alerts).toHaveLength(1); // ровно один общий блок
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeTruthy();

    // В строках — прочерк, текст «не удалось загрузить офер» не дублируется.
    expect(screen.queryByText('не удалось загрузить офер')).toBeNull();
    expect(screen.getByText('#4440')).toBeTruthy(); // строка на месте
  });

  it('«Повторить» перезапрашивает данные; после успеха блок исчезает', async () => {
    let offerOk = false;
    vi.stubGlobal(
      'fetch',
      makeFetch(() =>
        offerOk
          ? Promise.resolve(json(200, { id: 4440, name: 'Офер 4440' }))
          : Promise.reject(new TypeError('Failed to fetch')),
      ),
    );
    renderStreams();

    await screen.findByText('Сервер не отвечает. Проверьте, что uvicorn запущен, и обновите страницу.');

    offerOk = true;
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));

    // Данные перезапрошены: имя офера появилось, общий блок исчез.
    expect(await screen.findByText('Офер 4440', {}, { timeout: 3000 })).toBeTruthy();
    expect(
      screen.queryByText('Сервер не отвечает. Проверьте, что uvicorn запущен, и обновите страницу.'),
    ).toBeNull();
  });

  it('сбой одного офера при живом сервере (502) — как раньше, в своей строке, без общего блока', async () => {
    vi.stubGlobal('fetch', makeFetch(() => Promise.resolve(json(502, null))));
    renderStreams();

    expect(await screen.findByText('не удалось загрузить офер')).toBeTruthy();
    expect(
      screen.queryByText('Сервер не отвечает. Проверьте, что uvicorn запущен, и обновите страницу.'),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull();
  });
});

describe('StreamsContent — «Добавить» офер (#4518)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function makeAddFetch(
    offerById: Record<number, unknown>,
    putPending: () => Promise<unknown>,
  ) {
    return vi.fn(async (url: string, opts?: RequestInit) => {
      if (url.endsWith('/streams')) return json(200, streamsBody);
      if (url.endsWith('/streams/archive')) return json(200, { archived: [] });
      if (url.endsWith('/streams/pending')) return json(200, { pending: [] });
      if (/\/api\/campaigns\/\d+$/.test(url)) return json(200, { name: 'Кампа 1' });
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
    4440: { id: 4440, name: 'Офер 4440', state: 'active' },
    4518: {
      id: 4518,
      name: 'Офер 4518',
      payout_value: '1.5',
      payout_currency: 'USD',
      state: 'active',
    },
  };
  const inputEl = () => document.getElementById('offer-id-1313478') as HTMLInputElement;

  it('после «Добавить» строка сразу показывает имя, выплату и статус — без «не удалось загрузить офер»', async () => {
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

    // Страница загрузилась: живой офер 4440 виден, формы ждут ввода.
    expect(await screen.findByText('Офер 4440')).toBeTruthy();

    // Поиск по ID (дебаунс 500 мс), затем «Добавить».
    fireEvent.change(inputEl(), { target: { value: '4518' } });
    await sleep(600);
    expect(await screen.findByText(/#4518/, {}, { timeout: 3000 })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));

    // Регрессия #4518: имя и данные офера — сразу, без текста ошибки.
    expect(await screen.findByText('Офер 4518', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByText('не удалось загрузить офер')).toBeNull();
    expect(screen.getByText('1.5 USD')).toBeTruthy(); // выплата из найденного офера
    expect(screen.getByText('черновик')).toBeTruthy(); // бейдж отложенного добавления
    // Статус в самой строке #4518.
    expect(screen.getByText('#4518').closest('tr')?.textContent).toContain('active');
  });

  it('ошибка PUT: строка исчезает без «фантома» — ни имени, ни «не удалось загрузить офер»', async () => {
    vi.stubGlobal(
      'fetch',
      makeAddFetch(offersById, () => Promise.resolve(json(500, null))),
    );
    renderStreams();

    expect(await screen.findByText('Офер 4440')).toBeTruthy();

    fireEvent.change(inputEl(), { target: { value: '4518' } });
    await sleep(600);
    expect(await screen.findByText(/#4518/, {}, { timeout: 3000 })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));

    // Ошибка потока показана, откатил pending — добавленной строки больше нет.
    expect(
      await screen.findByText('Не удалось пометить офер к добавлению. (код 500).', {}, { timeout: 3000 }),
    ).toBeTruthy();
    expect(screen.queryByText('#4518')).toBeNull();
    expect(screen.queryByText('Офер 4518')).toBeNull();
    // Запись в offersMap осталась, но на рендер не влияет: строк нет.
    expect(screen.queryByText('не удалось загрузить офер')).toBeNull();
  });
});
