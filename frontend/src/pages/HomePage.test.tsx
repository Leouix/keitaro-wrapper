import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { HomePage } from './HomePage';

const json = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

function renderHome() {
  return render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  document.title = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HomePage', () => {
  it('empty field and unconfigured key → button disabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/settings' ? json(200, { configured: false }) : json(200, {}),
      ),
    );
    renderHome();
    const btn = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });

  it('key configured → status line and button enabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/settings' ? json(200, { configured: true, key_masked: '1234' }) : json(200, {}),
      ),
    );
    renderHome();
    const btn = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    expect(screen.getByText(/API key configured/).textContent).toContain('1234');
  });

  it('entering the key enables the button; 422 is shown as text, focus on the field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/settings') return json(200, { configured: false });
        if (url === '/api/settings/api-key')
          return json(422, { detail: [{ msg: 'Key too short' }] });
        return json(200, {});
      }),
    );
    const { container } = renderHome();
    const input = document.getElementById('api-key') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'short' } });
    const btn = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    fireEvent.click(btn);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The key is too short or in an invalid format');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(input);
    expect(btn.textContent).toBe('Continue');
    // введённое значение не стирается
    expect(input.value).toBe('short');
    void container;
  });

  it('successful POST and an empty field with a configured key lead to /campaigns', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/settings') return json(200, { configured: true, key_masked: '9' });
        if (url === '/api/settings/api-key') return json(200, { configured: true });
        return json(200, {});
      }),
    );
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/campaigns" element={<div>campaigns-probe</div>} />
        </Routes>
      </MemoryRouter>,
    );
    const btn = await waitFor(() => {
      const el = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
      if (el.disabled) throw new Error('not yet enabled');
      return el;
    });
    // пустое поле + configured → кнопка ведёт на /campaigns (легаси-поведение)
    fireEvent.click(btn);
    expect(await screen.findByText('campaigns-probe', {}, { timeout: 2000 })).toBeTruthy();
    // POST не уходил: settings GET был единственным запросом
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('key configured: only the key field and "Continue" on the home page — no section entries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/settings' ? json(200, { configured: true, key_masked: '9' }) : json(200, {}),
      ),
    );
    renderHome();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/API key configured/)).toBeTruthy();
    expect(screen.queryByText('Find campaign')).toBeNull();
    expect(screen.queryByText('Create campaign')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('key not configured: no "Find campaign"/"Create campaign" entries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/settings' ? json(200, { configured: false }) : json(200, {}),
      ),
    );
    renderHome();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Find campaign')).toBeNull();
    expect(screen.queryByText('Create campaign')).toBeNull();
  });

  it('502 → "Keitaro is unavailable — try again later."', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/settings') return json(200, { configured: false });
        if (url === '/api/settings/api-key') return json(502, null);
        return json(200, {});
      }),
    );
    renderHome();
    fireEvent.change(document.getElementById('api-key') as HTMLInputElement, {
      target: { value: 'key-value' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Keitaro is unavailable — try again later.');
  });
});

describe('HomePage — the eye button in the key field', () => {
  it('the eye button toggles password ↔ text, aria-pressed and aria-label change; type="button" does not submit the form', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/settings' ? json(200, { configured: false }) : json(200, {}),
      ),
    );
    renderHome();

    const input = document.getElementById('api-key') as HTMLInputElement;
    await waitFor(() => expect(input.type).toBe('password'));

    const eye = screen.getByRole('button', { name: 'Show key' }) as HTMLButtonElement;
    expect(eye.type).toBe('button'); // не перехватывает сабмит формы
    expect(eye.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(eye);
    expect(input.type).toBe('text');
    const shown = screen.getByRole('button', { name: 'Hide key' }) as HTMLButtonElement;
    expect(shown.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(shown);
    expect(input.type).toBe('password');
    expect(screen.getByRole('button', { name: 'Show key' })).toBeTruthy();
  });
});
