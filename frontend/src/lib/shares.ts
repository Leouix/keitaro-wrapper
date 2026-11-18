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
 * Доли при наличии ожидающих изменений: base = floor(100/n),
 * остаток добирается первым строкам итогового набора (3 офера → 34/33/33).
 * total <= 0 → пересчитывать нечего.
 */
export function recalculateShares(total: number): number[] | null {
  if (total <= 0) return null;
  const base = Math.floor(100 / total);
  const rem = 100 % total;
  return Array.from({ length: total }, (_, i) => (i < rem ? base + 1 : base));
}

/**
 * Строки таблицы одного потока.
 * Итоговый набор (для долей) = живые оферы без pending-remove плюс
 * pending-add в порядке добавления («вернётся в поток» и черновик).
 * Позиции уже существующих строк фиксированы: строка с pending-remove
 * остаётся на своём месте среди живых; офер, возвращаемый из архива
 * (pending add + запись в архиве), рисуется в СВОЕЙ архивной позиции —
 * наверх не переезжает и при отмене не прыгает обратно. Наверх уходят
 * только новые черновики (pending add без записи в архиве): после живых
 * строк, перед архивом, в порядке добавления. Архивные строки идут
 * в порядке архива, в пересчёте долей не участвуют и не дублируют
 * pending-add. Пока у потока есть ожидающие изменения — доли пересчитаны
 * локально; без них каждая живая строка показывает свою долю с сервера.
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

  const liveCount = entries.filter((e) => !removes.has(e.offer_id)).length;
  const total = liveCount + adds.length;
  const recalculated = streamPending.length > 0 ? recalculateShares(total) : null;

  // Доли итогового набора «живые → добавляемые»: раздаём заранее,
  // чтобы возвращаемая строка получила свою цифру на архивной позиции.
  const addShares = new Map<number, number | null>();
  let fi = liveCount;
  for (const p of adds) addShares.set(p.offer_id, recalculated ? (recalculated[fi++] ?? null) : null);

  const rows: StreamRow[] = [];
  let idx = 0;

  for (const entry of entries) {
    const isPendingRemove = removes.has(entry.offer_id);
    rows.push({
      stream,
      entry,
      offer: offersMap.get(entry.offer_id) ?? null,
      share: isPendingRemove
        ? null
        : recalculated
          ? (recalculated[idx++] ?? null)
          : entry.share == null
            ? null
            : entry.share,
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
      share: recalculated ? (addShares.get(a.offer_id) ?? null) : null,
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
        share: recalculated ? (addShares.get(a.offer_id) ?? null) : null,
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
