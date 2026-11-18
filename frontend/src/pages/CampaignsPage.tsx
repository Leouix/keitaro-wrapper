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
    document.title = 'Campaigns — Keitaro';
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
          setError({ text: 'Set the API key first.', retryable: false, needKey: true });
        } else if (status === 502) {
          setError({ text: 'Keitaro is unavailable.', retryable: true, needKey: false });
        } else if (status === 0) {
          setError({ text: 'Network unavailable.', retryable: true, needKey: false });
        } else {
          setError({
            text: detailToText((body as { detail?: unknown } | null)?.detail, `Failed to load (status ${status}).`),
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
          crumbs={[
            { label: 'Home', to: '/' },
            { label: 'Campaigns' },
          ]}
          title="Campaigns"
          meta={
            <Link to="/campaigns/new" className="link">
              Create campaign
            </Link>
          }
        />
        <div className={s.filterRow}>
          <label className={s.label} htmlFor="campaign-query">
            Search by campaign name
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
              Searching campaigns…
            </p>
            <SkeletonRows rows={4} />
          </div>
        )}

        {phase === 'idle' && (
          <EmptyState title="Start typing a campaign name">
            Search runs in Keitaro against a substring of the name.
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
                  Set the API key on the home page
                </Link>
              )}
              {error.retryable && (
                <Button size="md" onClick={() => setNonce((x) => x + 1)}>
                  Retry
                </Button>
              )}
            </div>
          </div>
        )}

        {phase === 'empty' && (
          <Message kind="info">Nothing found for "{query}".</Message>
        )}

        {phase === 'ready' && (
          <div>
            <p className="counter" role="status">
              Found: {n} {plural(n, 'campaign', 'campaigns')}
            </p>
            <div className={table.wrap}>
              <table className={table.table}>
                <thead>
                  <tr>
                    <th scope="col" className={table.num}>
                      ID
                    </th>
                    <th scope="col">Campaign</th>
                    <th scope="col">Group</th>
                    <th scope="col">Status</th>
                    <th scope="col">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.id}>
                      <td className={table.num} data-label="ID">
                        {c.id}
                      </td>
                      <td className="wrap-anywhere" data-label="Campaign">
                        <Link
                          to={`/fb/campaigns/${c.id}/streams`}
                          className={table.rowLink}
                        >
                          {c.name || `Campaign ${c.id}`}
                        </Link>
                        {c.alias ? <span className={table.alias}>{c.alias}</span> : null}
                      </td>
                      <td className="wrap-anywhere" data-label="Group">
                        {c.group || '—'}
                      </td>
                      <td data-label="Status">{c.state || '—'}</td>
                      <td data-label="Updated">{c.updated_at || '—'}</td>
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
