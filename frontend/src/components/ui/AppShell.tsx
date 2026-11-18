import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import s from './AppShell.module.css';

/** Каркас: верхняя панель с брендом-ссылкой, контент до 1120px. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className={s.shell}>
      <header className={s.topbar}>
        <Link to="/" className={s.brand}>
          Keitaro
        </Link>
      </header>
      <main className={s.content}>{children}</main>
    </div>
  );
}
