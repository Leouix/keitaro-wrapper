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
    if (url === '/api/offers/50505') return json(502, null);
    {
      const m = url.match(/^\/api\/offers\/(\d+)$/);
      if (m) return json(200, { id: Number(m[1]), name: `Offer ${m[1]}`, state: 'active' });
    }
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
const offerInput = () => document.getElementById('offer-input') as HTMLInputElement;
const offerChips = () => document.querySelector('[aria-label="Выбранные офферы"]') as HTMLElement | null;
const offerHint = () => document.getElementById('offer-hint') as HTMLElement;
const offerWarns = () => document.querySelector('p[class*="warnLine"]') as HTMLElement | null;
const offerCalls = (mock: ReturnType<typeof vi.fn>, id: number) =>
  mock.mock.calls.filter(([u]) => u === `/api/offers/${id}`);
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
  fireEvent.keyDown(offerInput(), { key: 'Enter' });
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

  it('оффер не число или ноль: inline-ошибка, без запроса; чип не добавляется', async () => {
    const mock = renderPage();
    await waitFor(() => expect(domainSelect().value).toBe('1813'), { timeout: 3000 });

    fireEvent.change(offerInput(), { target: { value: 'abc' } });
    await screen.findByText('Введите ID оффера — положительное число.', {}, { timeout: 3000 });
    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(offerChips()).toBeNull();
    expect(offerCalls(mock, 0)).toHaveLength(0);

    fireEvent.change(offerInput(), { target: { value: '0' } });
    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(offerHint().textContent).toContain('Введите ID оффера — положительное число.');
    expect(offerChips()).toBeNull();

    // остальная форма валидна, чтобы ошибка остановилась именно на офферах
    fireEvent.change(nameInput(), { target: { value: 'leo_kz' } });
    fireEvent.change(geoInput(), { target: { value: 'KZ' } });
    fireEvent.keyDown(geoInput(), { key: 'Enter' });

    fireEvent.click(submitBtn());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Укажите хотя бы один оффер.');
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

describe('NewCampaignPage — офферы-чипы', () => {
  it('кнопки «Проверить» нет; проверка при вводе без кнопки', async () => {
    renderPage();
    await waitFor(() => expect(domainSelect().value).toBe('1813'), { timeout: 3000 });
    expect(screen.queryByRole('button', { name: 'Проверить' })).toBeNull();
    expect(screen.queryByText('Проверить')).toBeNull();
  });

  it('добавление после дебаунс-проверки: подсказка с именем и статусом, запрос ровно один на id', async () => {
    const mock = renderPage();
    await waitFor(() => expect(domainSelect().value).toBe('1813'), { timeout: 3000 });

    fireEvent.change(offerInput(), { target: { value: '18813' } });
    await screen.findByText(/Оффер 18813: Test offer — active/, {}, { timeout: 3000 });
    expect(offerCalls(mock, 18813)).toHaveLength(1);

    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(offerChips()?.textContent).toContain('18813');
    expect(offerChips()?.textContent).toContain('Test offer');
    expect(offerChips()?.textContent).toContain('100%');

    // пережидаем дебаунс после очистки поля: повторного запроса нет
    await new Promise((r) => setTimeout(r, 700));
    expect(offerCalls(mock, 18813)).toHaveLength(1);
  });

  it('404 — оффер не добавляется, при отправке блокирующая ошибка', async () => {
    const mock = renderPage();
    await waitFor(() => expect(domainSelect().value).toBe('1813'), { timeout: 3000 });
    fireEvent.change(offerInput(), { target: { value: '40404' } });
    await screen.findByText('Оффер 40404 не найден в Keitaro.', {}, { timeout: 3000 });
    expect(offerCalls(mock, 40404)).toHaveLength(1);

    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(offerChips()).toBeNull();

    fireEvent.change(nameInput(), { target: { value: 'leo_kz' } });
    fireEvent.change(geoInput(), { target: { value: 'KZ' } });
    fireEvent.keyDown(geoInput(), { key: 'Enter' });
    fireEvent.click(submitBtn());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Укажите хотя бы один оффер.');
    expect(postCalls).toHaveLength(0);
  });

  it('403 — добавляется с предупреждением, создание не блокируется', async () => {
    renderPage();
    await waitFor(() => expect(domainSelect().value).toBe('1813'), { timeout: 3000 });
    fireEvent.change(offerInput(), { target: { value: '40303' } });
    await screen.findByText(/Оффер 40303: нет прав у ключа/, {}, { timeout: 3000 });

    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(offerChips()?.textContent).toContain('40303');
    expect(offerWarns()?.textContent).toContain('40303 — нет прав у ключа, проверит сервер');

    fireEvent.change(nameInput(), { target: { value: 'leo_kz' } });
    fireEvent.change(geoInput(), { target: { value: 'KZ' } });
    fireEvent.keyDown(geoInput(), { key: 'Enter' });
    fireEvent.click(submitBtn());
    await screen.findByText('Кампания создана', {}, { timeout: 3000 });
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0].body).toMatchObject({ offer_ids: [40303] });
  });

  it('502 — добавляется с предупреждением «добавлен без проверки»', async () => {
    renderPage();
    await waitFor(() => expect(domainSelect().value).toBe('1813'), { timeout: 3000 });
    fireEvent.change(offerInput(), { target: { value: '50505' } });
    await screen.findByText(/Оффер 50505: Keitaro недоступен/, {}, { timeout: 3000 });

    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(offerChips()?.textContent).toContain('50505');
    expect(offerWarns()?.textContent).toContain('50505 — Keitaro недоступен, добавлен без проверки');
  });

  it('дубль игнорируется с короткой подсказкой, запрос не повторяется', async () => {
    const mock = renderPage();
    await waitFor(() => expect(domainSelect().value).toBe('1813'), { timeout: 3000 });

    fireEvent.change(offerInput(), { target: { value: '18813' } });
    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(offerChips()?.querySelectorAll('li')).toHaveLength(1);

    fireEvent.change(offerInput(), { target: { value: '18813' } });
    await screen.findByText('Оффер 18813 уже добавлен.', {}, { timeout: 3000 });
    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(offerHint().textContent).toContain('уже добавлен');
    expect(offerChips()?.querySelectorAll('li')).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 700));
    expect(offerCalls(mock, 18813)).toHaveLength(1);
  });

  it('максимум 20 офферов', async () => {
    renderPage();
    await waitFor(() => expect(domainSelect().value).toBe('1813'), { timeout: 3000 });

    fireEvent.change(offerInput(), {
      target: { value: '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20' },
    });
    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(offerChips()?.querySelectorAll('li')).toHaveLength(20);

    fireEvent.change(offerInput(), { target: { value: '21' } });
    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(offerHint().textContent).toContain('Не больше 20 офферов.');
    expect(offerChips()?.querySelectorAll('li')).toHaveLength(20);
  });

  it('доли 50/50 при двух, пересчёт после удаления; крестик и Backspace удаляют', async () => {
    const mock = renderPage();
    await waitFor(() => expect(domainSelect().value).toBe('1813'), { timeout: 3000 });

    fireEvent.change(offerInput(), { target: { value: '18813,18814' } });
    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    const chips = () => offerChips()!.querySelectorAll('li');
    expect(chips()).toHaveLength(2);
    expect(chips()[0].textContent).toContain('50%');
    expect(chips()[1].textContent).toContain('50%');
    expect(screen.getByText('Веса равные, сумма 100.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Убрать оффер 18814' }));
    expect(chips()).toHaveLength(1);
    expect(chips()[0].textContent).toContain('100%');
    expect(screen.queryByText('Веса равные, сумма 100.')).toBeNull();

    // повторное добавление удалённого: имя возвращается из кэша
    fireEvent.change(offerInput(), { target: { value: '18814' } });
    await screen.findByText(/Оффер 18814: Offer 18814 — active/, {}, { timeout: 3000 });
    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(chips()).toHaveLength(2);
    expect(chips()[1].textContent).toContain('Offer 18814');
    expect(chips()[1].textContent).toContain('50%');
    // запрос по 18814 был только один — при повторном добавлении нового нет
    expect(offerCalls(mock, 18814)).toHaveLength(1);

    fireEvent.change(offerInput(), { target: { value: '' } });
    fireEvent.keyDown(offerInput(), { key: 'Backspace' });
    expect(chips()).toHaveLength(1);
  });

  it('повторное добавление удалённого оффера — имя/статус из кэша, без нового запроса', async () => {
    const mock = renderPage();
    await waitFor(() => expect(domainSelect().value).toBe('1813'), { timeout: 3000 });

    fireEvent.change(offerInput(), { target: { value: '18813' } });
    await screen.findByText(/Оффер 18813: Test offer — active/, {}, { timeout: 3000 });
    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(offerChips()?.textContent).toContain('Test offer');
    fireEvent.click(screen.getByRole('button', { name: 'Убрать оффер 18813' }));
    expect(offerChips()).toBeNull();

    // снова тот же ID: подсказка из кэша и чип с именем, запрос не повторяется
    fireEvent.change(offerInput(), { target: { value: '18813' } });
    await screen.findByText(/Оффер 18813: Test offer — active/, {}, { timeout: 3000 });
    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(offerChips()?.querySelectorAll('li')).toHaveLength(1);
    expect(offerChips()?.textContent).toContain('Test offer');
    expect(offerChips()?.textContent).toContain('100%');
    await new Promise((r) => setTimeout(r, 700));
    expect(offerCalls(mock, 18813)).toHaveLength(1);
  });

  it('доли 34/33/33 при трёх офферах (остаток — первому)', async () => {
    renderPage();
    await waitFor(() => expect(domainSelect().value).toBe('1813'), { timeout: 3000 });

    fireEvent.change(offerInput(), { target: { value: '18813, 18814, 18815' } });
    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    const chips = offerChips()!.querySelectorAll('li');
    expect(chips).toHaveLength(3);
    expect(chips[0].textContent).toContain('34%');
    expect(chips[1].textContent).toContain('33%');
    expect(chips[2].textContent).toContain('33%');
    expect(screen.getByText('Веса равные, сумма 100.')).toBeTruthy();
  });

  it('без офферов отправка блокируется', async () => {
    renderPage();
    await fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: 'Убрать оффер 18813' }));
    expect(offerChips()).toBeNull();

    fireEvent.click(submitBtn());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Укажите хотя бы один оффер.');
    expect(postCalls).toHaveLength(0);
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
      offer_ids: [18813],
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
