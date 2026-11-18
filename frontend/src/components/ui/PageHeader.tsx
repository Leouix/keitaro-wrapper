import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export type Crumb = { label: string; to?: string };

/** Шапка страницы: хлебные крошки, заголовок, строка-метаданные.
 *  Последняя крошка — текущая страница: не ссылка, aria-current="page". */
export function PageHeader({
  crumbs,
  title,
  meta,
}: {
  crumbs: Crumb[];
  title: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="page-head">
      {crumbs.length > 0 && (
        <nav className="breadcrumbs" aria-label="Хлебные крошки">
          <ol>
            {crumbs.map((crumb, i) => {
              const last = i === crumbs.length - 1;
              return (
                <li key={crumb.label}>
                  {last || !crumb.to ? (
                    <span aria-current={last ? 'page' : undefined}>{crumb.label}</span>
                  ) : (
                    <Link to={crumb.to}>{crumb.label}</Link>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      )}
      <h1>{title}</h1>
      {meta}
    </div>
  );
}
