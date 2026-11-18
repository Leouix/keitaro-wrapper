import { describe, expect, it } from 'vitest';
import type { ArchivedEntry, Offer, PendingRow, Stream } from '../api/types';
import { addedShares, computeStreamRows } from './shares';

function stream(offers: Array<[number, number | null]>, id = 1): Stream {
  return {
    id,
    name: `Flow ${id}`,
    schema: 'landings',
    offers: offers.map(([offer_id, share]) => ({ offer_id, share, state: 'active' })),
  };
}

function pending(rows: Array<[number, 'add' | 'remove']>, streamId = 1): PendingRow[] {
  return rows.map(([offer_id, action]) => ({ stream_id: streamId, offer_id, action, created_at: null }));
}

const offers = (ids: number[]): Map<number, Offer | null> =>
  new Map(ids.map((id) => [id, { id, name: `Offer ${id}`, state: 'active', payout_value: 5, payout_currency: 'USD' }]));

describe('addedShares', () => {
  it('при живых весах новый офер получает средний вес: 4×25 -> 25', () => {
    expect(addedShares([25, 25, 25, 25], 1)).toEqual([25]);
    expect(addedShares([40, 30, 20, 10], 1)).toEqual([25]);
  });

  it('пустой поток: 100 делится с доборкой остатка первым строкам (3 -> 34/33/33)', () => {
    expect(addedShares([], 3)).toEqual([34, 33, 33]);
    expect(addedShares([], 4)).toEqual([25, 25, 25, 25]);
  });

  it('count <= 0 → пусто', () => {
    expect(addedShares([25], 0)).toEqual([]);
    expect(addedShares([], -1)).toEqual([]);
  });
});

describe('computeStreamRows — без pending', () => {
  it('живые строки со своими долями, архив после живых', () => {
    const rows = computeStreamRows(
      stream([
        [10, 60],
        [11, 40],
      ]),
      [],
      [{ stream_id: 1, offer_id: 12, state: 'active', reason: 'user' }],
      offers([10, 11, 12]),
    );
    expect(rows.map((r) => [r.entry.offer_id, r.share, r.pendingAction, r.isArchived])).toEqual([
      [10, 60, null, false],
      [11, 40, null, false],
      [12, null, null, true],
    ]);
  });

  it('доля null у живой строки рисуется прочерком', () => {
    const rows = computeStreamRows(stream([[10, null]]), [], [], offers([10]));
    expect(rows[0].share).toBeNull();
  });
});

describe('computeStreamRows — с pending', () => {
  it('remove: доля прочерк, живые показывают свои веса из Keitaro', () => {
    // live: 10, 11, 12 (34/33/33), remove 10 → строка 10 на месте с «—»,
    // остальные держат веса Keitaro и не пересчитываются локально.
    const rows = computeStreamRows(
      stream([
        [10, 34],
        [11, 33],
        [12, 33],
      ]),
      pending([[10, 'remove']]),
      [],
      offers([10, 11, 12]),
    );
    expect(rows.map((r) => [r.entry.offer_id, r.share, r.pendingAction])).toEqual([
      [10, null, 'remove'],
      [11, 33, null],
      [12, 33, null],
    ]);
  });

  it('remove + add: живые держат веса Keitaro, новый получает средний вес', () => {
    // live: 10, 11, 12; remove 10, add 20 → живые 11 (33) и 12 (33) не меняются,
    // новый 20 получает средний вес живых — 33.
    const rows = computeStreamRows(
      stream([
        [10, 34],
        [11, 33],
        [12, 33],
      ]),
      pending([
        [10, 'remove'],
        [20, 'add'],
      ]),
      [],
      offers([10, 11, 12, 20]),
    );
    expect(rows.map((r) => [r.entry.offer_id, r.share, r.pendingAction])).toEqual([
      [10, null, 'remove'],
      [11, 33, null],
      [12, 33, null],
      [20, 33, 'add'],
    ]);
  });

  it('добавление архивного офера: строка одна, бейдж «вернётся в поток», архив не дублируется', () => {
    const archive: ArchivedEntry[] = [
      { stream_id: 1, offer_id: 20, state: 'active', reason: 'user' },
    ];
    const rows = computeStreamRows(stream([[10, 100]]), pending([[20, 'add']]), archive, offers([10, 20]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ entry: { offer_id: 10 }, share: 100, pendingAction: null });
    expect(rows[1]).toMatchObject({
      entry: { offer_id: 20, state: 'active' },
      share: 100,
      pendingAction: 'add',
      isArchived: false,
    });
  });

  it('pending на пустом потоке: только добавления, доли пересчитаны', () => {
    const rows = computeStreamRows(stream([]), pending([[7, 'add']]), [], offers([7]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ share: 100, pendingAction: 'add' });
  });

  it('без pending доли НЕ пересчитываются даже если похожи на неровные', () => {
    const rows = computeStreamRows(
      stream([
        [10, 34],
        [11, 33],
        [12, 33],
      ]),
      [],
      [],
      offers([10, 11, 12]),
    );
    expect(rows.map((r) => r.share)).toEqual([34, 33, 33]);
  });

  it('архивная строка рисует state из архива и reason', () => {
    const rows = computeStreamRows(
      stream([]),
      [],
      [{ stream_id: 1, offer_id: 30, state: 'paused', reason: 'keitaro' }],
      offers([30]),
    );
    expect(rows[0]).toMatchObject({
      isArchived: true,
      reason: 'keitaro',
      entry: { state: 'paused' },
      share: null,
    });
  });

  // Кейс кампании 212502: архив Flow 2 сверху вниз, Bring Back последней строки.
  it('212502: Bring Back архивной строки не меняет порядок, у строки бейдж add и доля', () => {
    const archive: ArchivedEntry[] = [4517, 25327, 4516, 24800, 23142, 4514, 4440].map(
      (offer_id) => ({ stream_id: 1, offer_id, state: 'active', reason: 'user' }),
    );
    const rows = computeStreamRows(stream([]), pending([[4440, 'add']]), archive, offers([4517, 25327, 4516, 24800, 23142, 4514, 4440]));
    expect(rows.map((r) => r.entry.offer_id)).toEqual([4517, 25327, 4516, 24800, 23142, 4514, 4440]);
    expect(rows[6]).toMatchObject({
      entry: { offer_id: 4440 },
      pendingAction: 'add',
      isArchived: false,
      share: 100,
    });
    expect(rows.slice(0, 6).every((r) => r.isArchived && r.pendingAction === null && r.share === null)).toBe(true);
  });

  it('212502: отмена — строка остаётся на месте, снова архивная без доли', () => {
    const archive: ArchivedEntry[] = [4517, 25327, 4516, 24800, 23142, 4514, 4440].map(
      (offer_id) => ({ stream_id: 1, offer_id, state: 'active', reason: 'user' }),
    );
    const rows = computeStreamRows(stream([]), [], archive, offers([4517, 25327, 4516, 24800, 23142, 4514, 4440]));
    expect(rows.map((r) => r.entry.offer_id)).toEqual([4517, 25327, 4516, 24800, 23142, 4514, 4440]);
    expect(rows[6]).toMatchObject({
      entry: { offer_id: 4440 },
      pendingAction: null,
      isArchived: true,
      share: null,
    });
  });

  it('возвращаемый из архива офер рисуется на архивной позиции, не сразу после живых', () => {
    const archive: ArchivedEntry[] = [
      { stream_id: 1, offer_id: 20, state: 'active', reason: 'user' },
      { stream_id: 1, offer_id: 30, state: 'active', reason: 'user' },
    ];
    const rows = computeStreamRows(stream([[10, 100]]), pending([[30, 'add']]), archive, offers([10, 20, 30]));
    expect(rows.map((r) => [r.entry.offer_id, r.share, r.pendingAction, r.isArchived])).toEqual([
      [10, 100, null, false],
      [20, null, null, true],
      [30, 100, 'add', false],
    ]);
  });
});
