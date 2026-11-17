import type { InputHTMLAttributes, ReactNode, Ref } from 'react';
import s from './Field.module.css';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label: ReactNode;
  /** id нужен для htmlFor; обязательный — задай явно. */
  id: string;
  hint?: ReactNode;
  hintId?: string;
  /** Тон подсказки: found — успех, error — ошибка. */
  hintKind?: '' | 'found' | 'error';
  wrapClassName?: string;
  inputRef?: Ref<HTMLInputElement>;
}

/** Подпись + поле + необязательная живая подсказка (role=status, aria-live=polite). */
export function Field({
  label,
  id,
  hint,
  hintId,
  hintKind = '',
  wrapClassName,
  inputRef,
  ...rest
}: Props) {
  const hintCls = [s.hint, hintKind === 'found' ? s.hintFound : '', hintKind === 'error' ? s.hintError : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={[s.field, wrapClassName ?? ''].filter(Boolean).join(' ')}>
      <label className={s.label} htmlFor={id}>
        {label}
      </label>
      <input id={id} ref={inputRef} className={s.input} aria-describedby={hintId} {...rest} />
      {hintId && (
        <p id={hintId} className={hintCls} role="status" aria-live="polite">
          {hint}
        </p>
      )}
    </div>
  );
}
