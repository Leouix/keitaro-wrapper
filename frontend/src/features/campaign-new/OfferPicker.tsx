import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { addedShares } from '../../lib/shares';
import { checkOffer } from './campaignNewApi';
import s from './OfferPicker.module.css';
export interface OfferChip {
  id: number;
  name?: string | null;
  state?: string | null;
  /** Предупреждение, с которым чип добавлен (403/502/сеть) — создание не блокирует. */
  warn?: string | null;
}

interface Props {
  selected: OfferChip[];
  onChange: (chips: OfferChip[]) => void;
  /** id поля — для htmlFor снаружи. */
  id: string;
  hintId?: string;
  /** Блокирующая ошибка страницы (минимум один оффер). */
  error?: string | null;
  max: number;
}

interface Lookup {
  id: number;
  busy: boolean;
  status: number | 'dup';
  name?: string | null;
  state?: string | null;
  detail?: string;
}

const CHECK_DEBOUNCE_MS = 350;

/** Разбор ввода: '18813, 18814 18815' → [18813, 18814, 18815] (без дублей, порядок сохранён). */
function parseOfferIds(raw: string): number[] {
  return raw
    .split(/[\s,;]+/)
    .filter((t) => t.length > 0)
    .map((t) => t.trim())
    .filter((t) => /^\d+$/.test(t) && Number(t) > 0)
    .map(Number)
    .filter((id, i, all) => all.indexOf(id) === i);
}

const WARN_FORBIDDEN = 'нет прав у ключа, проверит сервер';
const WARN_UNAVAILABLE = 'Keitaro недоступен, добавлен без проверки';

/**
 * Мультивыбор офферов, как страны: ввод ID → проверка при вводе (дебаунс,
 * без кнопки) → чип с ID, именем, статусом и долей. Enter/запятая/потеря
 * фокуса добавляют чип; Backspace на пустом поле убирает последний.
 * 404 не добавляется, 403/502 добавляются с предупреждением.
 */
export function OfferPicker({ selected, onChange, id, hintId, error, max }: Props) {
  const [query, setQuery] = useState('');
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  // Свежие значения для асинхронных колбэков.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Проверка каждого ID — не больше одного запроса за всё время.
  const checkedRef = useRef(new Set<number>());
  const inFlightRef = useRef(new Set<number>());
  // Кэш результата проверки: удалённый и снова добавленный оффер
  // показывает имя/статус из кэша, без повторного запроса.
  const cacheRef = useRef(new Map<number, { status: number; name: string | null; state: string | null }>());

  /** Результат проверки: обновляет чип, если он уже добавлен. */
  function applyResult(id: number, result: { status: number; name: string | null; state: string | null }) {
    const chips = selectedRef.current;
    const i = chips.findIndex((c) => c.id === id);
    if (i < 0) return;
    if (result.status === 200) {
      onChangeRef.current(
        chips.map((c, j) => (j === i ? { ...c, name: result.name, state: result.state, warn: null } : c)),
      );
    } else if (result.status === 404) {
      onChangeRef.current(chips.filter((c) => c.id !== id));
      setLocalError(`Оффер ${id} не найден в Keitaro.`);
    } else if (result.status === 403) {
      onChangeRef.current(chips.map((c, j) => (j === i ? { ...c, warn: WARN_FORBIDDEN } : c)));
    } else {
      onChangeRef.current(chips.map((c, j) => (j === i ? { ...c, warn: WARN_UNAVAILABLE } : c)));
    }
  }

  /** Один запрос на ID за всё время: параллельные/повторные вызовы схлопываются. */
  function ensureCheck(offerId: number, showBusy = false) {
    if (checkedRef.current.has(offerId) || inFlightRef.current.has(offerId)) return;
    inFlightRef.current.add(offerId);
    if (showBusy) setLookup({ id: offerId, busy: true, status: 0 });
    void checkOffer(offerId).then((result) => {
      inFlightRef.current.delete(offerId);
      checkedRef.current.add(offerId);
      cacheRef.current.set(offerId, { status: result.status, name: result.name, state: result.state });
      setLookup({ id: offerId, busy: false, ...result });
      applyResult(offerId, result);
    });
  }

  // Проверка при вводе: пауза после набора полного числа → GET /api/offers/{id}.
  const debouncedQuery = useDebouncedQuery(query, CHECK_DEBOUNCE_MS);
  useEffect(() => {
    const q = debouncedQuery.text.trim();
    if (!q) {
      setLookup(null);
      setLocalError(null);
      return;
    }
    if (/[^\d\s,;]/.test(q)) {
      setLookup(null);
      setLocalError('Введите ID оффера — положительное число.');
      return;
    }
    const ids = parseOfferIds(q);
    if (ids.length !== 1) {
      setLookup(null);
      return;
    }
    if (selectedRef.current.some((c) => c.id === ids[0])) {
      setLookup({ id: ids[0], busy: false, status: 'dup' });
      return;
    }
    const cached = cacheRef.current.get(ids[0]);
    if (cached) {
      // Уже проверялся (в том числе удалённый чип): имя/статус из кэша, без запроса.
      setLookup({ id: ids[0], busy: false, ...cached });
      return;
    }
    ensureCheck(ids[0], true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery]);

  /** Enter/запятая/потеря фокуса: добавляет чипы с учётом результата проверки. */
  function commit() {
    const q = query.trim();
    if (!q) return;
    if (/[^\d\s,;]/.test(q)) {
      setLocalError('Введите ID оффера — положительное число.');
      return;
    }
    const ids = parseOfferIds(q);
    if (!ids.length) {
      setLocalError('Введите ID оффера — положительное число.');
      return;
    }
    const chips = [...selectedRef.current];
    const problems: string[] = [];
    let addedAny = false;

    for (const offerId of ids) {
      if (chips.some((c) => c.id === offerId)) {
        problems.push(`Оффер ${offerId} уже добавлен.`);
        continue;
      }
      if (chips.length >= max) {
        problems.push(`Не больше ${max} офферов.`);
        break;
      }
      // Результат из кэша (уже проверялся) или из живой подсказки; запрос не повторяется.
      const cached = cacheRef.current.get(offerId);
      const known = cached
        ? { id: offerId, busy: false, ...cached }
        : lookup && lookup.id === offerId && !lookup.busy
          ? lookup
          : null;
      if (known?.status === 404) {
        problems.push(`Оффер ${offerId} не найден в Keitaro.`);
        continue;
      }
      chips.push({
        id: offerId,
        name: known?.status === 200 ? known.name : null,
        state: known?.status === 200 ? known.state : null,
        warn: known?.status === 403 ? WARN_FORBIDDEN : known && (known.status === 502 || known.status === 0) ? WARN_UNAVAILABLE : null,
      });
      // Чип без имени: проверка уже идёт (ensureCheck сам не дублирует запрос).
      ensureCheck(offerId);
      addedAny = true;
    }

    if (addedAny) {
      onChangeRef.current(chips);
      setQuery('');
      setLookup(null);
      setLocalError(problems.length ? problems.join(' ') : null);
    } else if (problems.length) {
      setLocalError(problems.join(' '));
    }
  }

  function remove(offerId: number) {
    onChange(selectedRef.current.filter((c) => c.id !== offerId));
    // Подсказка о проверенном, но удалённом оффере больше не нужна.
    setLookup((lk) => (lk && lk.id === offerId ? null : lk));
    setLocalError(null);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      // Добавляет чипы, но не сабмитит форму.
      e.preventDefault();
      commit();
      return;
    }
    if (e.key === ',') {
      e.preventDefault();
      commit();
      return;
    }
    if (e.key === 'Backspace' && !query && selected.length) {
      remove(selected[selected.length - 1].id);
    }
  }

  const full = selected.length >= max;
  const shownError = localError ?? error ?? null;
  const shares = addedShares([], selected.length);
  const warns = selected.filter((c) => c.warn);

  return (
    <div className={s.wrap}>
      {selected.length > 0 && (
        <ul className={s.chips} aria-label="Выбранные офферы">
          {selected.map((chip, i) => (
            <li
              key={chip.id}
              className={s.chip}
              title={chip.warn ?? undefined}
              data-warn={chip.warn ? 'true' : undefined}
            >
              <span className={s.chipCode}>{chip.id}</span>
              <span className={s.chipName}>{chip.name || (chip.warn ? '' : `ID ${chip.id}`)}</span>
              <span className={s.chipShare}>{shares[i]}%</span>
              <button
                type="button"
                className={s.chipRemove}
                aria-label={`Убрать оффер ${chip.id}`}
                onClick={() => remove(chip.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected.length >= 2 && (
        <p className={s.sharesNote}>Веса равные, сумма 100.</p>
      )}
      <input
        id={id}
        className={s.input}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        placeholder={full ? `Достигнут максимум: ${max} офферов` : 'ID оффера, например 18813 или 18813, 18814'}
        aria-describedby={hintId}
        aria-invalid={shownError ? true : undefined}
        disabled={full}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setLocalError(null);
        }}
        onKeyDown={onKeyDown}
        onBlur={commit}
      />
      {warns.length > 0 && (
        <p className={s.warnLine}>
          {warns.map((c) => `${c.id} — ${c.warn}`).join('; ')}
        </p>
      )}
      <p
        id={hintId}
        className={[s.hint, shownError ? s.hintError : ''].filter(Boolean).join(' ')}
        role="status"
        aria-live="polite"
      >
        {shownError ??
          (lookup?.busy
            ? 'Проверяем…'
            : lookup?.status === 'dup'
              ? `Оффер ${lookup.id} уже добавлен.`
              : lookup?.status === 200
                ? `Оффер ${lookup.id}: ${lookup.name || 'без названия'}${lookup.state ? ` — ${lookup.state}` : ''}`
                : lookup?.status === 404
                  ? `Оффер ${lookup.id} не найден в Keitaro.`
                  : lookup?.status === 403
                    ? `Оффер ${lookup.id}: нет прав у ключа — добавим, сервер проверит при создании.`
                    : lookup && (lookup.status === 502 || lookup.status === 0)
                      ? `Оффер ${lookup.id}: Keitaro недоступен — добавим без проверки.`
                      : `От 1 до ${max} офферов, ввод через запятую; проверка при вводе.`)}
      </p>
    </div>
  );
}

/** Мини-дебаунс: значение, отложенное на delay мс. seq растёт на каждом
 * срабатывании, чтобы повторный ввод той же строки был новым событием. */
function useDebouncedQuery(value: string, delay: number): { text: string; seq: number } {
  const [state, setState] = useState({ text: value, seq: 0 });
  useEffect(() => {
    const timer = setTimeout(() => setState((prev) => ({ text: value, seq: prev.seq + 1 })), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return state;
}
