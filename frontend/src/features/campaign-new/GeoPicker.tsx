import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { COUNTRIES, countryName, findCountry, parseCountryCodes } from '../../lib/countries';
import s from './GeoPicker.module.css';

interface Props {
  selected: string[];
  onChange: (codes: string[]) => void;
  /** id поля — для htmlFor снаружи. */
  id: string;
  hintId?: string;
  /** Текст ошибки (минимум одна страна, неизвестный код и т.п.). */
  error?: string | null;
  max: number;
}

const MAX_SUGGESTIONS = 8;

/**
 * Мультивыбор стран: комбо-бокс с подсказками (ISO-2 + русские названия),
 * выбранные страны — чипы с кнопкой удаления. Ввод: 'KZ', 'казахстан',
 * список 'KZ,UZ'. Минимум одна и максимум max стран проверяет страница.
 */
export function GeoPicker({ selected, onChange, id, hintId, error, max }: Props) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [localError, setLocalError] = useState<string | null>(null);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return COUNTRIES.filter(
      (c) =>
        !selectedSet.has(c.code) &&
        (c.code.toLowerCase().startsWith(q) || c.name.toLowerCase().includes(q)),
    ).slice(0, MAX_SUGGESTIONS);
  }, [query, selectedSet]);

  useEffect(() => {
    setActive(suggestions.length ? 0 : -1);
  }, [suggestions]);

  useEffect(() => {
    if (localError && error) setLocalError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  function addRaw(raw: string) {
    const codes = parseCountryCodes(raw);
    if (!codes.length) return;
    const unknown = codes.find((code) => !findCountry(code));
    if (unknown) {
      setLocalError(`Неизвестный код страны: ${unknown}. Введите ISO-код, например KZ, или название.`);
      return;
    }
    const fresh: string[] = [];
    for (const code of codes) {
      if (!selectedSet.has(code)) fresh.push(code);
    }
    const room = max - selected.length;
    if (fresh.length > room) {
      setLocalError(`Не больше ${max} стран.`);
      fresh.length = Math.max(room, 0);
    }
    if (fresh.length) {
      onChange([...selected, ...fresh]);
      setLocalError(null);
    }
    setQuery('');
    setOpen(false);
  }

  function remove(code: string) {
    onChange(selected.filter((c) => c !== code));
    setLocalError(null);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open && suggestions.length) setOpen(true);
      else if (open) setActive((a) => Math.min(a + 1, suggestions.length - 1));
      else if (suggestions.length) setOpen(true);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      // Комбо-бокс в форме: Enter выбирает подсказку или добавляет введённое,
      // но не сабмитит форму.
      e.preventDefault();
      if (open && active >= 0 && suggestions[active]) {
        addRaw(suggestions[active].code);
      } else {
        addRaw(query);
      }
      return;
    }
    if (e.key === ',') {
      e.preventDefault();
      addRaw(query);
      return;
    }
    if (e.key === 'Escape') {
      setOpen(false);
      setActive(-1);
      return;
    }
    if (e.key === 'Backspace' && !query && selected.length) {
      remove(selected[selected.length - 1]);
    }
  }

  const full = selected.length >= max;
  const shownError = localError ?? error ?? null;

  return (
    <div className={s.wrap}>
      {selected.length > 0 && (
        <ul className={s.chips} aria-label="Выбранные страны">
          {selected.map((code) => (
            <li key={code} className={s.chip}>
              <span className={s.chipCode}>{code}</span>
              <span className={s.chipName}>{countryName(code)}</span>
              <button
                type="button"
                className={s.chipRemove}
                aria-label={`Убрать ${code} — ${countryName(code)}`}
                onClick={() => remove(code)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={s.combo}>
        <input
          id={id}
          ref={inputRef}
          className={s.input}
          type="text"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          placeholder={full ? `Достигнут максимум: ${max} стран` : 'KZ, UZ или название страны'}
          aria-expanded={open && suggestions.length > 0}
          aria-controls={open && suggestions.length > 0 ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
          aria-describedby={hintId}
          aria-invalid={shownError ? true : undefined}
          disabled={full}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setLocalError(null);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            setActive(-1);
          }}
        />
        {open && suggestions.length > 0 && (
          <ul id={listId} role="listbox" aria-label="Страны" className={s.list}>
            {suggestions.map((c, i) => (
              <li
                key={c.code}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={false}
                className={i === active ? s.optionActive : s.option}
                onMouseDown={(e) => {
                  // раньше blur инпута, чтобы клик не потерялся
                  e.preventDefault();
                  addRaw(c.code);
                  inputRef.current?.focus();
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span className={s.optionCode}>{c.code}</span>
                <span>{c.name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p
        id={hintId}
        className={[s.hint, shownError ? s.hintError : ''].filter(Boolean).join(' ')}
        role="status"
        aria-live="polite"
      >
        {shownError ?? `От 1 до ${max} стран, ввод через запятую.`}
      </p>
    </div>
  );
}
