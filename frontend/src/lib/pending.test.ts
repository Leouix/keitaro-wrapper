import { describe, expect, it } from 'vitest';
import type { PendingRow, Stream } from '../api/types';
import {
  applyTargetIds,
  emptyStreamTargets,
  pendingBody,
  pendingForStream,
  replacePendingForStream,
  sortedStreams,
  streamOfferTotal,
} from './pending';

const row = (stream_id: number, offer_id: number, action: 'add' | 'remove'): PendingRow => ({
  stream_id,
  offer_id,
  action,
  created_at: null,
});

const stream = (id: number, offerIds: number[]): Stream => ({
  id,
  offers: offerIds.map((offer_id) => ({ offer_id, share: null })),
});

describe('pendingBody', () => {
  it('раскладывает по action и сохраняет порядок', () => {
    expect(
      pendingBody([row(1, 5, 'remove'), row(1, 7, 'add'), row(1, 9, 'add'), row(2, 3, 'add')]),
    ).toEqual({ add: [7, 9, 3], remove: [5] });
  });

  it('пустой набор → пустые списки (обязательны для PUT)', () => {
    expect(pendingBody([])).toEqual({ add: [], remove: [] });
  });
});

describe('replacePendingForStream', () => {
  it('заменяет набор потока целиком, чужие не трогает', () => {
    const base = [row(1, 5, 'remove'), row(2, 8, 'add')];
    const next = replacePendingForStream(base, 1, [row(1, 6, 'add')]);
    expect(next).toEqual([row(2, 8, 'add'), row(1, 6, 'add')]);
  });
});

describe('pendingForStream / applyTargetIds / streamOfferTotal', () => {
  const streams = [stream(1, [10, 11]), stream(2, []), stream(3, [30])];
  const p = [row(3, 31, 'add'), row(99, 1, 'add')];

  it('pendingForStream фильтрует по потоку', () => {
    expect(pendingForStream(p, 3)).toEqual([row(3, 31, 'add')]);
  });

  it('applyTargetIds: порядок списка потоков, неизвестный поток — в конец', () => {
    expect(applyTargetIds(streams, p)).toEqual([3, 99]);
  });

  it('streamOfferTotal: live − remove + add', () => {
    expect(streamOfferTotal(stream(1, [10, 11]), [row(1, 10, 'remove'), row(1, 12, 'add')])).toBe(2);
    expect(streamOfferTotal(stream(2, []), [row(2, 5, 'add')])).toBe(1);
    expect(streamOfferTotal(stream(2, []), [row(2, 5, 'add'), row(2, 6, 'add')])).toBe(2);
    expect(streamOfferTotal(undefined, [])).toBe(0);
  });

  it('emptyStreamTargets: только потоки с нулевым итогом', () => {
    // поток 1: 2 живых, remove 10, add 12 → 2 (не пустой); поток 2: 0 живых, нет pending → нет apply; поток 3: 1 живой, remove 30 → 0
    const cases = [row(1, 10, 'remove'), row(1, 12, 'add'), row(3, 30, 'remove')];
    expect(emptyStreamTargets(streams, cases)).toEqual([3]);
  });
});

describe('sortedStreams', () => {
  it('потоки с оферами вперёд, порядок внутри групп сохранён', () => {
    const a = stream(1, []);
    const b = stream(2, [5]);
    const c = stream(3, []);
    const d = stream(4, [6]);
    expect(sortedStreams([a, b, c, d]).map((s) => s.id)).toEqual([2, 4, 1, 3]);
  });
});
