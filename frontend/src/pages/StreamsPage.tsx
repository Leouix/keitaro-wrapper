import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Message } from '../components/ui/Message';
import { PageHeader } from '../components/ui/PageHeader';
import { StreamsContent } from '../features/streams/StreamsContent';

/** Маршрут /fb/campaigns/:id/streams; нечисловой id — внятная ошибка. */
export function StreamsPage() {
  const { id } = useParams<{ id: string }>();
  const valid = id != null && /^\d+$/.test(id);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!valid) {
      document.title = 'Потоки кампании — Keitaro';
      errorRef.current?.focus();
    }
  }, [valid]);

  if (!valid) {
    return (
      <div className="page">
        <section className="card">
          <PageHeader
            back={{ to: '/campaigns', children: '← К списку кампаний' }}
            title="Потоки кампании"
          />
          <div ref={errorRef} role="alert" tabIndex={-1}>
            <Message kind="error">Некорректный адрес: ID кампании должен быть числом.</Message>
          </div>
        </section>
      </div>
    );
  }

  return <StreamsContent campaignId={id} />;
}
