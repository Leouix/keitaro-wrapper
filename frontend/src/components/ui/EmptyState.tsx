import type { ReactNode } from 'react';
import s from './EmptyState.module.css';

/** Пустое состояние: иконка, заголовок, пояснение. */
export function EmptyState({
  title,
  children,
}: {
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={s.empty}>
      <svg className={s.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 10h18" />
      </svg>
      <p className={s.title}>{title}</p>
      {children && <p className={s.text}>{children}</p>}
    </div>
  );
}
