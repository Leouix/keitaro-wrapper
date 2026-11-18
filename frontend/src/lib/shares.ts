import type { ArchivedEntry, Offer, PendingRow, PinRow, Stream, StreamOfferEntry } from '../api/types';

/** Строка таблицы оферов потока — то, что рисует OfferRow. */
export interface StreamRow {
  stream: Stream;
  entry: { offer_id: number; state?: string | null };
  offer: Offer | null;
  /** null → доля не определена (прочерк «—»). */
  share: number | null;
  /** У офера зафиксирован вес (кнопка-пин нажата). */
  pinned: boolean;
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
 * получает вес по пинам:
 *  - пин на этом офере — его зафиксированный вес (если офер в финальном
 *    составе один, вес сбрасывается на 100: одному достаётся весь трафик);
 *  - пинов в потоке нет — как раньше, addedShares (средний вес живых);
 *  - пины есть — равное деление (100 − Σ зафиксированных весов) между всеми
 *    незапаянными оферами финального состава (живые − remove + add),
 *    остаток — первому по порядку; живые строки при этом продолжают
 *    показывать свои веса из Keitaro.
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
  streamPins: PinRow[] = [],
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
  // в расчёте доли для добавляемых строк без пинов.
  const liveShares = entries
    .filter((e) => !removes.has(e.offer_id))
    .map((e) => e.share)
    .filter((s): s is number => typeof s === 'number');

  // Доли добавляемых без пинов: свои веса идут в порядке добавления.
  const addShareValues = addedShares(liveShares, adds.length);
  const addShares = new Map<number, number | null>();
  adds.forEach((p, i) => addShares.set(p.offer_id, addShareValues[i] ?? null));

  // Пины потока: offer_id → зафиксированный вес.
  const pinsByOffer = new Map(streamPins.map((p) => [p.offer_id, p.share] as const));

  // Финальный состав потока в порядке отображения: живые − remove, затем
  // добавления в порядке pending. Только он участвует в делении с пинами:
  // пин на удаляемом (или уже удалённом) офере вес не держит.
  const finalIds = [
    ...entries.filter((e) => !removes.has(e.offer_id)).map((e) => e.offer_id),
    ...adds.map((p) => p.offer_id),
  ];

  // Равное деление остатка (100 − Σ пинов финального состава) между
  // незапаянными оферами; остаток — первому по порядку. Актуально только
  // когда в потоке есть хотя бы один пин.
  const division = new Map<number, number>();
  if (streamPins.length > 0) {
    const pinnedSum = finalIds.reduce((acc, id) => acc + (pinsByOffer.get(id) ?? 0), 0);
    const unpinned = finalIds.filter((id) => !pinsByOffer.has(id));
    if (unpinned.length > 0) {
      const remaining = Math.max(0, 100 - pinnedSum);
      const base = Math.floor(remaining / unpinned.length);
      const rem = remaining % unpinned.length;
      unpinned.forEach((id, i) => division.set(id, i < rem ? base + 1 : base));
    }
  }

  /** Доля добавляемой строки на экране — по правилам пинов (см. выше). */
  const addDisplayShare = (offerId: number): number | null => {
    const pin = pinsByOffer.get(offerId);
    if (pin != null) {
      // Единственный офер финального состава: вес сбрасывается на 100.
      return finalIds.length === 1 ? 100 : pin;
    }
    if (streamPins.length === 0) return addShares.get(offerId) ?? null;
    return division.get(offerId) ?? null;
  };

  const rows: StreamRow[] = [];

  for (const entry of entries) {
    const isPendingRemove = removes.has(entry.offer_id);
    rows.push({
      stream,
      entry,
      offer: offersMap.get(entry.offer_id) ?? null,
      share: isPendingRemove ? null : typeof entry.share === 'number' ? entry.share : null,
      pinned: !isPendingRemove && pinsByOffer.has(entry.offer_id),
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
      share: addDisplayShare(a.offer_id),
      pinned: pinsByOffer.has(a.offer_id),
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
        share: addDisplayShare(a.offer_id),
        pinned: pinsByOffer.has(a.offer_id),
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
      pinned: false,
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
): 'will return' | 'draft' {
  const fromArchive = archive.some(
    (a) => a.stream_id === streamId && a.offer_id === offerId,
  );
  return fromArchive ? 'will return' : 'draft';
}
