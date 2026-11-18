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
  it('пустое поле и ненастроенный ключ → кнопка disabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/settings' ? json(200, { configured: false }) : json(200, {}),
      ),
    );
    renderHome();
    const btn = screen.getByRole('button', { name: 'Далее' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });

  it('ключ настроен → статус-строка и кнопка активна', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/settings' ? json(200, { configured: true, key_masked: '1234' }) : json(200, {}),
      ),
    );
    renderHome();
    const btn = screen.getByRole('button', { name: 'Далее' }) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    expect(screen.getByText(/Ключ настроен/).textContent).toContain('1234');
  });

  it('ввод ключа активирует кнопку; 422 показывается текстом, фокус на поле', async () => {
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
    const btn = screen.getByRole('button', { name: 'Далее' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    fireEvent.click(btn);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Ключ слишком короткий или в неверном формате');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(input);
    expect(btn.textContent).toBe('Далее');
    // введённое значение не стирается
    expect(input.value).toBe('short');
    void container;
  });

  it('успешный POST и пустое поле при настроенном ключе ведут на /campaigns/new', async () => {
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
          <Route path="/campaigns/new" element={<div>campaigns-new-probe</div>} />
        </Routes>
      </MemoryRouter>,
    );
    const btn = await waitFor(() => {
      const el = screen.getByRole('button', { name: 'Далее' }) as HTMLButtonElement;
      if (el.disabled) throw new Error('not yet enabled');
      return el;
    });
    // нечисловой путь не нужен: пустое поле + configured → кнопка ведёт на /campaigns/new
    fireEvent.click(btn);
    expect(await screen.findByText('campaigns-new-probe', {}, { timeout: 2000 })).toBeTruthy();
    // POST не уходил: settings GET был единственным запросом
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('502 → «Keitaro недоступен, попробуйте позже.»', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Keitaro недоступен, попробуйте позже.');
  });
});

describe('HomePage — глаз в поле ключа', () => {
  it('кнопка-глаз переключает type password ↔ text, aria-pressed и aria-label меняются; type="button" не сабмитит форму', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/settings' ? json(200, { configured: false }) : json(200, {}),
      ),
    );
    renderHome();

    const input = document.getElementById('api-key') as HTMLInputElement;
    await waitFor(() => expect(input.type).toBe('password'));

    const eye = screen.getByRole('button', { name: 'Показать ключ' }) as HTMLButtonElement;
    expect(eye.type).toBe('button'); // не перехватывает сабмит формы
    expect(eye.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(eye);
    expect(input.type).toBe('text');
    const shown = screen.getByRole('button', { name: 'Скрыть ключ' }) as HTMLButtonElement;
    expect(shown.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(shown);
    expect(input.type).toBe('password');
    expect(screen.getByRole('button', { name: 'Показать ключ' })).toBeTruthy();
  });
});
