import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import s from './Button.module.css';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
  buttonRef?: Ref<HTMLButtonElement>;
}

/**
 * primary — одна главная кнопка страницы (Далее, Отправить в Кейтаро);
 * secondary — обычная; ghost — тихая опасная кнопка в таблице («Удалить»);
 * danger — filled красная («Всё равно отправить»).
 */
export function Button({ variant = 'secondary', size = 'md', className, children, buttonRef, ...rest }: Props) {
  const cls = [s.button, s[variant], size === 'sm' ? s.sm : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={cls} ref={buttonRef} {...rest}>
      {children}
    </button>
  );
}
