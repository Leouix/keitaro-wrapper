import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/** Шапка страницы: обратная ссылка, заголовок, строка-метаданные. */
export function PageHeader({
  back,
  title,
  meta,
}: {
  back: { to: string; children: ReactNode } | null;
  title: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="page-head">
      {back && (
        <Link to={back.to} className="back-link">
          {back.children}
        </Link>
      )}
      <h1>{title}</h1>
      {meta}
    </div>
  );
}
