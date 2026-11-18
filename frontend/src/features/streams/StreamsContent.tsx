import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { acceptJson, jsonHeaders, requestJson } from '../../api/client';
import type { ApplyResult, ArchivedEntry, Offer, PendingRow, Stream } from '../../api/types';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Message, StatusLine } from '../../components/ui/Message';
import { PageHeader } from '../../components/ui/PageHeader';
import { SkeletonRows } from '../../components/ui/Skeleton';
import {
  applyTargetIds,
  emptyStreamTargets,
  pendingBody,
  pendingForStream,
  replacePendingForStream,
  sortedStreams,
  streamName,
} from '../../lib/pending';
import { applyErrorText, pendingChangeErrorText, refreshErrorText } from './errorTexts';
import { SendBar } from './SendBar';
import { StreamCard } from './StreamCard';
import { useStreamsData } from './useStreamsData';
import sc from './StreamCard.module.css';
import s from './StreamsContent.module.css';

interface FocusTarget {
  streamId: number;
  offerId: number;
  n: number;
}

/** Страница потоков кампании. Поведение 1:1 с web/app.js initStreams(). */
export function StreamsContent({ campaignId }: { campaignId: string }) {
  const {
    loading,
    empty,
    pageError,
    serverDown,
    offerErrors,
    forbiddenBanner,
    streams,
    offersMap,
    archive,
    pending,
    campaignName,
    load,
    setStreams,
    setArchive,
    setPending,
    setOffersMap,
  } = useStreamsData(campaignId);

  const [streamErrors, setStreamErrors] = useState<Map<number, string>>(new Map());
  const [busyStreams, setBusyStreams] = useState<Set<number>>(new Set());
  const [sending, setSending] = useState(false);
  const [sendStatus, setSendStatus] = useState<{ text: string; error: boolean } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState<{ text: string; error: boolean } | null>(null);
  const [warningOpen, setWarningOpen] = useState(false);
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);

  const sendBtnRef = useRef<HTMLButtonElement>(null);
  const refreshBtnRef = useRef<HTMLButtonElement>(null);
  const warningRef = useRef<HTMLDivElement>(null);
  const warningCancelRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  /* --- Загрузка --- */

  const reload = useCallback(async () => {
    const out = await load();
    if (out.ok) setStreamErrors(new Map());
  }, [load]);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      const out = await load();
      if (!disposed && out.ok) setStreamErrors(new Map());
    })();
    return () => {
      disposed = true;
    };
  }, [load]);

  /* --- Обновление из Кейтаро --- */

  /** «Обновить из Кейтаро»: повторный GET живых данных без скелета и без
   *  перезагрузки страницы. Скелет и pageError не трогаются, существующие
   *  строки остаются на экране; pending берётся из БД и переживает refresh. */
  const runRefresh = useCallback(async () => {
    if (sending || refreshing) return;
    setRefreshing(true);
    setRefreshStatus(null);
    const out = await load({ refresh: true });
    setRefreshing(false);
    // Устаревший ответ (страницу уже перезагрузил другой запрос) — статус не трогаем.
    if (out.status < 0) return;
    if (out.ok) {
      // Данные перечитаны — старые ошибки операций больше не актуальны.
      setStreamErrors(new Map());
      setRefreshStatus({
        text: `Обновлено в ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`,
        error: false,
      });
    } else {
      setRefreshStatus({ text: refreshErrorText(out.status, out.body), error: true });
    }
    // Chromium сбрасывает фокус с кнопки, пока она disabled; после включения
    // возвращаем его, если пользователь сам не увёл фокус во время запроса.
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) refreshBtnRef.current?.focus();
    });
  }, [load, refreshing, sending]);

  // Заголовок и document.title: до ответа — ID, после — название кампании.
  const title = `Потоки кампании ${campaignName || campaignId}`;

  // Ссылка на кампанию в админке Keitaro: внешняя, в новой вкладке.
  const keitaroAdminHref = `https://tlgk.host/admin/#!/campaign/${campaignId}/main`;
  useEffect(() => {
    document.title = `${title} — Keitaro`;
  }, [title]);

  /* --- Фокус --- */

  // Фокус уходит на блок ошибки при её появлении.
  useEffect(() => {
    if (pageError) errorRef.current?.focus();
  }, [pageError]);

  /** После перерисовки вернуть фокус кнопке этой строки. */
  const focusRow = useCallback((streamId: number, offerId: number) => {
    setFocusTarget((prev) => ({ streamId, offerId, n: (prev?.n ?? 0) + 1 }));
  }, []);

  useEffect(() => {
    if (!focusTarget) return;
    const btn = rootRef.current?.querySelector<HTMLButtonElement>(
      `button[data-stream-id="${focusTarget.streamId}"][data-offer-id="${focusTarget.offerId}"]`,
    );
    btn?.focus();
  }, [focusTarget]);

  // Открытое предупреждение получает фокус на «Отмена»; Esc — фокус назад на кнопку.
  useEffect(() => {
    if (warningOpen) warningCancelRef.current?.focus();
  }, [warningOpen]);

  /* --- Отложенные изменения (pending) --- */

  const busyAdd = (sid: number) => setBusyStreams((prev) => new Set(prev).add(sid));
  const busyDelete = (sid: number) =>
    setBusyStreams((prev) => {
      const next = new Set(prev);
      next.delete(sid);
      return next;
    });
  const clearStreamError = (sid: number) =>
    setStreamErrors((prev) => {
      const next = new Map(prev);
      next.delete(sid);
      return next;
    });

  /** PUT .../streams/{sid}/pending — единственная запись при кликах.
   *  Заменяет набор ожидающих изменений потока целиком; в Keitaro не ходит. */
  const putPending = useCallback(
    (streamId: number, rows: PendingRow[]) =>
      requestJson<{ pending?: PendingRow[] }>(
        `/api/campaigns/${campaignId}/streams/${streamId}/pending`,
        { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(pendingBody(rows)) },
      ),
    [campaignId],
  );

  /** «Удалить» у живого офера: строка остаётся на месте, фон жёлтый,
   *  бейдж «к удалению», доля «—», остальные доли пересчитаны. Единственный
   *  запрос — PUT .../pending; в Keitaro ничего не уходит до «Отправить». */
  const deleteOffer = useCallback(
    async (stream: Stream, offerId: number) => {
      const streamId = stream.id;
      if (!streamId || sending || busyStreams.has(streamId)) return;

      busyAdd(streamId);
      clearStreamError(streamId);
      const updated = [
        ...pending,
        { stream_id: streamId, offer_id: offerId, action: 'remove' as const, created_at: null },
      ];
      setPending(() => updated);
      focusRow(streamId, offerId);

      const { status, body } = await putPending(streamId, pendingForStream(updated, streamId));
      if (status === 200 && body && Array.isArray(body.pending)) {
        const fresh = body.pending;
        setPending(() => replacePendingForStream(updated, streamId, fresh));
      } else {
        // Откат локального состояния при ошибке PUT.
        setPending(() =>
          updated.filter(
            (p) => !(p.stream_id === streamId && p.offer_id === offerId && p.action === 'remove'),
          ),
        );
        setStreamErrors((prev) =>
          new Map(prev).set(
            streamId,
            pendingChangeErrorText(status, body, 'Не удалось пометить офер к удалению.'),
          ),
        );
      }

      busyDelete(streamId);
      focusRow(streamId, offerId);
    },
    [busyStreams, focusRow, pending, putPending, sending],
  );

  /** «Bring Back» у архивного офера: строка жёлтая, бейдж «вернётся в поток»,
   *  её доля участвует в пересчёте как живая. Единственный запрос —
   *  PUT .../pending с add; в Keitaro не ходим до «Отправить». */
  const bringBackOffer = useCallback(
    async (stream: Stream, offerId: number) => {
      const streamId = stream.id;
      if (!streamId || sending || busyStreams.has(streamId)) return;

      busyAdd(streamId);
      clearStreamError(streamId);
      const updated = [
        ...pending,
        { stream_id: streamId, offer_id: offerId, action: 'add' as const, created_at: null },
      ];
      setPending(() => updated);
      focusRow(streamId, offerId);

      const { status, body } = await putPending(streamId, pendingForStream(updated, streamId));
      if (status === 200 && body && Array.isArray(body.pending)) {
        const fresh = body.pending;
        setPending(() => replacePendingForStream(updated, streamId, fresh));
      } else {
        setPending(() =>
          updated.filter(
            (p) => !(p.stream_id === streamId && p.offer_id === offerId && p.action === 'add'),
          ),
        );
        setStreamErrors((prev) =>
          new Map(prev).set(
            streamId,
            pendingChangeErrorText(status, body, 'Не удалось пометить офер к возврату.'),
          ),
        );
      }

      busyDelete(streamId);
      focusRow(streamId, offerId);
    },
    [busyStreams, focusRow, pending, putPending, sending],
  );

  /** «Отменить» у ожидающей строки: снимаем отметку (PUT pending уже без
   *  этого офера) и возвращаем строке исходный вид и доли. Без запросов
   *  в Keitaro. */
  const cancelPendingChange = useCallback(
    async (stream: Stream, offerId: number) => {
      const streamId = stream.id;
      if (!streamId || sending || busyStreams.has(streamId)) return;
      const row = pending.find((p) => p.stream_id === streamId && p.offer_id === offerId);
      if (!row) return;

      busyAdd(streamId);
      clearStreamError(streamId);
      const updated = pending.filter((p) => p !== row);
      setPending(() => updated);
      focusRow(streamId, offerId);

      const { status, body } = await putPending(streamId, pendingForStream(updated, streamId));
      if (status === 200 && body && Array.isArray(body.pending)) {
        const fresh = body.pending;
        setPending(() => replacePendingForStream(updated, streamId, fresh));
      } else {
        setPending(() => [...updated, row]);
        setStreamErrors((prev) =>
          new Map(prev).set(streamId, pendingChangeErrorText(status, body, 'Не удалось отменить изменение.')),
        );
      }

      busyDelete(streamId);
      focusRow(streamId, offerId);
    },
    [busyStreams, focusRow, pending, putPending, sending],
  );

  /** «Добавить» из формы потока: поле и найденный офер уже очищены карточкой. */
  const addOffer = useCallback(
    async (stream: Stream, offer: Offer) => {
      const streamId = stream.id;
      if (!streamId || sending || busyStreams.has(streamId)) return;

      busyAdd(streamId);
      clearStreamError(streamId);
      const updated = [
        ...pending,
        { stream_id: streamId, offer_id: offer.id, action: 'add' as const, created_at: null },
      ];
      setPending(() => updated);
      // Найденный офер уже известен (форма отдала его целиком) — кладём в map,
      // иначе OfferRow рисует «не удалось загрузить офер» до перезагрузки.
      setOffersMap((prev) => new Map(prev).set(offer.id, offer));
      focusRow(streamId, offer.id);

      const { status, body } = await putPending(streamId, pendingForStream(updated, streamId));
      if (status === 200 && body && Array.isArray(body.pending)) {
        const fresh = body.pending;
        setPending(() => replacePendingForStream(updated, streamId, fresh));
      } else {
        setPending(() =>
          updated.filter(
            (p) => !(p.stream_id === streamId && p.offer_id === offer.id && p.action === 'add'),
          ),
        );
        setStreamErrors((prev) =>
          new Map(prev).set(
            streamId,
            pendingChangeErrorText(status, body, 'Не удалось пометить офер к добавлению.'),
          ),
        );
      }

      busyDelete(streamId);
    },
    [busyStreams, focusRow, pending, putPending, sending],
  );

  /* --- Предупреждение перед отправкой --- */

  // Потоки, которые после отправки останутся без оферов.
  const emptyTargets = useMemo(
    () => emptyStreamTargets(streams, pending),
    [streams, pending],
  );

  // Если предупреждение показано, а потоки с нулевым итогом исчезли — скрываем.
  // Текст обновляется сам (живёт в рендере), фокус не двигается.
  useEffect(() => {
    if (warningOpen && emptyTargets.length === 0) setWarningOpen(false);
  }, [warningOpen, emptyTargets]);

  const warningText = useMemo(
    () =>
      emptyTargets
        .map((sid) => streamName(streams.find((x) => x.id === sid) ?? { id: sid }))
        .map((n) => `Поток «${n}» останется без оферов и перестанет принимать трафик.`)
        .join(' '),
    [emptyTargets, streams],
  );

  const hideSendWarning = useCallback(() => setWarningOpen(false), []);

  function onSendClick() {
    if (sending || refreshing || pending.length === 0) return;
    // Повторный клик всегда сбрасывает прошлое предупреждение.
    setWarningOpen(false);
    if (emptyTargets.length) {
      // Ничего не отправляем и pending не трогаем, пока не нажато
      // «Всё равно отправить» (или «Отмена»).
      setWarningOpen(true);
      return;
    }
    void runApply();
  }

  /* --- Отправка (apply) --- */

  async function runApply() {
    const focusWasInSendArea =
      document.activeElement === sendBtnRef.current ||
      (warningRef.current?.contains(document.activeElement) ?? false);
    setSending(true);
    setSendStatus(null);
    // Прошлый «Обновлено в …» не должен висеть над уже другими данными.
    setRefreshStatus(null);

    // Потоки с ожидающими изменениями, в порядке списка; поток вне списка
    // (редкий случай) — в конец, apply проверяет кампанию по самому потоку.
    const targets = applyTargetIds(streams, pending);

    let applied = 0;
    let failed = 0;
    const errors: string[] = [];
    const successIds = new Set<number>();

    // Только здесь и только последовательные POST .../apply — по одному
    // на поток, один PUT в Keitaro внутри каждого.
    for (const sid of targets) {
      busyAdd(sid);
      const { status, body } = await requestJson<ApplyResult>(
        `/api/campaigns/${campaignId}/streams/${sid}/apply`,
        { method: 'POST', headers: acceptJson },
      );
      if (status === 200 && body && body.applied) {
        successIds.add(sid);
        // Актуальный поток — из ответа; его доли уже пересчитаны Keitaro.
        if (body.stream) {
          const fresh = body.stream;
          setStreams((prev) => prev.map((s) => (s.id === sid ? fresh : s)));
        }
        const addedIds = Array.isArray(body.added) ? body.added : [];
        const removedIds = Array.isArray(body.removed) ? body.removed : [];
        // Локальная бухгалтерия архива: возвращённые снимаются с архива,
        // удалённые попадают в него (до сверки с refreshArchive).
        setArchive((prev) => {
          let next = prev.filter((a) => !(a.stream_id === sid && addedIds.includes(a.offer_id)));
          const nowIso = new Date().toISOString();
          for (const oid of removedIds) {
            next = [
              ...next,
              {
                stream_id: sid,
                offer_id: oid,
                share: null,
                state: offersMap.get(oid)?.state ?? null,
                archived_at: nowIso,
                reason: 'user',
              },
            ];
          }
          return next;
        });
        setPending((prev) => prev.filter((p) => p.stream_id !== sid));
        clearStreamError(sid);
        applied += 1;
      } else {
        // Ошибка одного потока: его изменения остаются как были, идём дальше.
        failed += 1;
        const text = applyErrorText(status, body);
        setStreamErrors((prev) => new Map(prev).set(sid, text));
        errors.push(`Поток ${streamName(streams.find((x) => x.id === sid) ?? { id: sid })}: ${text}`);
      }
      busyDelete(sid);
    }
    setSending(false);

    const parts = [...errors, `Потоков обновлено: ${applied}`];
    if (failed) parts.push(`Не отправлено: ${failed}`);
    setSendStatus({ text: parts.join(' · '), error: errors.length > 0 });

    // Кнопка ушла в disabled при отправке — возвращаем фокус на статус, а не в «никуда».
    const remainingPending = pending.filter((p) => !successIds.has(p.stream_id));
    if (focusWasInSendArea && remainingPending.length === 0) {
      requestAnimationFrame(() => {
        statusRef.current?.focus();
      });
    }

    // Архив — локальные данные обёртки; после успешных применений сверяем.
    if (applied) {
      const res = await requestJson<{ archived?: ArchivedEntry[] }>(
        `/api/campaigns/${campaignId}/streams/archive`,
        { headers: acceptJson },
      );
      if (res.status === 200 && res.body && Array.isArray(res.body.archived)) {
        setArchive(() => res.body!.archived!);
      }
    }
  }

  /* --- Рендер --- */

  const draftAdds = pending.filter((p) => p.action === 'add').length;
  const draftRemoves = pending.length - draftAdds;
  const sorted = useMemo(() => sortedStreams(streams, pending, archive), [streams, pending, archive]);

  if (pageError) {
    return (
      <div className="page">
        <section className="card">
          <PageHeader
            back={{ to: '/campaigns', children: '← К списку кампаний' }}
            title="Потоки кампании"
            meta={
              <p className="counter">
                ID кампании: {campaignId} ·{' '}
                <a className="link" href={keitaroAdminHref} target="_blank" rel="noopener noreferrer">
                  открыть в Keitaro ↗
                </a>
              </p>
            }
          />
          <div ref={errorRef} role="alert" tabIndex={-1} className={s.errorBlock}>
            <Message kind="error">{pageError.text}</Message>
            <div className={s.errorActions}>
              {pageError.kind === 'home' && (
                <Link to="/" className="link">
                  Указать API key на главной
                </Link>
              )}
              {pageError.kind === 'campaigns' && (
                <Link to="/campaigns" className="link">
                  К списку кампаний
                </Link>
              )}
              {pageError.kind === 'retry' && (
                <Button onClick={() => void reload()}>Повторить</Button>
              )}
            </div>
          </div>
        </section>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="page">
        <section className="card wide">
          <PageHeader
            back={{ to: '/campaigns', children: '← К списку кампаний' }}
            title={title}
            meta={
              <p className="counter">
                ID кампании: {campaignId} ·{' '}
                <a className="link" href={keitaroAdminHref} target="_blank" rel="noopener noreferrer">
                  открыть в Keitaro ↗
                </a>
              </p>
            }
          />
          <div aria-busy="true">
            <p className="sr-only" role="status">
              Загружаем потоки…
            </p>
            <SkeletonRows rows={3} />
          </div>
        </section>
      </div>
    );
  }

  if (empty) {
    return (
      <div className="page">
        <section className="card">
          <PageHeader
            back={{ to: '/campaigns', children: '← К списку кампаний' }}
            title={title}
            meta={
              <p className="counter">
                ID кампании: {campaignId} ·{' '}
                <a className="link" href={keitaroAdminHref} target="_blank" rel="noopener noreferrer">
                  открыть в Keitaro ↗
                </a>
              </p>
            }
          />
          <EmptyState title="В этой кампании нет потоков." />
          {/* Обновление и из empty-state: поток, добавленный в Кейтаро,
              появляется без перезагрузки страницы. */}
          <div className={s.errorActions}>
            <Button
              variant="secondary"
              disabled={sending || refreshing}
              onClick={() => void runRefresh()}
              buttonRef={refreshBtnRef}
            >
              {refreshing ? 'Обновляем…' : 'Обновить из Кейтаро'}
            </Button>
            {refreshStatus && (
              <StatusLine error={refreshStatus.error} role="status">
                {refreshStatus.text}
              </StatusLine>
            )}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="page">
      {/* Несохранённые изменения: янтарная рамка карточки, пока есть ожидающие. */}
      <section className={`card wide ${pending.length > 0 ? sc.hasDraft : ''}`}>
        <PageHeader
          back={{ to: '/campaigns', children: '← К списку кампаний' }}
          title={title}
          meta={
            <p className="counter">
              ID кампании: {campaignId} ·{' '}
              <a className="link" href={keitaroAdminHref} target="_blank" rel="noopener noreferrer">
                открыть в Keitaro ↗
              </a>
            </p>
          }
        />

        <div ref={rootRef} aria-busy={(sending || refreshing) || undefined}>
          <SendBar
            sending={sending}
            refreshing={refreshing}
            pendingCount={pending.length}
            adds={draftAdds}
            removes={draftRemoves}
            onSend={onSendClick}
            onRefresh={() => void runRefresh()}
            buttonRef={sendBtnRef}
            refreshButtonRef={refreshBtnRef}
          />

          {/* Предупреждение перед отправкой потока без оферов: инлайн-блок,
              не dialog/confirm(); Esc отменяет. */}
          {warningOpen && (
            <div
              ref={warningRef}
              className={s.sendWarning}
              role="alert"
              aria-live="polite"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  hideSendWarning();
                  sendBtnRef.current?.focus();
                }
              }}
            >
              <p className={s.warningText}>{warningText}</p>
              <div className={s.warningActions}>
                <Button
                  variant="secondary"
                  buttonRef={warningCancelRef}
                  onClick={() => {
                    hideSendWarning();
                    sendBtnRef.current?.focus();
                  }}
                >
                  Отмена
                </Button>
                <Button
                  variant="danger"
                  disabled={sending || refreshing}
                  onClick={() => {
                    // После «Всё равно отправить» предупреждение больше не показываем.
                    hideSendWarning();
                    void runApply();
                  }}
                >
                  Всё равно отправить
                </Button>
              </div>
            </div>
          )}

          {sendStatus && (
            <StatusLine
              error={sendStatus.error}
              role="status"
              tabIndex={-1}
              className={s.sendStatus}
              lineRef={statusRef}
            >
              {sendStatus.text}
            </StatusLine>
          )}

          {/* Статус кнопки «Обновить из Кейтаро»: успех или честная ошибка
              по HTTP-статусу; строки списка при этом не заменяются. */}
          {refreshStatus && (
            <StatusLine error={refreshStatus.error} role="status" className={s.sendStatus}>
              {refreshStatus.text}
            </StatusLine>
          )}

          {/* Сервер/сеть недоступны целиком (status 0): страница нарисована
              старыми данными — один общий блок вместо ошибки в каждой строке.
              Исчезает после успешного «Повторить». */}
          {serverDown && (
            <div role="alert" aria-live="polite" className={s.errorBlock}>
              <Message kind="error">
                Сервер не отвечает. Проверьте, что uvicorn запущен, и обновите страницу.
              </Message>
              <div className={s.errorActions}>
                <Button onClick={() => void reload()}>Повторить</Button>
              </div>
            </div>
          )}

          {/* Хотя бы один офер ответил 403: у ключа нет права на страницу
              Offers. Один баннер на страницу с реальным текстом из detail
              вместо построчного «не удалось загрузить офер» (404/502 остаются
              построчно). «Повторить» не предлагаем: права меняются в Keitaro,
              запросом это не лечится. */}
          {forbiddenBanner && (
            <div role="alert" aria-live="polite" className={s.errorBlock}>
              <Message kind="error">{forbiddenBanner}</Message>
            </div>
          )}

          <div className={s.list}>
            {sorted.map((stream) => (
              <StreamCard
                key={stream.id}
                stream={stream}
                pendingRows={pendingForStream(pending, stream.id)}
                archive={archive}
                offersMap={offersMap}
                sending={sending}
                busy={busyStreams.has(stream.id)}
                error={streamErrors.get(stream.id) ?? null}
                serverDown={serverDown}
                offerErrors={offerErrors}
                onDelete={(st, oid) => void deleteOffer(st, oid)}
                onCancel={(st, oid) => void cancelPendingChange(st, oid)}
                onBringBack={(st, oid) => void bringBackOffer(st, oid)}
                onAdd={addOffer}
              />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
