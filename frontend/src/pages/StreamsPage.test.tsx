import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { StreamsPage } from './StreamsPage';

describe('StreamsPage — route', () => {
  it('a non-numeric id → a clear error, no requests', () => {
    render(
      <MemoryRouter initialEntries={['/fb/campaigns/not-a-number/streams']}>
        <Routes>
          <Route path="/fb/campaigns/:id/streams" element={<StreamsPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(
      screen.getByText('Invalid URL: the campaign ID must be a number.'),
    ).toBeTruthy();
  });

  it('breadcrumbs: Home → Campaigns → Flows; the current one is not a link', () => {
    render(
      <MemoryRouter initialEntries={['/fb/campaigns/not-a-number/streams']}>
        <Routes>
          <Route path="/fb/campaigns/:id/streams" element={<StreamsPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const nav = screen.getByRole('navigation', { name: 'Breadcrumbs' });
    expect(within(nav).getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/');
    expect(within(nav).getByRole('link', { name: 'Campaigns' }).getAttribute('href')).toBe(
      '/campaigns',
    );
    const current = within(nav).getByText('Flows');
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(within(nav).queryByRole('link', { name: 'Flows' })).toBeNull();
  });
});
