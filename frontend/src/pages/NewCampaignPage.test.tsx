import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    { id: 99, name: 'Other' },
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
const offerChips = () => document.querySelector('[aria-label="Selected offers"]') as HTMLElement | null;
const offerHint = () => document.getElementById('offer-hint') as HTMLElement;
const offerWarns = () => document.querySelector('p[class*="warnLine"]') as HTMLElement | null;
const offerCalls = (mock: ReturnType<typeof vi.fn>, id: number) =>
  mock.mock.calls.filter(([u]) => u === `/api/offers/${id}`);
const domainSelect = () => document.getElementById('campaign-domain') as HTMLSelectElement;
const groupSelect = () => document.getElementById('campaign-group') as HTMLSelectElement;
const sourceSelect = () => document.getElementById('campaign-source') as HTMLSelectElement;
const submitBtn = () => screen.getByRole('button', { name: /Crea/ }) as HTMLButtonElement;

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

describe('NewCampaignPage — dictionaries', () => {
  it('loading: skeleton, then the form; the only domain and source are preselected, FORTESTS group', async () => {
    const fetchMock = renderPage();
    await screen.findByText('Create campaign');
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

  it('dictionary error: "Retry", the form is not blocked, inputs work', async () => {
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
    expect(alert.textContent).toContain('Keitaro is unavailable.');
    expect(screen.getByText('Retry')).toBeTruthy();
    // форма не заблокирована: имя можно вводить
    fireEvent.change(nameInput(), { target: { value: 'x' } });
    expect(nameInput().value).toBe('x');
    // селекты недоступны, но подписаны
    expect(domainSelect().disabled).toBe(true);

    fail = false;
    fireEvent.click(screen.getByText('Retry'));
    // значение и активность проверяются в одном waitFor: не зависим от момента опроса
    await waitFor(
      () => {
        expect(domainSelect().disabled).toBe(false);
        expect(domainSelect().value).toBe('1813');
      },
      { timeout: 3000 },
    );
  });

  it('the last choice is restored from localStorage', async () => {
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

describe('NewCampaignPage — validation', () => {
  it('empty form: name error, no POST', async () => {
    renderPage();
    await fillValidForm();
    fireEvent.change(nameInput(), { target: { value: '' } });
    fireEvent.change(geoInput(), { target: { value: '' } });
    fireEvent.change(offerInput(), { target: { value: '' } });
    fireEvent.click(submitBtn());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Enter the campaign name.');
    expect(postCalls).toHaveLength(0);
  });

  it('empty geo: "Select at least one country.", no POST', async () => {
    renderPage();
    await fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: 'Remove KZ — Kazakhstan' }));
    fireEvent.click(submitBtn());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Select at least one country.');
    expect(postCalls).toHaveLength(0);
  });

  it('invalid geo: an unknown code is not added, no POST', async () => {
    renderPage();
    await fillValidForm();
    // remove KZ so that geo stays empty
    fireEvent.click(screen.getByRole('button', { name: 'Remove KZ — Kazakhstan' }));

    fireEvent.change(geoInput(), { target: { value: 'XX' } });
    fireEvent.keyDown(geoInput(), { key: 'Enter' });
    // XX не добавился
    expect(screen.queryByLabelText('Selected countries')).toBeNull();
    const hint = document.getElementById('geo-hint') as HTMLElement;
    expect(hint.textContent).toContain('Unknown country code: XX');

    fireEvent.click(submitBtn());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Select at least one country.');
    expect(postCalls).toHaveLength(0);
  });

  it('offer is not a number or zero: inline error, no request; chip not added', async () => {
    const mock = renderPage();
    await waitFor(() => expect(domainSelect().value).toBe('1813'), { timeout: 3000 });

    fireEvent.change(offerInput(), { target: { value: 'abc' } });
    await screen.findByText('Enter the offer ID — a positive number.', {}, { timeout: 3000 });
    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(offerChips()).toBeNull();
    expect(offerCalls(mock, 0)).toHaveLength(0);

    fireEvent.change(offerInput(), { target: { value: '0' } });
    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(offerHint().textContent).toContain('Enter the offer ID — a positive number.');
    expect(offerChips()).toBeNull();

    // the rest of the form is valid so the error stops on the offers
    fireEvent.change(nameInput(), { target: { value: 'leo_kz' } });
    fireEvent.change(geoInput(), { target: { value: 'KZ' } });
    fireEvent.keyDown(geoInput(), { key: 'Enter' });

    fireEvent.click(submitBtn());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Select at least one offer.');
    expect(postCalls).toHaveLength(0);
  });
});

describe('NewCampaignPage — geo chips', () => {
  it('adding a chip: by ISO code and by suggestion name; duplicates collapse', async () => {
    renderPage();
    await fillValidForm();
    const chips = () => screen.getByLabelText('Selected countries');
    expect(chips().textContent).toContain('KZ');
    expect(chips().textContent).toContain('Kazakhstan');

    // by country name through the suggestion list
    fireEvent.change(geoInput(), { target: { value: 'uzbek' } });
    const option = await screen.findByRole('option', { name: /UZ/ });
    fireEvent.mouseDown(option);
    expect(chips().textContent).toContain('UZ');

    // повтор 'kz' — дубль не добавляется
    fireEvent.change(geoInput(), { target: { value: 'kz' } });
    fireEvent.keyDown(geoInput(), { key: 'Enter' });
    expect(chips().querySelectorAll('li')).toHaveLength(2);
  });

  it('removing a chip with the button and Backspace on an empty field', async () => {
    renderPage();
    await fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: 'Remove KZ — Kazakhstan' }));
    expect(screen.queryByLabelText('Selected countries')).toBeNull();

    fireEvent.change(geoInput(), { target: { value: 'UZ' } });
    fireEvent.keyDown(geoInput(), { key: 'Enter' });
    expect(screen.getByLabelText('Selected countries').textContent).toContain('UZ');

    fireEvent.change(geoInput(), { target: { value: '' } });
    fireEvent.keyDown(geoInput(), { key: 'Backspace' });
    expect(screen.queryByLabelText('Selected countries')).toBeNull();
  });
});

describe('NewCampaignPage — offer chips', () => {
  it('no "Check" button; checking on input without a button', async () => {
    renderPage();
    await waitFor(() => expect(domainSelect().value).toBe('1813'), { timeout: 3000 });
    expect(screen.queryByRole('button', { name: 'Check' })).toBeNull();
    expect(screen.queryByText('Check')).toBeNull();
  });

  it('adding after the debounce check: a hint with name and status, exactly one request per id', async () => {
    const mock = renderPage();
    await waitFor(() => expect(domainSelect().value).toBe('1813'), { timeout: 3000 });

    fireEvent.change(offerInput(), { target: { value: '18813' } });
    await screen.findByText(/Offer 18813: Test offer — active/, {}, { timeout: 3000 });
    expect(offerCalls(mock, 18813)).toHaveLength(1);

    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(offerChips()?.textContent).toContain('18813');
    expect(offerChips()?.textContent).toContain('Test offer');
    expect(offerChips()?.textContent).toContain('100%');

    // пережидаем дебаунс после очистки поля: повторного запроса нет
    await new Promise((r) => setTimeout(r, 700));
    expect(offerCalls(mock, 18813)).toHaveLength(1);
  });

  it('404 — the offer is not added, a blocking error on submit', async () => {
    const mock = renderPage();
    await waitFor(() => expect(domainSelect().value).toBe('1813'), { timeout: 3000 });
    fireEvent.change(offerInput(), { target: { value: '40404' } });
    await screen.findByText('Offer 40404 not found in Keitaro.', {}, { timeout: 3000 });
    expect(offerCalls(mock, 40404)).toHaveLength(1);

    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(offerChips()).toBeNull();

    fireEvent.change(nameInput(), { target: { value: 'leo_kz' } });
    fireEvent.change(geoInput(), { target: { value: 'KZ' } });
    fireEvent.keyDown(geoInput(), { key: 'Enter' });
    fireEvent.click(submitBtn());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Select at least one offer.');
    expect(postCalls).toHaveLength(0);
  });

  it('403 — added with a warning, creation is not blocked', async () => {
    renderPage();
    await waitFor(() => expect(domainSelect().value).toBe('1813'), { timeout: 3000 });
    fireEvent.change(offerInput(), { target: { value: '40303' } });
    await screen.findByText(/Offer 40303: no permission for the key/, {}, { timeout: 3000 });

    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(offerChips()?.textContent).toContain('40303');
    expect(offerWarns()?.textContent).toContain('40303 — no permission for the key — the server will check');

    fireEvent.change(nameInput(), { target: { value: 'leo_kz' } });
    fireEvent.change(geoInput(), { target: { value: 'KZ' } });
    fireEvent.keyDown(geoInput(), { key: 'Enter' });
    fireEvent.click(submitBtn());
    await screen.findByText('Campaign created', {}, { timeout: 3000 });
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0].body).toMatchObject({ offer_ids: [40303] });
  });

  it('502 — added with an "added without a check" warning', async () => {
    renderPage();
    await waitFor(() => expect(domainSelect().value).toBe('1813'), { timeout: 3000 });
    fireEvent.change(offerInput(), { target: { value: '50505' } });
    await screen.findByText(/Offer 50505: Keitaro is unavailable/, {}, { timeout: 3000 });

    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(offerChips()?.textContent).toContain('50505');
    expect(offerWarns()?.textContent).toContain('50505 — Keitaro is unavailable — added without a check');
  });

  it('a duplicate is ignored with a short hint, no repeated request', async () => {
    const mock = renderPage();
    await waitFor(() => expect(domainSelect().value).toBe('1813'), { timeout: 3000 });

    fireEvent.change(offerInput(), { target: { value: '18813' } });
    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(offerChips()?.querySelectorAll('li')).toHaveLength(1);

    fireEvent.change(offerInput(), { target: { value: '18813' } });
    await screen.findByText('Offer 18813 is already added.', {}, { timeout: 3000 });
    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(offerHint().textContent).toContain('already added');
    expect(offerChips()?.querySelectorAll('li')).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 700));
    expect(offerCalls(mock, 18813)).toHaveLength(1);
  });

  it('a maximum of 20 offers', async () => {
    renderPage();
    await waitFor(() => expect(domainSelect().value).toBe('1813'), { timeout: 3000 });

    fireEvent.change(offerInput(), {
      target: { value: '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20' },
    });
    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(offerChips()?.querySelectorAll('li')).toHaveLength(20);

    fireEvent.change(offerInput(), { target: { value: '21' } });
    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(offerHint().textContent).toContain('No more than 20 offers.');
    expect(offerChips()?.querySelectorAll('li')).toHaveLength(20);
  });

  it('50/50 shares for two, recount after removal; the cross and Backspace remove', async () => {
    const mock = renderPage();
    await waitFor(() => expect(domainSelect().value).toBe('1813'), { timeout: 3000 });

    fireEvent.change(offerInput(), { target: { value: '18813,18814' } });
    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    const chips = () => offerChips()!.querySelectorAll('li');
    expect(chips()).toHaveLength(2);
    expect(chips()[0].textContent).toContain('50%');
    expect(chips()[1].textContent).toContain('50%');
    expect(screen.getByText('Weights are equal, sum 100.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove offer 18814' }));
    expect(chips()).toHaveLength(1);
    expect(chips()[0].textContent).toContain('100%');
    expect(screen.queryByText('Weights are equal, sum 100.')).toBeNull();

    // re-adding the removed one: the name comes from the cache
    fireEvent.change(offerInput(), { target: { value: '18814' } });
    await screen.findByText(/Offer 18814: Offer 18814 — active/, {}, { timeout: 3000 });
    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(chips()).toHaveLength(2);
    expect(chips()[1].textContent).toContain('Offer 18814');
    expect(chips()[1].textContent).toContain('50%');
    // there was only one request for 18814 — none on re-adding
    expect(offerCalls(mock, 18814)).toHaveLength(1);

    fireEvent.change(offerInput(), { target: { value: '' } });
    fireEvent.keyDown(offerInput(), { key: 'Backspace' });
    expect(chips()).toHaveLength(1);
  });

  it('re-adding a removed offer — name/status from the cache, no new request', async () => {
    const mock = renderPage();
    await waitFor(() => expect(domainSelect().value).toBe('1813'), { timeout: 3000 });

    fireEvent.change(offerInput(), { target: { value: '18813' } });
    await screen.findByText(/Offer 18813: Test offer — active/, {}, { timeout: 3000 });
    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(offerChips()?.textContent).toContain('Test offer');
    fireEvent.click(screen.getByRole('button', { name: 'Remove offer 18813' }));
    expect(offerChips()).toBeNull();

    // the same ID again: hint from the cache and a chip with the name, no repeated request
    fireEvent.change(offerInput(), { target: { value: '18813' } });
    await screen.findByText(/Offer 18813: Test offer — active/, {}, { timeout: 3000 });
    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    expect(offerChips()?.querySelectorAll('li')).toHaveLength(1);
    expect(offerChips()?.textContent).toContain('Test offer');
    expect(offerChips()?.textContent).toContain('100%');
    await new Promise((r) => setTimeout(r, 700));
    expect(offerCalls(mock, 18813)).toHaveLength(1);
  });

  it('34/33/33 shares for three offers (the remainder goes to the first)', async () => {
    renderPage();
    await waitFor(() => expect(domainSelect().value).toBe('1813'), { timeout: 3000 });

    fireEvent.change(offerInput(), { target: { value: '18813, 18814, 18815' } });
    fireEvent.keyDown(offerInput(), { key: 'Enter' });
    const chips = offerChips()!.querySelectorAll('li');
    expect(chips).toHaveLength(3);
    expect(chips[0].textContent).toContain('34%');
    expect(chips[1].textContent).toContain('33%');
    expect(chips[2].textContent).toContain('33%');
    expect(screen.getByText('Weights are equal, sum 100.')).toBeTruthy();
  });

  it('submit is blocked without offers', async () => {
    renderPage();
    await fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: 'Remove offer 18813' }));
    expect(offerChips()).toBeNull();

    fireEvent.click(submitBtn());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Select at least one offer.');
    expect(postCalls).toHaveLength(0);
  });
});

describe('NewCampaignPage — breadcrumbs', () => {
  it('Home → Campaigns → New campaign; the current one is not a link', async () => {
    renderPage();
    const nav = await screen.findByRole('navigation', { name: 'Breadcrumbs' }, { timeout: 3000 });
    expect(within(nav).getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/');
    expect(within(nav).getByRole('link', { name: 'Campaigns' }).getAttribute('href')).toBe('/campaigns');
    const current = within(nav).getByText('New campaign');
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(within(nav).queryByRole('link', { name: 'New campaign' })).toBeNull();
  });
});

describe('NewCampaignPage — submit', () => {
  it('success: POST with the contract body, a card with ID/alias/link, "Open flows" leads to flows', async () => {
    renderPage();
    await fillValidForm();
    fireEvent.click(submitBtn());

    await screen.findByText('Campaign created', {}, { timeout: 3000 });
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

    fireEvent.click(screen.getByRole('button', { name: 'Open flows' }));
    expect(await screen.findByText('streams-probe', {}, { timeout: 2000 })).toBeTruthy();
  });

  it('double click — one POST; the button is disabled and aria-busy during the request', async () => {
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
    // the button is already disabled and aria-busy
    await waitFor(() => {
      expect(submitBtn().disabled).toBe(true);
      expect(submitBtn().getAttribute('aria-busy')).toBe('true');
    });
    fireEvent.click(submitBtn());
    resolvePost();
    await screen.findByText('Campaign created', {}, { timeout: 3000 });
    expect(postCalls).toHaveLength(1);
  });

  it('422 — the text by the field from detail', async () => {
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

  it('409 — duplicate confirmation, the retry goes with confirm_duplicate=true', async () => {
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
    expect(alert.textContent).toContain('A campaign with this name already exists — create another one?');
    expect(screen.getByRole('link', { name: 'Open existing (ID 777)' })).toBeTruthy();
    expect(postCalls[0].body).toMatchObject({ confirm_duplicate: false });

    fireEvent.click(screen.getByRole('button', { name: 'Create anyway' }));
    await screen.findByText('Campaign created', {}, { timeout: 3000 });
    expect(postCalls[1].body).toMatchObject({ confirm_duplicate: true, name: 'leo_kz', geos: ['KZ'] });
  });

  it('403 — the Keitaro text is shown as is', async () => {
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

  it('502 — "Keitaro is unavailable" with the failure step from detail', async () => {
    renderPage(
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/campaign-options') return json(200, OPTIONS);
        if (url === '/api/campaigns' && init?.method === 'POST') {
          postCalls.push({ url, body: null });
          return json(502, { detail: 'failure at step: offer stream' });
        }
        return json(200, {});
      }),
    );
    await fillValidForm();
    fireEvent.click(submitBtn());
    const alert = await screen.findByRole('alert', {}, { timeout: 3000 });
    expect(alert.textContent).toBe('Keitaro is unavailable: failure at step: offer stream');
  });

  it('network error (fetch reject) — "Network unavailable."', async () => {
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
    expect(alert.textContent).toBe('Network unavailable.');
  });
});
