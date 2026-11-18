import { useEffect, useRef, useState } from 'react';
import { acceptJson, detailToText } from '../../api/client';
import type { ArchivedEntry, Offer, PendingRow, Stream } from '../../api/types';
import { useAbortableRequest } from '../../hooks/useAbortableRequest';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { Message } from '../../components/ui/Message';
import { pendingAddBadgeText, computeStreamRows } from '../../lib/shares';
import type { StreamRow } from '../../lib/shares';
import { offerNameForbiddenText } from './errorTexts';
import { streamName } from '../../lib/pending';
import table from '../../components/ui/table.module.css';
import s from './StreamCard.module.css';

type Hint = { text: string; kind: '' | 'found' | 'error' };

interface Props {
  stream: Stream;
  /** pendingForStream(stream.id, pending). */
  pendingRows: PendingRow[];
  /** Архив всей кампании (компонент сам берёт свою часть). */
  archive: ArchivedEntry[];
  offersMap: Map<number, Offer | null>;
  sending: boolean;
  busy: boolean;
  error: string | null;
  /** Сервер/сеть недоступны целиком: в строках не дублируем текст ошибки. */
  serverDown: boolean;
  /** HTTP-статус ошибки по каждому оферу (0 — успех): 403 подписывается
   *  честно («название недоступно: нет прав»), 404/502 — построчно. */
  offerErrors?: Map<number, number>;
  onDelete: (stream: Stream, offerId: number) => void;
  onCancel: (stream: Stream, offerId: number) => void;
  onBringBack: (stream: Stream, offerId: number) => void;
  onAdd: (stream: Stream, offer: Offer) => Promise<void>;
}

function isDuplicate(stream: Stream, pendingRows: PendingRow[], offerId: number): boolean {
  if (Array.isArray(stream.offers) && stream.offers.some((o) => o.offer_id === offerId)) return true;
  return pendingRows.some((p) => p.offer_id === offerId);
}

const digitsOf = (v: string) => v.replace(/\D/g, '').replace(/^0+(?=\d)/, '');

/** Пауза после последнего ввода перед поиском: человек набирает ID по цифре
 *  с паузами 200–400 мс, поэтому 500 мс — только финальное значение уходит
 *  одним запросом. */
const SEARCH_DEBOUNCE_MS = 500;
/** Ошибку поиска показываем с той же задержкой и только если после ответа
 *  поле не менялось: префиксные 404 не вспыхивают красным при наборе. */
const ERROR_HINT_DELAY_MS = 500;

/** Карточка одного потока: таблица оферов и форма добавления (живой поиск по ID). */
export function StreamCard({
  stream,
  pendingRows,
  archive,
  offersMap,
  sending,
  busy,
  error,
  serverDown,
  offerErrors,
  onDelete,
  onCancel,
  onBringBack,
  onAdd,
}: Props) {
  const name = streamName(stream);
  // Архив потока передаётся в computeStreamRows целиком: офер с pending add
  // рисуется на своей архивной позиции (бейдж «вернётся в поток»), а не уезжает наверх.
  const streamArchive = archive.filter((a) => a.stream_id === stream.id);
  const rows = computeStreamRows(stream, pendingRows, streamArchive, offersMap);
  const hasRows =
    (Array.isArray(stream.offers) && stream.offers.length > 0) ||
    pendingRows.length > 0 ||
    streamArchive.length > 0;

  return (
    <section className={s.section}>
      <h2 className={s.heading}>
        {name}
        <span className={s.meta}>
          {stream.schema || '—'} · ID {stream.id}
        </span>
      </h2>

      {hasRows ? (
        <div className={table.wrap}>
          <table className={table.table}>
            <thead>
              <tr>
                <th scope="col">Офер</th>
                <th scope="col" className={table.num}>
                  Доля
                </th>
                <th scope="col">Статус</th>
                <th scope="col">Поток</th>
                <th scope="col" className={table.num}>
                  Выплата
                </th>
                <th scope="col">Действие</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <OfferRow
                  key={`${row.entry.offer_id}-${row.pendingAction ?? 'live'}-${row.isArchived ? 'arch' : ''}`}
                  row={row}
                  archive={archive}
                  name={name}
                  sending={sending}
                  busy={busy}
                  serverDown={serverDown}
                  offerErrors={offerErrors}
                  onDelete={onDelete}
                  onCancel={onCancel}
                  onBringBack={onBringBack}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={s.noOffers}>Без оферов</p>
      )}

      {/* Ошибка последней операции по этому потоку — под таблицей, статусом. */}
      {error && (
        <Message kind="error" role="status" aria-live="polite" className={s.streamError}>
          {error}
        </Message>
      )}

      {stream.schema === 'landings' ? (
        <OfferForm
          stream={stream}
          name={name}
          pendingRows={pendingRows}
          sending={sending}
          busy={busy}
          onAdd={onAdd}
        />
      ) : (
        <p className={s.noOffers}>Поток не принимает оферы (schema={stream.schema || '—'})</p>
      )}
    </section>
  );
}

/* ------------------------------- Строка офера ------------------------------- */

function OfferRow({
  row,
  archive,
  name,
  sending,
  busy,
  serverDown,
  offerErrors,
  onDelete,
  onCancel,
  onBringBack,
}: {
  row: StreamRow;
  archive: ArchivedEntry[];
  name: string;
  sending: boolean;
  busy: boolean;
  serverDown: boolean;
  offerErrors?: Map<number, number>;
  onDelete: (stream: Stream, offerId: number) => void;
  onCancel: (stream: Stream, offerId: number) => void;
  onBringBack: (stream: Stream, offerId: number) => void;
}) {
  const { stream, entry, offer, share, pendingAction, isArchived, reason } = row;
  const streamId = stream.id;
  const offerId = entry.offer_id;
  const disabled = !streamId || sending || busy;
  const errStatus = offerErrors?.get(offerId) ?? 0;

  const payout = offer ? Number(offer.payout_value) : 0;
  const payoutText = payout ? [payout, offer?.payout_currency].filter(Boolean).join(' ') : '';

  return (
    <tr className={isArchived ? table.archivedRow : pendingAction ? table.pendingRow : ''}>
      <td className={`${table.offerCell} wrap-anywhere`} data-label="Офер">
        <span className={table.offerId}>#{offerId}</span>{' '}
        {isArchived && (
          <Badge kind="archived">{reason === 'keitaro' ? 'удалён в Keitaro' : 'в архиве'}</Badge>
        )}
        {/* Сервер недоступен целиком — текст ошибки живёт в общем блоке
            сверху, здесь только прочерк; 403 — честное «нет прав» (id и доля
            остаются из payload потоков, сам офер не трогаем); сбои одного
            офера при живом сервере (404/502/500) по-прежнему видны в своей
            строке. */}
        {offer ? (
          <>{offer.name || ''}</>
        ) : !isArchived ? (
          serverDown ? (
            <span aria-label={`Офер #${offerId}: данные недоступны`}>—</span>
          ) : errStatus === 403 ? (
            <em>{offerNameForbiddenText}</em>
          ) : (
            <em>не удалось загрузить офер</em>
          )
        ) : null}
        {pendingAction === 'remove' && <Badge kind="pending">к удалению</Badge>}
        {pendingAction === 'add' && (
          <Badge kind="pending">{pendingAddBadgeText(streamId, offerId, archive)}</Badge>
        )}
      </td>
      <td className={table.num} data-label="Доля">
        {share == null ? '—' : `${share}%`}
      </td>
      <td data-label="Статус">
        {isArchived
          ? entry.state || offer?.state || '—'
          : offer?.state || entry.state || '—'}
      </td>
      {/* Имя потока не переносится: «Flow 1» должно оставаться одной строкой. */}
      <td className="nowrap" data-label="Поток">
        {stream ? name : '—'}
      </td>
      <td className={table.num} data-label="Выплата">
        {payoutText}
      </td>
      <td className="nowrap" data-label="Действие">
        {pendingAction ? (
          <Button
            size="sm"
            variant="secondary"
            data-stream-id={streamId}
            data-offer-id={offerId}
            aria-label={`Отменить отложенное изменение офера #${offerId} в потоке ${name}`}
            disabled={disabled}
            onClick={() => onCancel(stream, offerId)}
          >
            Отменить
          </Button>
        ) : isArchived ? (
          <Button
            size="sm"
            variant="secondary"
            data-stream-id={streamId}
            data-offer-id={offerId}
            aria-label={`Вернуть офер #${offerId} в поток ${name}`}
            disabled={disabled}
            onClick={() => onBringBack(stream, offerId)}
          >
            Bring Back
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            data-stream-id={streamId}
            data-offer-id={offerId}
            aria-label={`Удалить офер #${offerId} из потока ${name}`}
            disabled={disabled}
            onClick={() => onDelete(stream, offerId)}
          >
            Удалить
          </Button>
        )}
      </td>
    </tr>
  );
}

/* ------------------------- Форма добавления офера ------------------------- */

function OfferForm({
  stream,
  name,
  pendingRows,
  sending,
  busy,
  onAdd,
}: {
  stream: Stream;
  name: string;
  pendingRows: PendingRow[];
  sending: boolean;
  busy: boolean;
  onAdd: (stream: Stream, offer: Offer) => Promise<void>;
}) {
  const streamId = stream.id;
  const [value, setValue] = useState('');
  const [found, setFound] = useState<Offer | null>(null);
  const [hint, setHint] = useState<Hint>({ text: '', kind: '' });
  const inputRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { request, cancel } = useAbortableRequest();

  valueRef.current = value;

  function clearErrorTimer() {
    if (errorTimerRef.current) {
      clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
  }

  function resetSearch() {
    cancel();
    if (timerRef.current) clearTimeout(timerRef.current);
    clearErrorTimer();
    setFound(null);
    setHint({ text: '', kind: '' });
  }

  // Пауза 500 мс (SEARCH_DEBOUNCE_MS); в поле остаются только цифры положительного целого.
  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const digits = digitsOf(e.target.value);
    setValue(digits);

    // Любой новый ввод: устаревшие ответы, таймер и отложенная ошибка больше не нужны.
    cancel();
    if (timerRef.current) clearTimeout(timerRef.current);
    clearErrorTimer();

    if (!digits) {
      resetSearch();
      return;
    }
    setHint({ text: 'Ищем оффер…', kind: '' });
    timerRef.current = setTimeout(() => void searchOffer(digits), SEARCH_DEBOUNCE_MS);
  }

  // Кнопка очистки у <input type="search">: React не декларирует 'search' — слушаем вручную.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onSearchEvent = () => {
      if (!el.value) {
        cancel();
        if (timerRef.current) clearTimeout(timerRef.current);
        clearErrorTimer();
        setFound(null);
        setHint({ text: '', kind: '' });
      }
    };
    el.addEventListener('search', onSearchEvent);
    return () => el.removeEventListener('search', onSearchEvent);
  }, [cancel]);

  /** Ошибка поиска: found=null сразу, а текст — через ERROR_HINT_DELAY_MS
   *  и только если после ответа значение в поле не менялось и новых нажатий
   *  не было. Пока таймер тикает — подсказка остаётся нейтральной
   *  («Ищем оффер…»), красный текст на промежуточных префиксах не вспыхивает. */
  function failSearch(idStr: string, text: string) {
    setFound(null);
    clearErrorTimer();
    errorTimerRef.current = setTimeout(() => {
      if (digitsOf(valueRef.current) !== idStr) return; // поле менялось — молча.
      setHint({ text, kind: 'error' });
    }, ERROR_HINT_DELAY_MS);
  }

  async function searchOffer(idStr: string) {
    const { result, stale } = await request<Offer>(`/api/offers/${idStr}`, {
      headers: acceptJson,
    });
    // Ответ на устаревший (или отменённый) запрос — молча выбрасываем.
    if (stale) {
      clearErrorTimer();
      return;
    }
    // Поле могло измениться — состояние пишем только для текущего ввода.
    if (digitsOf(valueRef.current) !== idStr) {
      clearErrorTimer();
      setFound(null);
      return;
    }

    const { status, body } = result;
    if (status === 200 && body && body.id != null) {
      clearErrorTimer();
      setFound(body);
      let text = `#${body.id}${body.name ? ` — ${body.name}` : ''}`;
      const payout = Number(body.payout_value);
      if (payout) text += ` · ${payout}${body.payout_currency ? ` ${body.payout_currency}` : ''}`;
      if (body.state) text += ` · ${body.state}`;
      setHint({ text, kind: 'found' });
    } else if (status === 404) {
      failSearch(idStr, `Офер с ID ${parseInt(idStr, 10)} не найден`);
    } else if (status === 409) {
      failSearch(idStr, 'Сначала укажите API key на главной.');
    } else if (status === 502) {
      failSearch(idStr, 'Keitaro недоступен, попробуйте позже.');
    } else if (status === 0) {
      failSearch(idStr, 'Сеть недоступна, попробуйте ещё раз.');
    } else {
      failSearch(
        idStr,
        detailToText((body as { detail?: unknown } | null)?.detail, `Не удалось найти офер (код ${status}).`),
      );
    }
  }

  const duplicate = found ? isDuplicate(stream, pendingRows, found.id) : false;
  const addDisabled = sending || busy || !found || duplicate;
  const addTitle =
    sending || busy
      ? 'Идёт запрос…'
      : !found
        ? 'Сначала найдите офер по ID'
        : duplicate
          ? 'Этот офер уже есть в этом потоке или уже помечен как изменение'
          : 'Помечается как отложенное добавление — уйдёт в Keitaro по «Отправить в Кейтаро»';

  /**
   * «Добавить»: офер помечается как отложенное добавление (pending add)
   * и запоминается через PUT .../pending. В Keitaro не ходим — офер
   * появится в потоке только по «Отправить в Кейтаро».
   */
  async function handleAdd() {
    if (addDisabled || !found) return;
    const offer = found;
    // Поле очищается, найденный офер «забывается»; строка появится после ререндера.
    setFound(null);
    setValue('');
    setHint({ text: '', kind: '' });
    await onAdd(stream, offer);
    // Возвращаем фокус в поле.
    inputRef.current?.focus();
  }

  return (
    <form className={s.offerForm} noValidate onSubmit={(e) => e.preventDefault()}>
      <div className={s.row}>
        <Field
          id={`offer-id-${streamId}`}
          label={`Добавить офер в ${name}`}
          type="search"
          inputMode="numeric"
          autoComplete="off"
          placeholder="Введите ID оффера"
          hintId={`offer-hint-${streamId}`}
          hint={hint.text}
          hintKind={hint.kind}
          value={value}
          onChange={onChange}
          inputRef={inputRef}
          wrapClassName={s.searchField}
        />
        <div className={s.actions}>
          <Button
            disabled={addDisabled}
            title={addTitle}
            onClick={() => void handleAdd()}
            variant="secondary"
            // Активная кнопка (офер найден и не дубликат) подсвечена синим —
            // см. .addActive в StreamCard.module.css; неактивная остаётся серой.
            className={addDisabled ? undefined : s.addActive}
          >
            Добавить
          </Button>
        </div>
      </div>
    </form>
  );
}
