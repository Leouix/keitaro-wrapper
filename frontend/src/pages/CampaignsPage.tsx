import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { acceptJson, detailToText } from '../api/client';
import type { Campaign } from '../api/types';
import { useAbortableRequest } from '../hooks/useAbortableRequest';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { plural } from '../lib/plural';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { Message } from '../components/ui/Message';
import { PageHeader } from '../components/ui/PageHeader';
import { SkeletonRows } from '../components/ui/Skeleton';
import table from '../components/ui/table.module.css';
import s from './CampaignsPage.module.css';

type ErrorState = { text: string; retryable: boolean; needKey: boolean } | null;
type Phase = 'idle' | 'loading' | 'error' | 'empty' | 'ready';

/** Поиск кампаний. Поведение 1:1 с web/app.js initCampaigns(). */
export function CampaignsPage() {
  const [input, setInput] = useState('');
  const [nonce, setNonce] = useState(0);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<ErrorState>(null);
  const [query, setQuery] = useState('');
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const errorRef = useRef<HTMLDivElement>(null);

  // Пауза 300 мс, чтобы не дёргать Keitaro на каждую букву.
  const debounced = useDebouncedValue(input.trim(), 300);
  const { request } = useAbortableRequest();

  useEffect(() => {
    document.title = 'Кампании — Keitaro';
  }, []);

  useEffect(() => {
    // Пустое поле — никаких запросов в сеть и пустая страница.
    if (!debounced) {
      setPhase('idle');
      setError(null);
      setCampaigns([]);
      return;
    }

    let disposed = false;

    (async () => {
      setPhase('loading');
      setError(null);
      const { result, stale } = await request<{ campaigns?: Campaign[] }>(
        `/api/campaigns?query=${encodeURIComponent(debounced)}`,
        { headers: acceptJson },
      );
      // Ответ на устаревший (или отменённый) запрос — молча выбрасываем.
      if (stale || disposed) return;

      const { status, body } = result;
      if (status !== 200 || !body || !Array.isArray(body.campaigns)) {
        if (status === 409) {
          setError({ text: 'Сначала укажите API key.', retryable: false, needKey: true });
        } else if (status === 502) {
          setError({ text: 'Keitaro недоступен.', retryable: true, needKey: false });
        } else if (status === 0) {
          setError({ text: 'Сеть недоступна.', retryable: true, needKey: false });
        } else {
          setError({
            text: detailToText((body as { detail?: unknown } | null)?.detail, `Ошибка загрузки (код ${status}).`),
            retryable: true,
            needKey: false,
          });
        }
        setPhase('error');
        return;
      }

      setQuery(debounced);
      if (!body.campaigns.length) {
        setCampaigns([]);
        setPhase('empty');
        return;
      }
      setCampaigns(body.campaigns);
      setPhase('ready');
    })();

    return () => {
      disposed = true;
    };
  }, [debounced, nonce, request]);

  // Фокус уходит на блок ошибки при её появлении.
  useEffect(() => {
    if (phase === 'error') errorRef.current?.focus();
  }, [phase, error]);

  const n = campaigns.length;

  return (
    <div className="page">
      <section className="card">
        <PageHeader
          back={{ to: '/', children: '← На главную' }}
          title="Кампании"
          meta={
            <Link to="/campaigns/new" className="link">
              Создать кампанию
            </Link>
          }
        />
        <div className={s.filterRow}>
          <label className={s.label} htmlFor="campaign-query">
            Поиск по названию кампании
          </label>
          <input
            id="campaign-query"
            type="search"
            className={s.search}
            autoComplete="off"
            spellCheck={false}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>

        {phase === 'loading' && (
          <div aria-busy="true">
            <p className="sr-only" role="status">
              Ищем кампании…
            </p>
            <SkeletonRows rows={4} />
          </div>
        )}

        {phase === 'idle' && (
          <EmptyState title="Начните вводить название кампании">
            Поиск выполняется в Keitaro по подстроке названия.
          </EmptyState>
        )}

        {phase === 'error' && error && (
          <div ref={errorRef} role="alert" tabIndex={-1} className={s.errorBlock}>
            <Message kind="error" className={s.errorMsg}>
              {error.text}
            </Message>
            <div className={s.errorActions}>
              {error.needKey && (
                <Link to="/" className="link">
                  Указать API key на главной
                </Link>
              )}
              {error.retryable && (
                <Button size="md" onClick={() => setNonce((x) => x + 1)}>
                  Повторить
                </Button>
              )}
            </div>
          </div>
        )}

        {phase === 'empty' && (
          <Message kind="info">Ничего не найдено по «{query}».</Message>
        )}

        {phase === 'ready' && (
          <div>
            <p className="counter" role="status">
              Найдено: {n} {plural(n, 'кампания', 'кампании', 'кампаний')}
            </p>
            <div className={table.wrap}>
              <table className={table.table}>
                <thead>
                  <tr>
                    <th scope="col" className={table.num}>
                      ID
                    </th>
                    <th scope="col">Кампания</th>
                    <th scope="col">Группа</th>
                    <th scope="col">Статус</th>
                    <th scope="col">Обновлена</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.id}>
                      <td className={table.num} data-label="ID">
                        {c.id}
                      </td>
                      <td className="wrap-anywhere" data-label="Кампания">
                        <Link
                          to={`/fb/campaigns/${c.id}/streams`}
                          className={table.rowLink}
                        >
                          {c.name || `Кампания ${c.id}`}
                        </Link>
                        {c.alias ? <span className={table.alias}>{c.alias}</span> : null}
                      </td>
                      <td className="wrap-anywhere" data-label="Группа">
                        {c.group || '—'}
                      </td>
                      <td data-label="Статус">{c.state || '—'}</td>
                      <td data-label="Обновлена">{c.updated_at || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
