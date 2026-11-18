import { describe, expect, it, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CampaignsPage } from './CampaignsPage';

const json = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

function renderCampaigns() {
  return render(
    <MemoryRouter>
      <CampaignsPage />
    </MemoryRouter>,
  );
}

const input = () => document.getElementById('campaign-query') as HTMLInputElement;

// Реальные таймеры: debounce 300 мс пережидаем через findBy* с таймаутом.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CampaignsPage', () => {
  it('empty query — no network requests', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderCampaigns();
    // пережидаем дольше debounce: пустое поле не должно породить запросов
    await new Promise((r) => setTimeout(r, 700));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the request fires after the 300 ms pause, not on every keystroke', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith('/api/campaigns')
        ? json(200, { campaigns: [{ id: 5, name: 'Campaign five', group: 'g', state: 'active', updated_at: 'd' }] })
        : json(200, {}),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderCampaigns();

    fireEvent.change(input(), { target: { value: 'test' } });
    expect(fetchMock).not.toHaveBeenCalled();

    const link = await screen.findByRole('link', { name: 'Campaign five' }, { timeout: 3000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/campaigns?query=' + encodeURIComponent('test'));
    expect(link.getAttribute('href')).toBe('/fb/campaigns/5/streams');
    // counter with the English plural form
    expect(screen.getByText('Found: 1 campaign')).toBeTruthy();
  });

  it('clearing the field returns the page to the empty state without requests', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith('/api/campaigns') ? json(200, { campaigns: [{ id: 1, name: 'a' }] }) : json(200, {}),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderCampaigns();

    fireEvent.change(input(), { target: { value: 'ab' } });
    await screen.findByText('Found: 1 campaign', {}, { timeout: 3000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.change(input(), { target: { value: '' } });
    await screen.findByText('Start typing a campaign name', {}, { timeout: 3000 });
    // даём debounce'у шанс породить лишний запрос — его нет
    await new Promise((r) => setTimeout(r, 700));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('502 → "Keitaro is unavailable." with a "Retry" button', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(502, null)));
    renderCampaigns();

    fireEvent.change(input(), { target: { value: 'x' } });
    const alert = await screen.findByRole('alert', {}, { timeout: 3000 });
    expect(alert.querySelector('p')?.textContent).toBe('Keitaro is unavailable.');
    expect(screen.getByText('Retry')).toBeTruthy();
  });

  it('empty result → "Nothing found for "x"."', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { campaigns: [] })));
    renderCampaigns();

    fireEvent.change(input(), { target: { value: 'x' } });
    expect(await screen.findByText('Nothing found for "x".')).toBeTruthy();
  });

  it('409 → "Set the API key first." with a link to the home page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(409, null)));
    renderCampaigns();

    fireEvent.change(input(), { target: { value: 'x' } });
    const alert = await screen.findByRole('alert', {}, { timeout: 3000 });
    expect(alert.querySelector('p')?.textContent).toBe('Set the API key first.');
    expect(screen.getByText('Set the API key on the home page')).toBeTruthy();
  });

  it('breadcrumbs: Home → Campaigns, the current one is not a link', () => {
    vi.stubGlobal('fetch', vi.fn());
    renderCampaigns();

    const nav = screen.getByRole('navigation', { name: 'Breadcrumbs' });
    const home = within(nav).getByRole('link', { name: 'Home' });
    expect(home.getAttribute('href')).toBe('/');
    expect(within(nav).queryByRole('link', { name: 'Campaigns' })).toBeNull();
    const current = within(nav).getByText('Campaigns');
    expect(current.getAttribute('aria-current')).toBe('page');
  });
});
