import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { StreamsPage } from './StreamsPage';

describe('StreamsPage — маршрут', () => {
  it('нечисловой id → внятная ошибка, без запросов', () => {
    render(
      <MemoryRouter initialEntries={['/fb/campaigns/not-a-number/streams']}>
        <Routes>
          <Route path="/fb/campaigns/:id/streams" element={<StreamsPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(
      screen.getByText('Некорректный адрес: ID кампании должен быть числом.'),
    ).toBeTruthy();
  });

  it('хлебные крошки: Главная → Кампании → Потоки; текущая — не ссылка', () => {
    render(
      <MemoryRouter initialEntries={['/fb/campaigns/not-a-number/streams']}>
        <Routes>
          <Route path="/fb/campaigns/:id/streams" element={<StreamsPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const nav = screen.getByRole('navigation', { name: 'Хлебные крошки' });
    expect(within(nav).getByRole('link', { name: 'Главная' }).getAttribute('href')).toBe('/');
    expect(within(nav).getByRole('link', { name: 'Кампании' }).getAttribute('href')).toBe(
      '/campaigns',
    );
    const current = within(nav).getByText('Потоки');
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(within(nav).queryByRole('link', { name: 'Потоки' })).toBeNull();
  });
});
