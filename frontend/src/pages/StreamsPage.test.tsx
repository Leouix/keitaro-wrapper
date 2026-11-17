import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
