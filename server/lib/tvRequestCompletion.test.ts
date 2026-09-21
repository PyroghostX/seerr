import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type Season from '@server/entity/Season';
import { requestSeasonsSatisfied } from '@server/lib/tvRequestCompletion';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function makeRequest(
  is4k: boolean,
  seasons: { seasonNumber: number; status?: MediaRequestStatus }[]
): MediaRequest {
  return {
    is4k,
    seasons: seasons.map((season) => ({
      seasonNumber: season.seasonNumber,
      status: season.status ?? MediaRequestStatus.APPROVED,
    })),
  } as unknown as MediaRequest;
}

function makeSeason(
  seasonNumber: number,
  status: MediaStatus,
  is4k = false
): Season {
  return {
    seasonNumber,
    status: is4k ? MediaStatus.UNKNOWN : status,
    status4k: is4k ? status : MediaStatus.UNKNOWN,
  } as unknown as Season;
}

describe('requestSeasonsSatisfied', () => {
  it('completes the Law & Order request: season 27 available, season 28 unaired', () => {
    const request = makeRequest(false, [
      { seasonNumber: 27 },
      { seasonNumber: 28 },
    ]);
    const mediaSeasons = [makeSeason(27, MediaStatus.AVAILABLE)];
    const tvShow = {
      last_episode_to_air: { season_number: 27, episode_number: 24 },
      seasons: [
        { season_number: 27, episode_count: 24, air_date: '2025-09-25' },
        { season_number: 28, episode_count: 10, air_date: '2026-10-08' },
      ],
    };

    const result = requestSeasonsSatisfied(request, mediaSeasons, tvShow);

    assert.strictEqual(result.complete, true);
    assert.deepStrictEqual(result.availableSeasonNumbers, [27]);
  });

  it('does not complete when every requested season is unaired', () => {
    const request = makeRequest(false, [{ seasonNumber: 28 }]);
    const mediaSeasons: Season[] = [];
    const tvShow = {
      last_episode_to_air: { season_number: 27, episode_number: 24 },
      seasons: [
        { season_number: 28, episode_count: 10, air_date: '2026-10-08' },
      ],
    };

    const result = requestSeasonsSatisfied(request, mediaSeasons, tvShow);

    assert.strictEqual(result.complete, false);
    assert.deepStrictEqual(result.availableSeasonNumbers, []);
  });

  it('does not complete when an aired season is missing from media, even if another season is available', () => {
    const request = makeRequest(false, [
      { seasonNumber: 26 },
      { seasonNumber: 27 },
    ]);
    // Season 26 has aired (per TMDB) but has no Season row (not in Plex).
    const mediaSeasons = [makeSeason(27, MediaStatus.AVAILABLE)];
    const tvShow = {
      last_episode_to_air: { season_number: 27, episode_number: 24 },
      seasons: [
        { season_number: 26, episode_count: 22, air_date: '2025-09-01' },
        { season_number: 27, episode_count: 24, air_date: '2025-09-25' },
      ],
    };

    const result = requestSeasonsSatisfied(request, mediaSeasons, tvShow);

    assert.strictEqual(result.complete, false);
    assert.deepStrictEqual(result.availableSeasonNumbers, [27]);
  });

  it('does not complete an unaired season when the TMDB show could not be fetched', () => {
    const request = makeRequest(false, [{ seasonNumber: 28 }]);
    const mediaSeasons: Season[] = [];

    const result = requestSeasonsSatisfied(request, mediaSeasons, undefined);

    assert.strictEqual(result.complete, false);
    assert.deepStrictEqual(result.availableSeasonNumbers, []);
  });
});
