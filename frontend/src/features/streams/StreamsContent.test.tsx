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

function makeFetch(offerImpl: (url: string) => Promise<unknown>) {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/streams')) return json(200, streamsBody);
    if (url.endsWith('/streams/archive')) return json(200, { archived: [] });
    if (url.endsWith('/streams/pending')) return json(200, { pending: [] });
    if (/\/api\/campaigns\/\d+$/.test(url)) return json(200, { name: 'Кампа 1' });
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

describe('StreamsContent — 403 на оферы (ключ без права Offers)', () => {
  it('один баннер с текстом detail; в строке офера id и доля на месте, «название недоступно: нет прав» вместо «не удалось загрузить офер»', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch(() =>
        Promise.resolve(
          json(403, { detail: 'You have no permission to access this page - Offers' }),
        ),
      ),
    );
    renderStreams();

    const banner = await screen.findByText(/Keitaro: нет прав на оферы/);
    expect(banner.textContent).toBe(
      'Keitaro: нет прав на оферы: You have no permission to access this page - Offers — замените API-ключ на ключ с правом Offers',
    );
    // Ровно один баннер на страницу, а не по строкам.
    expect(screen.getAllByText(/нет прав на оферы/)).toHaveLength(1);

    // Строка не прячется и не трогается: id, доля и статус из payload потоков.
    expect(screen.getByText('#4440')).toBeTruthy();
    expect(screen.getByText('100%')).toBeTruthy();
    expect(screen.getByText('название недоступно: нет прав')).toBeTruthy();
    expect(screen.queryByText('не удалось загрузить офер')).toBeNull();

    // Повторить не предлагаем: права меняются в Keitaro, запрос не поможет.
    expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull();
  });

  it('403 и 404 вперемешку: один баннер на 403, 404 остаётся построчно', async () => {
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
        if (/\/api\/campaigns\/\d+$/.test(url)) return json(200, { name: 'Кампа 1' });
        if (url.endsWith('/api/offers/4440'))
          return json(403, { detail: 'You have no permission to access this page - Offers' });
        if (url.startsWith('/api/offers/')) return json(404, null);
        return json(404, null);
      }),
    );
    renderStreams();

    expect(await screen.findByText(/Keitaro: нет прав на оферы/)).toBeTruthy();
    expect(screen.getByText('название недоступно: нет прав')).toBeTruthy(); // 403 — честный текст
    expect(screen.getByText('не удалось загрузить офер')).toBeTruthy(); // 404 — построчно
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

describe('StreamsContent — «Обновить из Кейтаро»', () => {
  /** Черновик в потоке 1313478: офер 18813 помечен к добавлению, живёт в БД. */
  const draftPending = [{ stream_id: 1313478, offer_id: 18813, action: 'add', created_at: null }];

  function makeRefreshFetch({
    streamsImpl = () => Promise.resolve(json(200, streamsBody)),
    offerById = {
      4440: { id: 4440, name: 'Офер 4440', state: 'active' },
      18813: { id: 18813, name: 'Офер 18813', state: 'active' },
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
      if (/\/api\/campaigns\/\d+$/.test(url)) return json(200, { name: 'Кампа 1' });
      if (url.startsWith('/api/offers/')) {
        const m = url.match(/^\/api\/offers\/(\d+)$/);
        const body = m ? offerById[Number(m[1])] : undefined;
        return body === undefined ? json(404, null) : json(200, body);
      }
      return json(404, null);
    });
  }

  const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

  it('успех: второй GET /streams без размонтирования и скелета, черновик 18813 и счётчик переживают refresh, фокус остаётся на кнопке', async () => {
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

    // Страница загрузилась: живой офер и жёлтая строка черновика на месте.
    expect(await screen.findByText('Офер 4440')).toBeTruthy();
    expect(screen.getByText('черновик')).toBeTruthy();
    expect(screen.getByText('Изменений: +1')).toBeTruthy();

    blockRefresh = true;
    const btn = screen.getByRole('button', { name: 'Обновить из Кейтаро' });
    btn.focus();
    fireEvent.click(btn);

    // Во время запроса: старые строки видны, скелета нет, обе кнопки disabled.
    expect(button('Обновляем…').disabled).toBe(true);
    expect(button('Отправить в Кейтаро').disabled).toBe(true);
    expect(screen.getByText('Офер 4440')).toBeTruthy();
    expect(screen.queryByText('Загружаем потоки…')).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();

    release();
    expect(await screen.findByText(/Обновлено в /)).toBeTruthy();

    // Pending пережил refresh: жёлтая строка и счётчик не изменились.
    expect(screen.getByText('черновик')).toBeTruthy();
    expect(screen.getByText('Изменений: +1')).toBeTruthy();
    // Кнопка снова активна, фокус на ней (не размонтировалась).
    const btnAfter = button('Обновить из Кейтаро');
    expect(btnAfter.disabled).toBe(false);
    expect(document.activeElement).toBe(btnAfter);
    // Второй GET /streams случился.
    expect(streamsImpl).toHaveBeenCalledTimes(2);
  });

  it('502: error-статус «Keitaro недоступен.», строки на месте, pageError не появился, кнопка снова активна', async () => {
    let fail = false;
    const streamsImpl = vi.fn(() =>
      fail ? Promise.resolve(json(502, null)) : Promise.resolve(json(200, streamsBody)),
    );
    vi.stubGlobal('fetch', makeRefreshFetch({ streamsImpl, pending: draftPending }));
    renderStreams();

    expect(await screen.findByText('Офер 4440')).toBeTruthy();

    fail = true;
    fireEvent.click(screen.getByRole('button', { name: 'Обновить из Кейтаро' }));

    expect(await screen.findByText('Keitaro недоступен.')).toBeTruthy();
    // Страница не заменена на pageError, строки и черновик на месте.
    expect(screen.queryByText('Кампания не найдена.')).toBeNull();
    expect(screen.getByText('Офер 4440')).toBeTruthy();
    expect(screen.getByText('черновик')).toBeTruthy();
    expect(button('Обновить из Кейтаро').disabled).toBe(false);
  });

  it('status 0 (сеть): «Сеть недоступна.», строки на месте, pageError не появился', async () => {
    let fail = false;
    const streamsImpl = vi.fn(() =>
      fail
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(json(200, streamsBody)),
    );
    vi.stubGlobal('fetch', makeRefreshFetch({ streamsImpl, pending: draftPending }));
    renderStreams();

    expect(await screen.findByText('Офер 4440')).toBeTruthy();

    fail = true;
    fireEvent.click(screen.getByRole('button', { name: 'Обновить из Кейтаро' }));

    expect(await screen.findByText('Сеть недоступна.')).toBeTruthy();
    expect(screen.getByText('Офер 4440')).toBeTruthy();
    expect(screen.getByText('черновик')).toBeTruthy();
    expect(
      screen.queryByText('Сервер не отвечает. Проверьте, что uvicorn запущен, и обновите страницу.'),
    ).toBeNull();
  });

  it('пока идёт отправка (apply), «Обновить из Кейтаро» disabled; после завершения снова активна', async () => {
    let release!: () => void;
    const applyResult = json(200, { applied: true, added: [18813], removed: [] });
    const applyImpl = () =>
      new Promise((res) => {
        release = () => res(applyResult);
      });
    vi.stubGlobal('fetch', makeRefreshFetch({ pending: draftPending, applyImpl }));
    renderStreams();

    expect(await screen.findByText('Офер 4440')).toBeTruthy();
    expect(button('Обновить из Кейтаро').disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Отправить в Кейтаро' }));

    // Во время отправки обновление недоступно (взаимное исключение).
    expect(button('Обновить из Кейтаро').disabled).toBe(true);
    expect(button('Отправить в Кейтаро').disabled).toBe(true);

    release();
    expect(await screen.findByText(/Потоков обновлено: 1/)).toBeTruthy();
    expect(button('Обновить из Кейтаро').disabled).toBe(false);
  });

  it('empty-state: кнопка «Обновить из Кейтаро» подтягивает появившиеся в Кейтаро потоки без F5', async () => {
    let hasStreams = false;
    vi.stubGlobal(
      'fetch',
      makeRefreshFetch({
        streamsImpl: () => Promise.resolve(json(200, hasStreams ? streamsBody : [])),
      }),
    );
    renderStreams();

    expect(await screen.findByText('В этой кампании нет потоков.')).toBeTruthy();

    hasStreams = true;
    fireEvent.click(screen.getByRole('button', { name: 'Обновить из Кейтаро' }));

    expect(await screen.findByText('Офер 4440', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByText('В этой кампании нет потоков.')).toBeNull();
  });
});
