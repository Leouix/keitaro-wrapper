import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import s from './AppShell.module.css';

/** Каркас: верхняя панель с названием и путём, контент до 1120px. */
export function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  let path = '';
  if (pathname.startsWith('/fb/campaigns/')) path = 'Кампании / Потоки';
  else if (pathname.startsWith('/campaigns')) path = 'Кампании';
  return (
    <div className={s.shell}>
      <header className={s.topbar}>
        <Link to="/" className={s.brand}>
          Keitaro
        </Link>
        {path && (
          <span className={s.path} aria-label="Раздел">
            {path}
          </span>
        )}
      </header>
      <main className={s.content}>{children}</main>
    </div>
  );
}
