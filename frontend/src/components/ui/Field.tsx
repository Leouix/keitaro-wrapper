import { useState } from 'react';
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
  /** Полю type="password" добавить кнопку-глаз: переключает password ↔ text. */
  passwordToggle?: boolean;
  /** aria-label кнопки в обоих состояниях. */
  revealLabelShow?: string;
  revealLabelHide?: string;
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
  passwordToggle = false,
  revealLabelShow = 'Показать ключ',
  revealLabelHide = 'Скрыть ключ',
  type,
  ...rest
}: Props) {
  const [revealed, setRevealed] = useState(false);
  const hintCls = [s.hint, hintKind === 'found' ? s.hintFound : '', hintKind === 'error' ? s.hintError : '']
    .filter(Boolean)
    .join(' ');
  const toggleVisible = passwordToggle && type === 'password';
  const inputType = toggleVisible && revealed ? 'text' : type;
  const input = (
    <input
      id={id}
      ref={inputRef}
      className={toggleVisible ? `${s.input} ${s.inputWithToggle}` : s.input}
      type={inputType}
      aria-describedby={hintId}
      {...rest}
    />
  );
  return (
    <div className={[s.field, wrapClassName ?? ''].filter(Boolean).join(' ')}>
      <label className={s.label} htmlFor={id}>
        {label}
      </label>
      {toggleVisible ? (
        <div className={s.inputWrap}>
          {input}
          <button
            type="button"
            className={s.revealBtn}
            aria-label={revealed ? revealLabelHide : revealLabelShow}
            aria-pressed={revealed}
            title={revealed ? revealLabelHide : revealLabelShow}
            onClick={() => setRevealed((v) => !v)}
          >
            {revealed ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>
      ) : (
        input
      )}
      {hintId && (
        <p id={hintId} className={hintCls} role="status" aria-live="polite">
          {hint}
        </p>
      )}
    </div>
  );
}

/* Инлайн-SVG, без новых зависимостей; stroke=currentColor — цвет ведёт CSS. */

function EyeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M1 12s4-7.5 11-7.5S23 12 23 12s-4 7.5-11 7.5S1 12 1 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <path d="M1 1l22 22" />
    </svg>
  );
}
