import type { SonarrMissingEpisode } from '@server/api/servarr/sonarr';
import type { TmdbMovieDetails } from '@server/api/themoviedb/interfaces';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type Season from '@server/entity/Season';
import {
  DISCORD_CONTENT_LIMIT,
  buildMorningCheckMessage,
  filterRecentMissing,
  formatMissingLine,
  formatUnfilledLine,
  isMovieReleased,
  isUnfilledCandidate,
  missingAiredSeasons,
} from '@server/lib/morningCheck';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const NOW = new Date('2026-10-28T15:00:00Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;

const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

function makeRequest(overrides: Partial<MediaRequest> = {}): MediaRequest {
  return {
    status: MediaRequestStatus.APPROVED,
    isUpgrade: false,
    is4k: false,
    createdAt: ago(2 * DAY),
    media: {
      status: MediaStatus.PROCESSING,
      status4k: MediaStatus.UNKNOWN,
    } as Media,
    seasons: [],
    ...overrides,
  } as MediaRequest;
}

function makeMovie(
  overrides: Partial<TmdbMovieDetails> = {}
): Pick<TmdbMovieDetails, 'release_dates' | 'release_date' | 'status'> {
  return {
    status: 'Released',
    release_date: '2026-06-01',
    release_dates: { results: [] },
    ...overrides,
  };
}

describe('isUnfilledCandidate', () => {
  it('flags an approved request over 24 hours old that is not available', () => {
    assert.equal(isUnfilledCandidate(makeRequest(), NOW), true);
  });

  it('skips requests made in the last 24 hours', () => {
    assert.equal(
      isUnfilledCandidate(makeRequest({ createdAt: ago(23 * HOUR) }), NOW),
      false
    );
  });

  it('skips upgrade requests', () => {
    assert.equal(
      isUnfilledCandidate(makeRequest({ isUpgrade: true }), NOW),
      false
    );
  });

  it('skips requests that are not approved', () => {
    assert.equal(
      isUnfilledCandidate(
        makeRequest({ status: MediaRequestStatus.COMPLETED }),
        NOW
      ),
      false
    );
  });

  it('checks the status matching the request quality', () => {
    const media = {
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.PROCESSING,
    } as Media;

    assert.equal(isUnfilledCandidate(makeRequest({ media }), NOW), false);
    assert.equal(
      isUnfilledCandidate(makeRequest({ media, is4k: true }), NOW),
      true
    );
  });
});

describe('isMovieReleased', () => {
  it('counts a movie with a past digital release as released', () => {
    const movie = makeMovie({
      release_date: '2026-09-01',
      release_dates: {
        results: [
          {
            iso_3166_1: 'US',
            rating: '',
            release_dates: [
              {
                certification: '',
                iso_639_1: '',
                note: '',
                release_date: '2026-10-01T00:00:00.000Z',
                type: 4,
              },
            ],
          },
        ],
      },
    });

    assert.equal(isMovieReleased(movie, 'US', NOW), true);
  });

  it('treats a recent theatrical-only movie as unreleased', () => {
    assert.equal(
      isMovieReleased(makeMovie({ release_date: '2026-10-01' }), 'US', NOW),
      false
    );
  });

  it('treats rumored and in-production movies as unreleased', () => {
    assert.equal(
      isMovieReleased(
        makeMovie({ status: 'In Production', release_date: '' }),
        'US',
        NOW
      ),
      false
    );
  });

  it('assumes an old movie without home release data is released', () => {
    assert.equal(
      isMovieReleased(makeMovie({ release_date: '2001-05-01' }), 'US', NOW),
      true
    );
  });
});

describe('missingAiredSeasons', () => {
  const tvShow = {
    last_episode_to_air: { season_number: 3, episode_number: 2 },
    seasons: [
      { season_number: 1, episode_count: 10, air_date: '2024-01-01' },
      { season_number: 2, episode_count: 10, air_date: '2025-01-01' },
      { season_number: 3, episode_count: 10, air_date: '2026-10-14' },
      { season_number: 4, episode_count: 10, air_date: '2027-10-14' },
    ],
  } as unknown as Parameters<typeof missingAiredSeasons>[2];

  const requestFor = (
    seasons: { seasonNumber: number; status?: MediaRequestStatus }[],
    is4k = false
  ) =>
    makeRequest({
      is4k,
      seasons: seasons.map((season) => ({
        seasonNumber: season.seasonNumber,
        status: season.status ?? MediaRequestStatus.APPROVED,
      })) as MediaRequest['seasons'],
    });

  const season = (
    seasonNumber: number,
    status: MediaStatus,
    status4k = MediaStatus.UNKNOWN
  ) => ({ seasonNumber, status, status4k }) as Season;

  it('lists aired seasons that are not available, skipping unaired ones', () => {
    const request = requestFor([
      { seasonNumber: 1 },
      { seasonNumber: 2 },
      { seasonNumber: 3 },
      { seasonNumber: 4 },
    ]);
    const mediaSeasons = [season(1, MediaStatus.AVAILABLE)];

    assert.deepEqual(
      missingAiredSeasons(request, mediaSeasons, tvShow, NOW),
      [2, 3]
    );
  });

  it('is empty when only unaired seasons are outstanding', () => {
    const request = requestFor([{ seasonNumber: 1 }, { seasonNumber: 4 }]);

    assert.deepEqual(
      missingAiredSeasons(
        request,
        [season(1, MediaStatus.AVAILABLE)],
        tvShow,
        NOW
      ),
      []
    );
  });

  it('skips completed season requests', () => {
    const request = requestFor([
      { seasonNumber: 2, status: MediaRequestStatus.COMPLETED },
    ]);

    assert.deepEqual(missingAiredSeasons(request, [], tvShow, NOW), []);
  });

  it('uses the 4K status for 4K requests', () => {
    const request = requestFor([{ seasonNumber: 2 }], true);

    assert.deepEqual(
      missingAiredSeasons(
        request,
        [season(2, MediaStatus.AVAILABLE, MediaStatus.PROCESSING)],
        tvShow,
        NOW
      ),
      [2]
    );
  });

  it('reports nothing without TMDB data', () => {
    assert.deepEqual(
      missingAiredSeasons(requestFor([{ seasonNumber: 2 }]), [], undefined),
      []
    );
  });
});

describe('filterRecentMissing', () => {
  const record = (
    seriesId: number,
    seasonNumber: number,
    episodeNumber: number,
    airedAgoMs: number
  ): SonarrMissingEpisode => ({
    id: seriesId * 1000 + episodeNumber,
    seriesId,
    seasonNumber,
    episodeNumber,
    airDateUtc: ago(airedAgoMs).toISOString(),
  });

  it('keeps episodes that aired between 20 hours and 14 days ago', () => {
    const titles = new Map([
      [1, 'Zeta Show'],
      [2, 'Alpha Show'],
    ]);
    const result = filterRecentMissing(
      [
        record(1, 5, 24, 2 * DAY),
        record(1, 5, 25, 19 * HOUR),
        record(2, 1, 3, 3 * DAY),
        record(2, 1, 1, 15 * DAY),
        { id: 9, seriesId: 2, seasonNumber: 1, episodeNumber: 9 },
      ],
      titles,
      NOW
    );

    assert.deepEqual(result.map(formatMissingLine), [
      '• Alpha Show — S1E3',
      '• Zeta Show — S5E24',
    ]);
  });

  it('falls back to the series ID when the title is unknown', () => {
    const result = filterRecentMissing([record(7, 1, 1, DAY)], new Map(), NOW);

    assert.equal(result[0].seriesTitle, 'Series 7');
  });
});

describe('formatUnfilledLine', () => {
  it('formats a movie line', () => {
    assert.equal(
      formatUnfilledLine(
        {
          title: 'Movie',
          year: '2026',
          requestedBy: 'alex',
          createdAt: ago(3 * DAY + HOUR),
        },
        NOW
      ),
      '• Movie (2026) — requested by alex, 3 days ago'
    );
  });

  it('formats a TV line with missing seasons and a single day', () => {
    assert.equal(
      formatUnfilledLine(
        {
          title: 'Show',
          year: '2020',
          requestedBy: 'sam',
          createdAt: ago(30 * HOUR),
          missingSeasons: [2, 3],
        },
        NOW
      ),
      '• Show (2020) — requested by sam, 1 day ago — S2, S3'
    );
  });
});

describe('buildMorningCheckMessage', () => {
  it('returns null when there is nothing to report', () => {
    assert.equal(buildMorningCheckMessage([], []), null);
  });

  it('renders both sections', () => {
    assert.equal(
      buildMorningCheckMessage(['• A'], ['• B — S1E1', '• C — S1E2']),
      '**1 request not filled after 24 hours:**\n• A\n\n' +
        '**2 recently missing episodes:**\n• B — S1E1\n• C — S1E2'
    );
  });

  it('caps the lists and says how many more there are', () => {
    const unfilled = Array.from({ length: 18 }, (_, i) => `• R${i}`);
    const missing = Array.from({ length: 25 }, (_, i) => `• E${i}`);
    const message = buildMorningCheckMessage(unfilled, missing) ?? '';

    assert.match(message, /^\*\*18 requests not filled after 24 hours:\*\*/);
    assert.match(message, /• R14\n…and 3 more/);
    assert.doesNotMatch(message, /• R15/);
    assert.match(message, /\*\*25 recently missing episodes:\*\*/);
    assert.match(message, /• E19\n…and 5 more$/);
  });

  it('trims lists to stay under the Discord limit', () => {
    const long = (prefix: string, i: number) =>
      `• ${prefix}${i} ${'x'.repeat(150)}`;
    const unfilled = Array.from({ length: 15 }, (_, i) => long('R', i));
    const missing = Array.from({ length: 20 }, (_, i) => long('E', i));
    const message = buildMorningCheckMessage(unfilled, missing) ?? '';

    assert.ok(message.length <= DISCORD_CONTENT_LIMIT, `${message.length}`);
    assert.match(message, /requests not filled/);
    assert.match(message, /recently missing episodes/);
    assert.match(message, /…and \d+ more/);
  });
});
