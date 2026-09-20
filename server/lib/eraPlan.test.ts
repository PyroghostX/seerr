import { groupSeasonsByEra, orderSeasonsForSearch } from '@server/lib/eraPlan';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('orderSeasonsForSearch', () => {
  it('searches first and last seasons first, then the middle in order', () => {
    assert.deepStrictEqual(
      orderSeasonsForSearch([1, 2, 3, 4, 5]),
      [1, 5, 2, 3, 4]
    );
  });

  it('returns a single season unchanged', () => {
    assert.deepStrictEqual(orderSeasonsForSearch([3]), [3]);
  });

  it('returns two seasons unchanged', () => {
    assert.deepStrictEqual(orderSeasonsForSearch([2, 7]), [2, 7]);
  });

  it('removes duplicates', () => {
    assert.deepStrictEqual(orderSeasonsForSearch([1, 2, 2, 1, 3]), [1, 3, 2]);
  });
});

describe('groupSeasonsByEra', () => {
  it('splits seasons into oldest-first groups when the resolver differs by year', () => {
    const seasons = [
      { seasonNumber: 1, year: 2005 },
      { seasonNumber: 2, year: 2005 },
      { seasonNumber: 3, year: 2015 },
      { seasonNumber: 4, year: 2015 },
    ];
    const resolveProfile = (year: number | null) =>
      year !== null && year <= 2010 ? 3 : null;

    const groups = groupSeasonsByEra(seasons, resolveProfile);

    assert.strictEqual(groups.length, 2);
    assert.deepStrictEqual(groups[0], {
      profileId: 3,
      seasons: [1, 2],
      minYear: 2005,
    });
    assert.deepStrictEqual(groups[1], {
      profileId: null,
      seasons: [3, 4],
      minYear: 2015,
    });
  });

  it('puts a single group together when every season resolves the same profile', () => {
    const seasons = [
      { seasonNumber: 1, year: null },
      { seasonNumber: 2, year: null },
      { seasonNumber: 3, year: null },
    ];
    const resolveProfile = () => null;

    const groups = groupSeasonsByEra(seasons, resolveProfile);

    assert.strictEqual(groups.length, 1);
    assert.deepStrictEqual(groups[0], {
      profileId: null,
      seasons: [1, 2, 3],
      minYear: Infinity,
    });
  });
});
