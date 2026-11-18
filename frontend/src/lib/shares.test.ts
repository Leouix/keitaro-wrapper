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
  it('with live weights a new offer gets the mean weight: 4×25 -> 25', () => {
    expect(addedShares([25, 25, 25, 25], 1)).toEqual([25]);
    expect(addedShares([40, 30, 20, 10], 1)).toEqual([25]);
  });

  it('empty flow: 100 is split with the remainder topping up the first rows (3 -> 34/33/33)', () => {
    expect(addedShares([], 3)).toEqual([34, 33, 33]);
    expect(addedShares([], 4)).toEqual([25, 25, 25, 25]);
  });

  it('count <= 0 → empty', () => {
    expect(addedShares([25], 0)).toEqual([]);
    expect(addedShares([], -1)).toEqual([]);
  });
});

/**
 * Таблица кейсов пинов (паритет с бэкендом Lin) — финальный состав:
 * живые − remove + add. Деление остатка (100 − Σ пинов) между незапаянными,
 * остаток — первому по порядку; пин на единственном офере сбрасывается на 100.
 */
describe('computeStreamRows — with pins', () => {
  it('no pins — as before: the added offer gets the mean of the live weights', () => {
    const rows = computeStreamRows(
      stream([
        [10, 60],
        [11, 40],
      ]),
      pending([[20, 'add']]),
      [],
      offers([10, 11, 20]),
      [],
    );
    expect(rows.map((r) => [r.entry.offer_id, r.share, r.pinned])).toEqual([
      [10, 60, false],
      [11, 40, false],
      [20, 50, false], // mean of the live weights
    ]);
  });

  it('one pin: the unpinned split the remainder equally, the remainder goes to the first', () => {
    // final set: 10 (pin 60), 11, 20 (add). The remainder 40 → 11 and 20 get 20 each.
    const rows = computeStreamRows(
      stream([
        [10, 60],
        [11, 40],
      ]),
      pending([[20, 'add']]),
      [],
      offers([10, 11, 20]),
      [{ stream_id: 1, offer_id: 10, share: 60 }],
    );
    expect(rows.map((r) => [r.entry.offer_id, r.share, r.pinned])).toEqual([
      [10, 60, true], // live row — the Keitaro weight, the pin is visible
      [11, 40, false], // live row — the Keitaro weight
      [20, 20, false], // the added one gets 40 / 2
    ]);
  });

  it('two pins: the remainder is split between the unpinned', () => {
    // pins 50 + 30 = 80, the remainder 20 → offers 12 and 20 (add) get 10 each.
    const rows = computeStreamRows(
      stream([
        [10, 50],
        [11, 30],
        [12, 20],
      ]),
      pending([[20, 'add']]),
      [],
      offers([10, 11, 12, 20]),
      [
        { stream_id: 1, offer_id: 10, share: 50 },
        { stream_id: 1, offer_id: 11, share: 30 },
      ],
    );
    expect(rows.map((r) => [r.entry.offer_id, r.share, r.pinned])).toEqual([
      [10, 50, true],
      [11, 30, true],
      [12, 20, false], // живая строка — вес из Keitaro
      [20, 10, false], // the added one gets 20 / 2
    ]);
  });

  it('a pin on the added offer: the pinned weight is shown', () => {
    // add 20 is pinned at 33; no unpinned offers in the final set (10,11,12 are live,
    // their Keitaro weights 34/33/33 are not recalculated) → nothing to split.
    const rows = computeStreamRows(
      stream([
        [10, 34],
        [11, 33],
        [12, 33],
      ]),
      pending([[20, 'add']]),
      [],
      offers([10, 11, 12, 20]),
      [{ stream_id: 1, offer_id: 20, share: 33 }],
    );
    expect(rows.map((r) => [r.entry.offer_id, r.share, r.pinned])).toEqual([
      [10, 34, false],
      [11, 33, false],
      [12, 33, false],
      [20, 33, true],
    ]);
  });

  it('removing a pinned offer: its weight is released and split again', () => {
    // live 10/11/12 (34/33/33), a pin on 10, remove 10, add 20:
    // the final set is 11, 12, 20 without pins → 100 is split 33/33/34.
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
      [{ stream_id: 1, offer_id: 10, share: 34 }],
    );
    expect(rows.map((r) => [r.entry.offer_id, r.share, r.pinned, r.pendingAction])).toEqual([
      [10, null, false, 'remove'], // the row stays with a dash
      [11, 33, false, null], // живые показывают веса Keitaro
      [12, 33, false, null],
      [20, 33, false, 'add'], // remainder 100 / 3: the first (live 11) gets 34, the added one 33
    ]);
  });

  it('one offer left: the weight resets to 100 even if it was pinned', () => {
    // empty live list, add 20 pinned at 40 — it is the only one in the final set.
    const rows = computeStreamRows(
      stream([]),
      pending([[20, 'add']]),
      [],
      offers([20]),
      [{ stream_id: 1, offer_id: 20, share: 40 }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entry: { offer_id: 20 }, share: 100, pinned: true });
  });

  it('100 for three with one pin: the pin keeps its weight, the rest split equally', () => {
    // empty flow, three additions: 20 pinned at 40 → 21 and 22 get 30 each.
    const rows = computeStreamRows(
      stream([]),
      pending([
        [20, 'add'],
        [21, 'add'],
        [22, 'add'],
      ]),
      [],
      offers([20, 21, 22]),
      [{ stream_id: 1, offer_id: 20, share: 40 }],
    );
    expect(rows.map((r) => [r.entry.offer_id, r.share, r.pinned])).toEqual([
      [20, 40, true],
      [21, 30, false],
      [22, 30, false],
    ]);
  });
});

describe('computeStreamRows — without pending', () => {
  it('live rows with their own shares, the archive after the live ones', () => {
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

  it('a null share of a live row is rendered as a dash', () => {
    const rows = computeStreamRows(stream([[10, null]]), [], [], offers([10]));
    expect(rows[0].share).toBeNull();
  });
});

describe('computeStreamRows — with pending', () => {
  it('remove: a dash share, the live rows keep their Keitaro weights', () => {
    // live: 10, 11, 12 (34/33/33), remove 10 → row 10 stays with a "—",
    // the others keep their Keitaro weights and are not recalculated locally.
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

  it('remove + add: the live rows keep their Keitaro weights, the new one gets the mean weight', () => {
    // live: 10, 11, 12; remove 10, add 20 → the live 11 (33) and 12 (33) are unchanged,
    // the new 20 gets the mean of the live weights — 33.
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

  it('adding an archived offer: a single row, the "will return" badge, the archive is not duplicated', () => {
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

  it('pending on an empty flow: additions only, the shares are recalculated', () => {
    const rows = computeStreamRows(stream([]), pending([[7, 'add']]), [], offers([7]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ share: 100, pendingAction: 'add' });
  });

  it('without pending the shares are NOT recalculated even if they look uneven', () => {
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

  it('an archived row renders the state from the archive and the reason', () => {
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

  // Campaign 212502 case: the archive of Flow 2 top-down, Bring Back on the last row.
  it('212502: Bring Back of an archived row does not change the order, the row gets the add badge and a share', () => {
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

  it('212502: cancel — the row stays in place, archived again without a share', () => {
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

  it('an offer returned from the archive is rendered at its archived position, not right after the live ones', () => {
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
