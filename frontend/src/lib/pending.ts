import type { ArchivedEntry, PendingRow, PinRow, Stream } from '../api/types';

/** Ожидающие изменения одного потока. */
export function pendingForStream(pending: PendingRow[], streamId: number): PendingRow[] {
  return pending.filter((p) => p.stream_id === streamId);
}

/** Зафиксированные веса (пины) одного потока. */
export function pinsForStream(pins: PinRow[], streamId: number): PinRow[] {
  return pins.filter((p) => p.stream_id === streamId);
}

/** Полный набор ожидающих изменений потока — тело PUT .../pending. */
export function pendingBody(
  streamPending: PendingRow[],
): { add: number[]; remove: number[] } {
  return {
    add: streamPending.filter((p) => p.action === 'add').map((p) => p.offer_id),
    remove: streamPending.filter((p) => p.action === 'remove').map((p) => p.offer_id),
  };
}

/** Заменить ожидающие изменения потока на новый набор (замена по PUT-ответу). */
export function replacePendingForStream(
  pending: PendingRow[],
  streamId: number,
  rows: PendingRow[],
): PendingRow[] {
  return [...pending.filter((p) => p.stream_id !== streamId), ...rows];
}

/**
 * Потоки, по которым уйдёт apply: сначала в порядке списка потоков,
 * поток вне списка (редкий случай) — в конец (apply проверяет кампанию
 * по самому потоку).
 */
export function applyTargetIds(streams: Stream[], pending: PendingRow[]): number[] {
  const targets = streams
    .filter((s) => pending.some((p) => p.stream_id === s.id))
    .map((s) => s.id);
  const known = new Set(targets);
  for (const sid of new Set(pending.map((p) => p.stream_id))) {
    if (!known.has(sid)) targets.push(sid);
  }
  return targets;
}

/** Итог по оферам потока после отправки: живые − ожидающие удаления + ожидающие добавления. */
export function streamOfferTotal(
  stream: Stream | undefined,
  streamPending: PendingRow[],
): number {
  const live = Array.isArray(stream?.offers) ? stream!.offers!.length : 0;
  const adds = streamPending.filter((p) => p.action === 'add').length;
  const removes = streamPending.filter((p) => p.action === 'remove').length;
  return live - removes + adds;
}

/** Потоки, которые после отправки останутся без оферов (для предупреждения). */
export function emptyStreamTargets(streams: Stream[], pending: PendingRow[]): number[] {
  return applyTargetIds(streams, pending).filter(
    (sid) => streamOfferTotal(streams.find((s) => s.id === sid), pendingForStream(pending, sid)) <= 0,
  );
}

/**
 * Потоки с содержимым вперёд, пустые — внизу; внутри групп порядок сервера
 * сохраняется (stable sort). «С содержимым» — то, что реально видно в карточке:
 * есть живые офферы, или pending-удаления, или архивные строки, не отменённые
 * pending-add на тот же оффер. Поток, у которого только pending-add и больше
 * ничего, остаётся внизу: иначе секция прыгает наверх, пока в неё добавляют офер.
 */
export function sortedStreams(
  streams: Stream[],
  pending: PendingRow[],
  archive: ArchivedEntry[],
): Stream[] {
  const hasContent = new Set(
    streams
      .filter((s) => {
        const streamPending = pendingForStream(pending, s.id);
        const liveArchive = archive.filter(
          (a) =>
            a.stream_id === s.id &&
            !streamPending.some((p) => p.action === 'add' && p.offer_id === a.offer_id),
        );
        return (
          (Array.isArray(s.offers) && s.offers.length > 0) ||
          streamPending.some((p) => p.action === 'remove') ||
          liveArchive.length > 0
        );
      })
      .map((s) => s.id),
  );
  return [...streams].sort(
    (a, b) => (hasContent.has(b.id) ? 1 : 0) - (hasContent.has(a.id) ? 1 : 0),
  );
}

/** Имя потока: name или «Поток {id}». */
export function streamName(s: Pick<Stream, 'id' | 'name'>): string {
  return (s && s.name) || `Поток ${s.id}`;
}
