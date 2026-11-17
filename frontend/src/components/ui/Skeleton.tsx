import s from './Skeleton.module.css';

/** Заглушка на время загрузки: строка-скелет высотой h px. */
export function Skeleton({ h = 16, className }: { h?: number; className?: string }) {
  return <div className={[s.skeleton, className ?? ''].filter(Boolean).join(' ')} style={{ height: h }} aria-hidden="true" />;
}

/** Несколько строк-скелетов. */
export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className={s.stack}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} h={36} />
      ))}
    </div>
  );
}
