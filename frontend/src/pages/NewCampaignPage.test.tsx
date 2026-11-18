import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { NewCampaignPage } from './NewCampaignPage';

const json = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

const OPTIONS = {
  domains: [{ id: 1813, name: 'kylovoa.com', state: 'active' }],
  groups: [
    { id: 10332, name: 'FORTESTS' },
    { id: 99, name: 'Другая' },
  ],
  sources: [{ id: 836, name: 'FORTESTS' }],
};

let postCalls: { url: string; body: unknown }[] = [];

function defaultFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/campaign-options') return json(200, OPTIONS);
    if (url === '/api/campaigns' && init?.method === 'POST') {
      postCalls.push({ url, body: JSON.parse(String(init.body)) });
      return json(201, {
        campaign: { id: 214213, name: 'leo_kz', alias: 'a1B2c3', url: 'https://kylovoa.com/a1B2c3', state: 'active' },
        streams: [{ id: 1, name: 'Geo KZ -> Google' }, { id: 2, name: 'Offers' }],
      });
    }
    if (url === '/api/offers/18813') return json(200, { id: 18813, name: 'Test offer', state: 'active' });
    if (url === '/api/offers/40404') return json(404, { detail: 'Offer not found' });
    if (url === '/api/offers/40303') return json(403, { detail: 'Keitaro permission denied: offers' });
    return json(200, {});
  });
}

function renderPage(fetchMock = defaultFetch()) {
  postCalls = [];
  vi.stubGlobal('fetch', fetchMock);
  render(
    <MemoryRouter initialEntries={['/campaigns/new']}>
      <Routes>
        <Route path="/campaigns/new" element={<NewCampaignPage />} />
        <Route path="/fb/campaigns/:id/streams" element={<div>streams-probe</div>} />
      </Routes>
    </MemoryRouter>,
  );
  return fetchMock;
}

const nameInput = () => document.getElementById('campaign-name') as HTMLInputElement;
const geoInput = () => document.getElementById('geo-input') as HTMLInputElement;
const offerInput = () => document.getElementById('offer-id') as HTMLInputElement;
const domainSelect = () => document.getElementById('campaign-domain') as HTMLSelectElement;
const groupSelect = () => document.getElementById('campaign-group') as HTMLSelectElement;
const sourceSelect = () => document.getElementById('campaign-source') as HTMLSelectElement;
const submitBtn = () => screen.getByRole('button', { name: /Созда/ }) as HTMLButtonElement;

/** Node в vitest без --localstorage-file не даёт localStorage: in-memory мок. */
let store: Map<string, string>;
function stubStorage() {
  const mem = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (mem.has(key) ? mem.get(key)! : null),
    setItem: (key: string, value: string) => mem.set(key, String(value)),
    removeItem: (key: string) => mem.delete(key),
    clear: () => mem.clear(),
  });
  return mem;
}

async function fillValidForm() {
  await waitFor(() => expect(domainSelect().value).toBe('1813'), { timeout: 3000 });
  fireEvent.change(nameInput(), { target: { value: 'leo_kz' } });
  fireEvent.change(geoInput(), { target: { value: 'KZ' } });
  fireEvent.keyDown(geoInput(), { key: 'Enter' });
  fireEvent.change(offerInput(), { target: { value: '18813' } });
}

beforeEach(() => {
  store = stubStorage();
  document.title = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NewCampaignPage — справочники', () => {
  it('загрузка: скелетон, затем форма; единственные домен и источник подставлены, группа FORTESTS', async () => {
    const fetchMock = renderPage();
    await screen.findByText('Создать кампанию');
    await waitFor(
      () => {
        expect(domainSelect().value).toBe('1813');
        expect(sourceSelect().value).toBe('836');
        expect(groupSelect().value).toBe('10332');
      },
      { timeout: 3000 },
    );
    expect(fetchMock).toHaveBeenCalledWith('/api/campaign-options', expect.anything());
    // выбор запомнен сразу
    expect(JSON.parse(store.get('keitaro.createCampaign.last') || '{}')).toMatchObject({
      domainId: 1813,
      groupId: 10332,
      sourceId: 836,
    });
  });

  it('ошибка справочников: «Повторить», форма не заблокирована, поля ввода работают', async () => {
    let fail = true;
    renderPage(
      vi.fn(async (url: string) => {
        if (url === '/api/campaign-options') {
          return fail ? json(502, null) : json(200, OPTIONS);
        }
        return json(200, {});
      }),
    );
    const alert = await screen.findByRole('alert', {}, { timeout: 3000 });
    expect(alert.textContent).toContain('Keitaro недоступен.');
    expect(screen.getByText('Повторить')).toBeTruthy();
    // форма не заблокирована: имя можно вводить
    fireEvent.change(nameInput(), { target: { value: 'x' } });
    expect(nameInput().value).toBe('x');
    // селекты недоступны, но подписаны
    expect(domainSelect().disabled).toBe(true);

    fail = false;
    fireEvent.click(screen.getByText('Повторить'));
    // значение и активность проверяются в одном waitFor: не зависим от момента опроса
    await waitFor(
      () => {
        expect(domainSelect().disabled).toBe(false);
        expect(domainSelect().value).toBe('1813');
      },
      { timeout: 3000 },
    );
  });

  it('последний выбор восстанавливается из localStorage', async () => {
    store.set(
      'keitaro.createCampaign.last',
      JSON.stringify({ domainId: 1813, groupId: 99, sourceId: 836 }),
    );
    renderPage();
    await waitFor(
      () => {
        expect(groupSelect().value).toBe('99');
        expect(domainSelect().value).toBe('1813');
        expect(sourceSelect().value).toBe('836');
      },
      { timeout: 3000 },
    );
  });
});

describe('NewCampaignPage — валидация', () => {
  it('пустая форма: ошибка про название, POST не уходит', async () => {
    renderPage();
    await fillValidForm();
    fireEvent.change(nameInput(), { target: { value: '' } });
    fireEvent.change(geoInput(), { target: { value: '' } });
    fireEvent.change(offerInput(), { target: { value: '' } });
    fireEvent.click(submitBtn());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Укажите название кампании.');
    expect(postCalls).toHaveLength(0);
  });

  it('гео пустое: «Укажите хотя бы одну страну.», POST не уходит', async () => {
    renderPage();
    await fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: 'Убрать KZ — Казахстан' }));
    fireEvent.click(submitBtn());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Укажите хотя бы одну страну.');
    expect(postCalls).toHaveLength(0);
  });

  it('невалидное гео: неизвестный код не добавляется, POST не уходит', async () => {
    renderPage();
    await fillValidForm();
    // убираем KZ, чтобы гео осталось пустым
    fireEvent.click(screen.getByRole('button', { name: 'Убрать KZ — Казахстан' }));

    fireEvent.change(geoInput(), { target: { value: 'XX' } });
    fireEvent.keyDown(geoInput(), { key: 'Enter' });
    // XX не добавился
    expect(screen.queryByLabelText('Выбранные страны')).toBeNull();
    const hint = document.getElementById('geo-hint') as HTMLElement;
    expect(hint.textContent).toContain('Неизвестный код страны: XX');

    fireEvent.click(submitBtn());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Укажите хотя бы одну страну.');
    expect(postCalls).toHaveLength(0);
  });

  it('ID оффера не число: ошибка, POST не уходит', async () => {
    renderPage();
    await fillValidForm();
    fireEvent.change(offerInput(), { target: { value: '0' } });
    fireEvent.click(submitBtn());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Укажите ID оффера — положительное число.');
    expect(postCalls).toHaveLength(0);
  });
});

describe('NewCampaignPage — гео-чипы', () => {
  it('добавление чипа: по ISO-коду и по подсказке-названию; дубли схлопываются', async () => {
    renderPage();
    await fillValidForm();
    const chips = () => screen.getByLabelText('Выбранные страны');
    expect(chips().textContent).toContain('KZ');
    expect(chips().textContent).toContain('Казахстан');

    // по русскому названию через список подсказок
    fireEvent.change(geoInput(), { target: { value: 'узбеки' } });
    const option = await screen.findByRole('option', { name: /UZ/ });
    fireEvent.mouseDown(option);
    expect(chips().textContent).toContain('UZ');

    // повтор 'kz' — дубль не добавляется
    fireEvent.change(geoInput(), { target: { value: 'kz' } });
    fireEvent.keyDown(geoInput(), { key: 'Enter' });
    expect(chips().querySelectorAll('li')).toHaveLength(2);
  });

  it('удаление чипа кнопкой и Backspace по пустому полю', async () => {
    renderPage();
    await fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: 'Убрать KZ — Казахстан' }));
    expect(screen.queryByLabelText('Выбранные страны')).toBeNull();

    fireEvent.change(geoInput(), { target: { value: 'UZ' } });
    fireEvent.keyDown(geoInput(), { key: 'Enter' });
    expect(screen.getByLabelText('Выбранные страны').textContent).toContain('UZ');

    fireEvent.change(geoInput(), { target: { value: '' } });
    fireEvent.keyDown(geoInput(), { key: 'Backspace' });
    expect(screen.queryByLabelText('Выбранные страны')).toBeNull();
  });
});

describe('NewCampaignPage — проверка оффера', () => {
  it('успешная проверка показывает имя и статус', async () => {
    renderPage();
    await fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));
    const hint = await screen.findByText(/Оффер 18813: Test offer — active/, {}, { timeout: 3000 });
    expect(hint).toBeTruthy();
  });

  it('403 — предупреждение, POST не блокируется', async () => {
    renderPage();
    await fillValidForm();
    fireEvent.change(offerInput(), { target: { value: '40303' } });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));
    const hint = await screen.findByText(/Нет прав у ключа на этот оффер.*Создание кампании не блокируем\./s, {}, { timeout: 3000 });
    expect(hint.textContent).toContain('Keitaro permission denied: offers');

    fireEvent.click(submitBtn());
    await screen.findByText('Кампания создана', {}, { timeout: 3000 });
    expect(postCalls).toHaveLength(1);
  });

  it('404 — оффер не найден', async () => {
    renderPage();
    await fillValidForm();
    fireEvent.change(offerInput(), { target: { value: '40404' } });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));
    await screen.findByText('Оффер 40404 не найден в Keitaro.', {}, { timeout: 3000 });
  });
});

describe('NewCampaignPage — сабмит', () => {
  it('успех: POST с телом контракта, карточка с ID/alias/ссылкой, «Открыть потоки» ведёт на потоки', async () => {
    renderPage();
    await fillValidForm();
    fireEvent.click(submitBtn());

    await screen.findByText('Кампания создана', {}, { timeout: 3000 });
    expect(postCalls[0].body).toEqual({
      name: 'leo_kz',
      geos: ['KZ'],
      offer_id: 18813,
      domain_id: 1813,
      group_id: 10332,
      traffic_source_id: 836,
      confirm_duplicate: false,
    });
    expect(screen.getByText('214213')).toBeTruthy();
    expect(screen.getByText('a1B2c3')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'https://kylovoa.com/a1B2c3' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://kylovoa.com/a1B2c3');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');

    fireEvent.click(screen.getByRole('button', { name: 'Открыть потоки' }));
    expect(await screen.findByText('streams-probe', {}, { timeout: 2000 })).toBeTruthy();
  });

  it('двойной клик — один POST; кнопка заблокирована и aria-busy на время запроса', async () => {
    let resolvePost: (value?: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      resolvePost = resolve;
    });
    renderPage(
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/campaign-options') return json(200, OPTIONS);
        if (url === '/api/campaigns' && init?.method === 'POST') {
          postCalls.push({ url, body: JSON.parse(String(init.body)) });
          await pending;
          return json(201, { campaign: { id: 1, alias: 'x', url: 'https://kylovoa.com/x' } });
        }
        return json(200, {});
      }),
    );
    await fillValidForm();
    fireEvent.click(submitBtn());
    // кнопка уже неактивна и aria-busy
    await waitFor(() => {
      expect(submitBtn().disabled).toBe(true);
      expect(submitBtn().getAttribute('aria-busy')).toBe('true');
    });
    fireEvent.click(submitBtn());
    resolvePost();
    await screen.findByText('Кампания создана', {}, { timeout: 3000 });
    expect(postCalls).toHaveLength(1);
  });

  it('422 — текст по полю из detail', async () => {
    renderPage(
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/campaign-options') return json(200, OPTIONS);
        if (url === '/api/campaigns' && init?.method === 'POST') {
          postCalls.push({ url, body: null });
          return json(422, { detail: [{ msg: 'geos must contain ISO-3166 alpha-2 codes' }] });
        }
        return json(200, {});
      }),
    );
    await fillValidForm();
    fireEvent.click(submitBtn());
    const alert = await screen.findByRole('alert', {}, { timeout: 3000 });
    expect(alert.textContent).toBe('geos must contain ISO-3166 alpha-2 codes');
  });

  it('409 — подтверждение дубля, повтор уходит с confirm_duplicate=true', async () => {
    let calls = 0;
    renderPage(
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/campaign-options') return json(200, OPTIONS);
        if (url === '/api/campaigns' && init?.method === 'POST') {
          calls += 1;
          postCalls.push({ url, body: JSON.parse(String(init.body)) });
          if (calls === 1) {
            return json(409, { campaign_id: 777 });
          }
          return json(201, {
            campaign: { id: 2, alias: 'b2C3d4', url: 'https://kylovoa.com/b2C3d4' },
          });
        }
        return json(200, {});
      }),
    );
    await fillValidForm();
    fireEvent.click(submitBtn());

    const alert = await screen.findByRole('alert', {}, { timeout: 3000 });
    expect(alert.textContent).toContain('Кампания с таким названием уже есть, создать ещё одну?');
    expect(screen.getByRole('link', { name: 'Открыть существующую (ID 777)' })).toBeTruthy();
    expect(postCalls[0].body).toMatchObject({ confirm_duplicate: false });

    fireEvent.click(screen.getByRole('button', { name: 'Всё равно создать' }));
    await screen.findByText('Кампания создана', {}, { timeout: 3000 });
    expect(postCalls[1].body).toMatchObject({ confirm_duplicate: true, name: 'leo_kz', geos: ['KZ'] });
  });

  it('403 — текст Keitaro показывается как есть', async () => {
    renderPage(
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/campaign-options') return json(200, OPTIONS);
        if (url === '/api/campaigns' && init?.method === 'POST') {
          postCalls.push({ url, body: null });
          return json(403, { detail: 'Keitaro permission denied: campaigns.create' });
        }
        return json(200, {});
      }),
    );
    await fillValidForm();
    fireEvent.click(submitBtn());
    const alert = await screen.findByRole('alert', {}, { timeout: 3000 });
    expect(alert.textContent).toBe('Keitaro permission denied: campaigns.create');
  });

  it('502 — «Keitaro недоступен» с шагом сбоя из detail', async () => {
    renderPage(
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/campaign-options') return json(200, OPTIONS);
        if (url === '/api/campaigns' && init?.method === 'POST') {
          postCalls.push({ url, body: null });
          return json(502, { detail: 'сбой на шаге: offer stream' });
        }
        return json(200, {});
      }),
    );
    await fillValidForm();
    fireEvent.click(submitBtn());
    const alert = await screen.findByRole('alert', {}, { timeout: 3000 });
    expect(alert.textContent).toBe('Keitaro недоступен: сбой на шаге: offer stream');
  });

  it('сетевая ошибка (fetch reject) — «Сеть недоступна.»', async () => {
    renderPage(
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/campaign-options') return json(200, OPTIONS);
        if (url === '/api/campaigns' && init?.method === 'POST') {
          throw new Error('offline');
        }
        return json(200, {});
      }),
    );
    await fillValidForm();
    fireEvent.click(submitBtn());
    const alert = await screen.findByRole('alert', {}, { timeout: 3000 });
    expect(alert.textContent).toBe('Сеть недоступна.');
  });
});
