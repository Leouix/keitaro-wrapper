import type { ReactNode } from 'react';
import s from './Message.module.css';

type Kind = 'error' | 'success' | 'warn' | 'info';

/** Инлайн-сообщение: ошибка, статус, предупреждение, подсказка. */
export function Message({
  kind = 'info',
  className,
  children,
  ...rest
}: {
  kind?: Kind;
  className?: string;
  children: ReactNode;
} & React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={[s.message, s[kind], className ?? ''].filter(Boolean).join(' ')} {...rest}>
      {children}
    </p>
  );
}

/** Строка статуса с точкой-индикатором (успех/ошибка). */
export function StatusLine({
  error = false,
  className,
  children,
  lineRef,
  ...rest
}: {
  error?: boolean;
  className?: string;
  children: ReactNode;
  lineRef?: React.Ref<HTMLParagraphElement>;
} & React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      ref={lineRef}
      className={[s.statusLine, error ? s.statusError : '', className ?? ''].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </p>
  );
}
