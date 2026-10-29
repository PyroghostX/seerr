import type { TmdbTvDetails } from '@server/api/themoviedb/interfaces';
import { MediaStatus } from '@server/constants/media';
import type { MismatchRow } from '@server/lib/availabilityMismatch';
import {
  findSeasonMismatches,
  reconcileMismatches,
  rollUpShowStatus,
  shouldMarkSeasonAvailable,
} from '@server/lib/availabilityMismatch';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const NOW = new Date('2026-10-28T15:00:00Z');

const sonarrSeason = (seasonNumber: number, episodeFileCount: number) => ({
  seasonNumber,
  statistics: {
    episodeFileCount,
    episodeCount: episodeFileCount,
    totalEpisodeCount: episodeFileCount,
    sizeOnDisk: 0,
    percentOfEpisodes: 100,
  },
});

const plexSeason = (index: number, leafCount: number) => ({
  index,
  leafCount,
});

function makeRow(overrides: Partial<MismatchRow> = {}): MismatchRow {
  return {
    id: 1,
    mediaId: 10,
    seasonNumber: 5,
    plexEpisodes: 12,
    sonarrEpisodes: 13,
    title: 'Show',
    status: 'open',
    ...overrides,
  };
}

const finding = (
  overrides: Partial<MismatchRow> = {}
): Omit<MismatchRow, 'id' | 'status'> => ({
  mediaId: 10,
  seasonNumber: 5,
  plexEpisodes: 12,
  sonarrEpisodes: 13,
  title: 'Show',
  ...overrides,
});

const tvShow = (
  seasons: { season_number: number; episode_count: number }[],
  last?: { season_number: number; episode_number: number }
) =>
  ({
    last_episode_to_air: last ?? null,
    seasons: seasons.map((s) => ({ ...s, air_date: '2012-03-25' })),
  }) as unknown as Pick<TmdbTvDetails, 'last_episode_to_air' | 'seasons'>;

describe('findSeasonMismatches', () => {
  it('reports seasons where Plex shows fewer episodes than Sonarr has', () => {
    assert.deepEqual(
      findSeasonMismatches(
        [sonarrSeason(4, 13), sonarrSeason(5, 13), sonarrSeason(6, 13)],
        [plexSeason(4, 13), plexSeason(5, 12), plexSeason(6, 12)]
      ),
      [
        { seasonNumber: 5, plexEpisodes: 12, sonarrEpisodes: 13 },
        { seasonNumber: 6, plexEpisodes: 12, sonarrEpisodes: 13 },
      ]
    );
  });

  it('counts a season missing from Plex as 0', () => {
    assert.deepEqual(findSeasonMismatches([sonarrSeason(1, 8)], []), [
      { seasonNumber: 1, plexEpisodes: 0, sonarrEpisodes: 8 },
    ]);
  });

  it('counts a season missing from Sonarr as 0', () => {
    assert.deepEqual(findSeasonMismatches([], [plexSeason(2, 4)]), [
      { seasonNumber: 2, plexEpisodes: 4, sonarrEpisodes: 0 },
    ]);
  });

  it('ignores specials and seasons that match', () => {
    assert.deepEqual(
      findSeasonMismatches(
        [sonarrSeason(0, 3), sonarrSeason(1, 10), sonarrSeason(2, 0)],
        [plexSeason(0, 1), plexSeason(1, 10)]
      ),
      []
    );
  });
});

describe('reconcileMismatches', () => {
  const all = () => true;

  it('opens a new mismatch', () => {
    const { create, update } = reconcileMismatches([], [finding()], all, NOW);

    assert.deepEqual(create, [
      { ...finding(), status: 'open', firstSeenAt: NOW },
    ]);
    assert.deepEqual(update, []);
  });

  it('leaves an open row alone when nothing changed', () => {
    const { create, update } = reconcileMismatches(
      [makeRow()],
      [finding()],
      all,
      NOW
    );

    assert.deepEqual(create, []);
    assert.deepEqual(update, []);
  });

  it('updates the counts of an open row', () => {
    const { update } = reconcileMismatches(
      [makeRow()],
      [finding({ plexEpisodes: 11 })],
      all,
      NOW
    );

    assert.deepEqual(update, [
      { id: 1, changes: { plexEpisodes: 11, sonarrEpisodes: 13 } },
    ]);
  });

  it('keeps a fine row silent while the counts are the same', () => {
    const { create, update } = reconcileMismatches(
      [makeRow({ status: 'fine' })],
      [finding()],
      all,
      NOW
    );

    assert.deepEqual(create, []);
    assert.deepEqual(update, []);
  });

  it('reopens a fine row when the counts change', () => {
    const { update } = reconcileMismatches(
      [makeRow({ status: 'fine' })],
      [finding({ sonarrEpisodes: 14 })],
      all,
      NOW
    );

    assert.deepEqual(update, [
      {
        id: 1,
        changes: {
          status: 'open',
          plexEpisodes: 12,
          sonarrEpisodes: 14,
          firstSeenAt: NOW,
          resolvedAt: null,
          resolvedBy: null,
        },
      },
    ]);
  });

  for (const status of ['fixed', 'resolved'] as const) {
    it(`reopens a ${status} row that shows up again`, () => {
      const { update } = reconcileMismatches(
        [makeRow({ status })],
        [finding()],
        all,
        NOW
      );

      assert.equal(update.length, 1);
      assert.equal(update[0].changes.status, 'open');
      assert.equal(update[0].changes.firstSeenAt, NOW);
      assert.equal(update[0].changes.resolvedBy, null);
    });
  }

  it('resolves an open row whose season matches now', () => {
    const { update } = reconcileMismatches([makeRow()], [], all, NOW);

    assert.deepEqual(update, [
      {
        id: 1,
        changes: { status: 'resolved', resolvedAt: NOW, resolvedBy: null },
      },
    ]);
  });

  it('leaves open rows of shows the check did not cover', () => {
    const { update } = reconcileMismatches(
      [makeRow()],
      [],
      (mediaId) => mediaId !== 10,
      NOW
    );

    assert.deepEqual(update, []);
  });

  it('leaves fine and fixed rows alone when they match', () => {
    const { update } = reconcileMismatches(
      [makeRow({ status: 'fine' }), makeRow({ id: 2, status: 'fixed' })],
      [],
      all,
      NOW
    );

    assert.deepEqual(update, []);
  });

  it('only touches the season that changed', () => {
    const { create, update } = reconcileMismatches(
      [makeRow(), makeRow({ id: 2, seasonNumber: 6 })],
      [finding(), finding({ seasonNumber: 7 })],
      all,
      NOW
    );

    assert.deepEqual(
      create.map((row) => row.seasonNumber),
      [7]
    );
    assert.deepEqual(update, [
      {
        id: 2,
        changes: { status: 'resolved', resolvedAt: NOW, resolvedBy: null },
      },
    ]);
  });
});

describe('shouldMarkSeasonAvailable', () => {
  const show = tvShow(
    [
      { season_number: 5, episode_count: 13 },
      { season_number: 6, episode_count: 13 },
    ],
    { season_number: 6, episode_number: 13 }
  );

  it('marks a season whose aired episodes all have files', () => {
    assert.equal(
      shouldMarkSeasonAvailable(
        13,
        show,
        5,
        MediaStatus.PARTIALLY_AVAILABLE,
        NOW
      ),
      true
    );
  });

  it('skips a season Sonarr is still missing files for', () => {
    assert.equal(
      shouldMarkSeasonAvailable(
        12,
        show,
        5,
        MediaStatus.PARTIALLY_AVAILABLE,
        NOW
      ),
      false
    );
  });

  it('skips a season that is already available', () => {
    assert.equal(
      shouldMarkSeasonAvailable(13, show, 5, MediaStatus.AVAILABLE, NOW),
      false
    );
  });

  it('skips a season TMDB does not know', () => {
    assert.equal(shouldMarkSeasonAvailable(13, show, 9, undefined, NOW), false);
  });

  it('counts only aired episodes of the airing season', () => {
    const airing = tvShow([{ season_number: 2, episode_count: 10 }], {
      season_number: 2,
      episode_number: 4,
    });

    assert.equal(shouldMarkSeasonAvailable(4, airing, 2, undefined, NOW), true);
  });
});

describe('rollUpShowStatus', () => {
  const show = tvShow([
    { season_number: 0, episode_count: 2 },
    { season_number: 1, episode_count: 13 },
    { season_number: 2, episode_count: 13 },
  ]);

  it('is available once every aired season is', () => {
    assert.equal(
      rollUpShowStatus(
        [
          { seasonNumber: 1, status: MediaStatus.AVAILABLE },
          { seasonNumber: 2, status: MediaStatus.AVAILABLE },
        ],
        show,
        MediaStatus.PARTIALLY_AVAILABLE,
        NOW
      ),
      MediaStatus.AVAILABLE
    );
  });

  it('stays partially available while a season is missing', () => {
    assert.equal(
      rollUpShowStatus(
        [
          { seasonNumber: 1, status: MediaStatus.AVAILABLE },
          { seasonNumber: 2, status: MediaStatus.PARTIALLY_AVAILABLE },
        ],
        show,
        MediaStatus.PARTIALLY_AVAILABLE,
        NOW
      ),
      MediaStatus.PARTIALLY_AVAILABLE
    );
  });
});
