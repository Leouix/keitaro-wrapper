import type { PendingRow, Stream } from '../api/types';

/** Ожидающие изменения одного потока. */
export function pendingForStream(pending: PendingRow[], streamId: number): PendingRow[] {
  return pending.filter((p) => p.stream_id === streamId);
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
 * Потоки с оферами вперёд, пустые — внизу; внутри групп порядок сервера
 * сохраняется (stable sort). Отложенные изменения порядок не двигают:
 * иначе секция прыгает наверх, пока в неё добавляют офер.
 */
export function sortedStreams(streams: Stream[]): Stream[] {
  const withOffers = new Set(
    streams.filter((s) => Array.isArray(s.offers) && s.offers.length > 0).map((s) => s.id),
  );
  return [...streams].sort(
    (a, b) => (withOffers.has(b.id) ? 1 : 0) - (withOffers.has(a.id) ? 1 : 0),
  );
}

/** Имя потока: name или «Поток {id}». */
export function streamName(s: Pick<Stream, 'id' | 'name'>): string {
  return (s && s.name) || `Поток ${s.id}`;
}
