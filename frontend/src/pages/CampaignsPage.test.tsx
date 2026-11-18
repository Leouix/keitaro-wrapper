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
  it('пустой запрос — ни одного сетевого запроса', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderCampaigns();
    // пережидаем дольше debounce: пустое поле не должно породить запросов
    await new Promise((r) => setTimeout(r, 700));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('запрос уходит после паузы 300 мс, не на каждую букву', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith('/api/campaigns')
        ? json(200, { campaigns: [{ id: 5, name: 'Кампания пять', group: 'g', state: 'active', updated_at: 'd' }] })
        : json(200, {}),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderCampaigns();

    fireEvent.change(input(), { target: { value: 'тест' } });
    expect(fetchMock).not.toHaveBeenCalled();

    const link = await screen.findByRole('link', { name: 'Кампания пять' }, { timeout: 3000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/campaigns?query=' + encodeURIComponent('тест'));
    expect(link.getAttribute('href')).toBe('/fb/campaigns/5/streams');
    // счётчик с русским склонением
    expect(screen.getByText('Найдено: 1 кампания')).toBeTruthy();
  });

  it('очистка поля — страница возвращается в пустое состояние без запросов', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith('/api/campaigns') ? json(200, { campaigns: [{ id: 1, name: 'a' }] }) : json(200, {}),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderCampaigns();

    fireEvent.change(input(), { target: { value: 'ab' } });
    await screen.findByText('Найдено: 1 кампания', {}, { timeout: 3000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.change(input(), { target: { value: '' } });
    await screen.findByText('Начните вводить название кампании', {}, { timeout: 3000 });
    // даём debounce'у шанс породить лишний запрос — его нет
    await new Promise((r) => setTimeout(r, 700));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('502 → «Keitaro недоступен.» и кнопка «Повторить»', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(502, null)));
    renderCampaigns();

    fireEvent.change(input(), { target: { value: 'x' } });
    const alert = await screen.findByRole('alert', {}, { timeout: 3000 });
    expect(alert.querySelector('p')?.textContent).toBe('Keitaro недоступен.');
    expect(screen.getByText('Повторить')).toBeTruthy();
  });

  it('пустой результат → «Ничего не найдено по «x».»', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { campaigns: [] })));
    renderCampaigns();

    fireEvent.change(input(), { target: { value: 'x' } });
    expect(await screen.findByText('Ничего не найдено по «x».')).toBeTruthy();
  });

  it('409 → «Сначала укажите API key.» и ссылка на главную', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(409, null)));
    renderCampaigns();

    fireEvent.change(input(), { target: { value: 'x' } });
    const alert = await screen.findByRole('alert', {}, { timeout: 3000 });
    expect(alert.querySelector('p')?.textContent).toBe('Сначала укажите API key.');
    expect(screen.getByText('Указать API key на главной')).toBeTruthy();
  });

  it('хлебные крошки: Главная → Кампании, текущая — не ссылка', () => {
    vi.stubGlobal('fetch', vi.fn());
    renderCampaigns();

    const nav = screen.getByRole('navigation', { name: 'Хлебные крошки' });
    const home = within(nav).getByRole('link', { name: 'Главная' });
    expect(home.getAttribute('href')).toBe('/');
    expect(within(nav).queryByRole('link', { name: 'Кампании' })).toBeNull();
    const current = within(nav).getByText('Кампании');
    expect(current.getAttribute('aria-current')).toBe('page');
  });
});
