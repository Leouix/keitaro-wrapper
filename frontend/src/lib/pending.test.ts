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
  it('потоки с содержимым вперёд, порядок внутри групп сохранён', () => {
    const a = stream(1, []);
    const b = stream(2, [5]);
    const c = stream(3, []);
    const d = stream(4, [6]);
    expect(sortedStreams([a, b, c, d], [], []).map((s) => s.id)).toEqual([2, 4, 1, 3]);
  });

  it('кампания 212502: все live пустые, архив+pending remove поднимают потоки, пустой — внизу', () => {
    // Flow 3 (1313478) и Flow 2 (1313230) — архивные строки и pending-удаления;
    // Flow 1 (1313229) — нечего показывать. Сервер отдаёт порядок 3, 1, 2.
    const flow1 = stream(1313229, []);
    const flow2 = stream(1313230, []);
    const flow3 = stream(1313478, []);
    const streams = [flow3, flow1, flow2];
    const pending = [row(1313478, 9901, 'remove'), row(1313230, 9902, 'remove')];
    const archive = [
      { stream_id: 1313478, offer_id: 8801 },
      { stream_id: 1313230, offer_id: 8802 },
    ];
    expect(sortedStreams(streams, pending, archive).map((s) => s.id)).toEqual([
      1313478, 1313230, 1313229,
    ]);
  });

  it('архив, отменённый pending-add на тот же оффер, карточку не поднимает', () => {
    const a = stream(1, []);
    const b = stream(2, []);
    const pending = [row(1, 10, 'add')];
    const archive = [
      { stream_id: 1, offer_id: 10 },
      { stream_id: 2, offer_id: 20 },
    ];
    // у потока 1 архив погашен pending-add → пустой; у потока 2 архив жив → вперёд
    expect(sortedStreams([a, b], pending, archive).map((s) => s.id)).toEqual([2, 1]);
  });

  it('поток с одним pending-add и больше ничего остаётся внизу', () => {
    const a = stream(1, []);
    const b = stream(2, [5]);
    const pending = [row(1, 10, 'add')];
    expect(sortedStreams([a, b], pending, []).map((s) => s.id)).toEqual([2, 1]);
  });
});
