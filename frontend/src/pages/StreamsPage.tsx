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
      document.title = 'Campaign flows — Keitaro';
      errorRef.current?.focus();
    }
  }, [valid]);

  if (!valid) {
    return (
      <div className="page">
        <section className="card">
          <PageHeader
            crumbs={[
              { label: 'Home', to: '/' },
              { label: 'Campaigns', to: '/campaigns' },
              { label: 'Flows' },
            ]}
            title="Campaign flows"
          />
          <div ref={errorRef} role="alert" tabIndex={-1}>
            <Message kind="error">Invalid URL: the campaign ID must be a number.</Message>
          </div>
        </section>
      </div>
    );
  }

  return <StreamsContent campaignId={id} />;
}
