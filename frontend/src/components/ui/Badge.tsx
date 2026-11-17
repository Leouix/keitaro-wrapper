import type { ReactNode } from 'react';
import s from './Badge.module.css';

type Kind = 'pending' | 'archived';

/** Бейдж состояния строки: «к удалению», «черновик», «в архиве», «удалён в Keitaro». */
export function Badge({ kind, children }: { kind: Kind; children: ReactNode }) {
  return <span className={kind === 'pending' ? s.pending : s.archived}>{children}</span>;
}
