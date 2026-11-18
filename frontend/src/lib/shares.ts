import type { ArchivedEntry, Offer, PendingRow, Stream, StreamOfferEntry } from '../api/types';

/** Строка таблицы оферов потока — то, что рисует OfferRow. */
export interface StreamRow {
  stream: Stream;
  entry: { offer_id: number; state?: string | null };
  offer: Offer | null;
  /** null → доля не определена (прочерк «—»). */
  share: number | null;
  pendingAction: 'add' | 'remove' | null;
  isArchived: boolean;
  /** Причина архивации: 'keitaro' → бейдж «удалён в Keitaro», иначе «в архиве». */
  reason: string | null;
}

/**
 * Доли для оферов, которых в Keitaro ещё нет (черновик/возврат из архива).
 * При живых оферах — средний вес живых: при равных весах это ровно доля
 * нового офера в наборе (4×25 + новый → 25). Пустой поток — 100 на всех
 * поровну. Тот же расчёт делает бэкенд при отправке в Keitaro.
 */
export function addedShares(liveShares: number[], count: number): number[] {
  if (count <= 0) return [];
  if (liveShares.length > 0) {
    const mean = Math.round(liveShares.reduce((a, b) => a + b, 0) / liveShares.length);
    return Array.from({ length: count }, () => mean);
  }
  const base = Math.floor(100 / count);
  const rem = 100 % count;
  return Array.from({ length: count }, (_, i) => (i < rem ? base + 1 : base));
}

/**
 * Строки таблицы одного потока.
 * Доля живой строки — всегда та, что стоит в Keitaro (после «Обновить из
 * Кейтаро» она меняется молча, даже если в потоке есть черновик); ручные
 * веса, выставленные в Keitaro, мы не пересчитываем на своей стороне.
 * Строка с pending-remove остаётся на своём месте с прочерком.
 * Офер, которого в Keitaro ещё нет (новый черновик или возврат из архива),
 * получает средний вес живых — ровно ту долю, которую ему даст отправка.
 * Возвращаемый из архива офер рисуется в СВОЕЙ архивной позиции — наверх
 * не переезжает и при отмене не прыгает обратно. Наверх уходят только
 * новые черновики (pending add без записи в архиве): после живых строк,
 * перед архивом, в порядке добавления. Архивные строки идут в порядке
 * архива и доли не показывают.
 */
export function computeStreamRows(
  stream: Stream,
  streamPending: PendingRow[],
  streamArchive: ArchivedEntry[],
  offersMap: Map<number, Offer | null>,
): StreamRow[] {
  const entries: StreamOfferEntry[] = Array.isArray(stream.offers) ? stream.offers : [];
  const removes = new Set(
    streamPending.filter((p) => p.action === 'remove').map((p) => p.offer_id),
  );
  const adds = streamPending.filter((p) => p.action === 'add');
  const addIds = new Set(adds.map((p) => p.offer_id));
  // Возвращаемые из архива: pending add + запись в архиве → позиция из архива.
  const restored = new Set(streamArchive.filter((a) => addIds.has(a.offer_id)).map((a) => a.offer_id));
  // Новые черновики — pending add без записи в архиве.
  const drafts = adds.filter((p) => !restored.has(p.offer_id));

  // Веса живых оферов, которые остаются в потоке: только они участвуют
  // в расчёте доли для добавляемых строк.
  const liveShares = entries
    .filter((e) => !removes.has(e.offer_id))
    .map((e) => e.share)
    .filter((s): s is number => typeof s === 'number');

  // Доли добавляемых: свои веса идут в порядке добавления.
  const addShareValues = addedShares(liveShares, adds.length);
  const addShares = new Map<number, number | null>();
  adds.forEach((p, i) => addShares.set(p.offer_id, addShareValues[i] ?? null));

  const rows: StreamRow[] = [];

  for (const entry of entries) {
    const isPendingRemove = removes.has(entry.offer_id);
    rows.push({
      stream,
      entry,
      offer: offersMap.get(entry.offer_id) ?? null,
      share: isPendingRemove ? null : typeof entry.share === 'number' ? entry.share : null,
      pendingAction: isPendingRemove ? 'remove' : null,
      isArchived: false,
      reason: null,
    });
  }

  for (const a of drafts) {
    rows.push({
      stream,
      entry: { offer_id: a.offer_id, state: null },
      offer: offersMap.get(a.offer_id) ?? null,
      share: addShares.get(a.offer_id) ?? null,
      pendingAction: 'add',
      isArchived: false,
      reason: null,
    });
  }

  for (const a of streamArchive) {
    if (restored.has(a.offer_id)) {
      // Возвращаемый офер: на архивной позиции, но живой — бейдж и цифра доли.
      rows.push({
        stream,
        entry: { offer_id: a.offer_id, state: a.state ?? null },
        offer: offersMap.get(a.offer_id) ?? null,
        share: addShares.get(a.offer_id) ?? null,
        pendingAction: 'add',
        isArchived: false,
        reason: null,
      });
      continue;
    }
    rows.push({
      stream,
      entry: { offer_id: a.offer_id, state: a.state ?? null },
      offer: offersMap.get(a.offer_id) ?? null,
      share: null,
      pendingAction: null,
      isArchived: true,
      reason: a.reason ?? null,
    });
  }

  return rows;
}

/** Бейдж ожидающего добавления: «вернётся в поток» для архивного офера, иначе «черновик». */
export function pendingAddBadgeText(
  streamId: number,
  offerId: number,
  archive: ArchivedEntry[],
): 'вернётся в поток' | 'черновик' {
  const fromArchive = archive.some(
    (a) => a.stream_id === streamId && a.offer_id === offerId,
  );
  return fromArchive ? 'вернётся в поток' : 'черновик';
}
