import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { detailToText, jsonHeaders, requestJson, acceptJson } from '../api/client';
import type { SettingsInfo } from '../api/types';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { Message, StatusLine } from '../components/ui/Message';
import s from './HomePage.module.css';

/** Главная: ввод API key. Поведение 1:1 с web/app.js initHome(). */
export function HomePage() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const aliveRef = useRef(true);

  const [value, setValue] = useState('');
  const [configured, setConfigured] = useState(false);
  const [mask, setMask] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Keitaro — API key';
    aliveRef.current = true;
    (async () => {
      const { ok, body } = await requestJson<SettingsInfo>('/api/settings', {
        headers: acceptJson,
      });
      if (aliveRef.current && ok && body?.configured) {
        setConfigured(true);
        setMask(body.key_masked ?? null);
      }
    })();
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Пустое поле при ненастроенном ключе → кнопка неактивна.
  // Пустое поле при настроенном ключе → кнопка активна, просто ведёт на /campaigns.
  const disabled = value.trim() === '' && !configured;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const apiKey = value.trim();

    if (!apiKey) {
      // Ключ уже настроен — просто идём к списку кампаний.
      if (configured) navigate('/campaigns');
      return;
    }

    setBusy(true);
    setError(null);

    const { status, body } = await requestJson<SettingsInfo>('/api/settings/api-key', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ api_key: apiKey }),
    });

    if (!aliveRef.current) return;

    if (status === 200 && body?.configured) {
      // Успех: сразу к списку кампаний.
      navigate('/campaigns');
      return;
    }

    const fallback =
      status === 400 ? 'Ключ отклонён Keitaro, проверьте его значение.' :
      status === 409 ? 'Ключ не сохранён, попробуйте ещё раз.' :
      status === 422 ? 'Ключ слишком короткий или в неверном формате.' :
      status === 502 ? 'Keitaro недоступен, попробуйте позже.' :
      status === 0 ? 'Сеть недоступна, попробуйте ещё раз.' :
      detailToText((body as { detail?: unknown } | null)?.detail, `Не удалось сохранить ключ (код ${status}).`);
    setError(fallback);
    setBusy(false);
    inputRef.current?.focus();
  }

  return (
    <div className="page">
      <section className={`card ${s.card}`}>
        <h1>Keitaro — потоки кампаний</h1>

        {configured && (
          <StatusLine className={s.status}>
            Ключ настроен{mask ? `: ${mask}` : ''}
          </StatusLine>
        )}

        <form onSubmit={onSubmit} noValidate>
          <Field
            id="api-key"
            label="Укажите свой API key"
            type="password"
            name="api_key"
            autoComplete="off"
            spellCheck={false}
            aria-busy={busy || undefined}
            aria-invalid={error ? true : undefined}
            inputRef={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            wrapClassName={s.field}
          />
          <Button
            type="submit"
            variant="primary"
            disabled={disabled || busy}
            aria-busy={busy || undefined}
          >
            {busy ? 'Сохраняем…' : 'Далее'}
          </Button>
        </form>

        {error && (
          <Message kind="error" role="alert" className={s.error}>
            {error}
          </Message>
        )}
      </section>
    </div>
  );
}
