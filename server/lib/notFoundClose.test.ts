import type { RadarrMovie } from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';
import type {
  SonarrEpisodeFile,
  SonarrSeries,
} from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
import Media from '@server/entity/Media';
import {
  BlocklistedMediaError,
  MediaRequest,
  NoSeasonsAvailableError,
} from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { serializeEraPlan } from '@server/lib/eraPlan';
import type { NotFoundCloseError } from '@server/lib/notFoundClose';
import { closeRequestAsNotFound } from '@server/lib/notFoundClose';
import notificationManager, { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

const sent = mock.method(notificationManager, 'sendNotification', () => {});

// Assigned in the constructor, so the instances never shadow these stubs
function stubArrowMethod(target: object, name: string, value: unknown) {
  Object.defineProperty(target, name, {
    get: () => value,
    set() {},
    configurable: true,
  });
}

stubArrowMethod(TheMovieDb.prototype, 'getMovie', async () => ({
  id: 100,
  title: 'Test Movie',
  overview: 'An overview',
  poster_path: '/poster.jpg',
  release_date: '2020-01-01',
  external_ids: {},
  genres: [],
  original_language: 'en',
  keywords: { keywords: [] },
  videos: { results: [] },
}));
stubArrowMethod(TheMovieDb.prototype, 'getTvShow', async () => ({
  id: 200,
  name: 'Test Show',
  overview: 'An overview',
  poster_path: '/poster.jpg',
  first_air_date: '2020-01-01',
  external_ids: { tvdb_id: 300 },
  seasons: [1, 2, 3].map((seasonNumber) => ({
    season_number: seasonNumber,
    episode_count: 10,
    air_date: '2020-01-01',
  })),
  genres: [],
  original_language: 'en',
  keywords: { results: [] },
  videos: { results: [] },
}));

let libraryMovies: Partial<RadarrMovie>[] = [];
let librarySeries: Partial<SonarrSeries>[] = [];
let episodeFiles: Partial<SonarrEpisodeFile>[] = [];
let radarrCalls: unknown[][] = [];
let sonarrCalls: unknown[][] = [];
let unmonitored: unknown[][] = [];

stubArrowMethod(RadarrAPI.prototype, 'getLibraryMoviesByTmdbId', async () =>
  libraryMovies.map((m) => {
    if ((m as { unreachable?: boolean }).unreachable) {
      throw new Error('connect ECONNREFUSED');
    }
    return m;
  })
);
stubArrowMethod(
  RadarrAPI.prototype,
  'removeMovie',
  async (...args: unknown[]) => {
    radarrCalls.push(args);
  }
);
stubArrowMethod(
  SonarrAPI.prototype,
  'removeSeries',
  async (...args: unknown[]) => {
    sonarrCalls.push(args);
  }
);
SonarrAPI.prototype.getLibrarySeriesByTvdbId = async () =>
  librarySeries as SonarrSeries[];
SonarrAPI.prototype.getEpisodeFiles = async () =>
  episodeFiles as SonarrEpisodeFile[];
SonarrAPI.prototype.unmonitorSeasons = async (...args: unknown[]) => {
  unmonitored.push(args);
};

setupTestDb();

function configureArrs() {
  const settings = getSettings();
  const base = {
    hostname: 'localhost',
    apiKey: 'test-key',
    useSsl: false,
    syncEnabled: true,
  };

  settings.radarr = [
    { ...base, id: 0, port: 7878, is4k: false, isDefault: true },
    { ...base, id: 1, port: 7879, is4k: true, isDefault: true },
  ] as RadarrSettings[];
  settings.sonarr = [
    { ...base, id: 0, port: 8989, is4k: false, isDefault: true },
  ] as SonarrSettings[];
}

let alex: User;
let sam: User;
let admin: User;

beforeEach(async () => {
  sent.mock.resetCalls();
  libraryMovies = [];
  librarySeries = [];
  episodeFiles = [];
  radarrCalls = [];
  sonarrCalls = [];
  unmonitored = [];
  configureArrs();

  const users = getRepository(User);
  admin = await users.findOneOrFail({ where: { id: 1 } });
  alex = await users.findOneOrFail({ where: { email: 'friend@seerr.dev' } });
  sam = await users.save(
    new User({
      email: 'sam@seerr.dev',
      username: 'sam',
      permissions: 2,
      avatar: '',
    })
  );
});

const movieMedia = (overrides: Partial<Media> = {}) =>
  getRepository(Media).save(
    new Media({
      tmdbId: 100,
      mediaType: MediaType.MOVIE,
      status: MediaStatus.PROCESSING,
      status4k: MediaStatus.UNKNOWN,
      ...overrides,
    })
  );

const showMedia = (seasons: Season[] = [], overrides: Partial<Media> = {}) =>
  getRepository(Media).save(
    new Media({
      tmdbId: 200,
      tvdbId: 300,
      mediaType: MediaType.TV,
      status: MediaStatus.PROCESSING,
      status4k: MediaStatus.UNKNOWN,
      seasons,
      ...overrides,
    })
  );

const seedRequest = async (
  media: Media,
  requestedBy: User,
  seasons: number[] = [],
  overrides: Partial<MediaRequest> = {}
): Promise<MediaRequest> => {
  const repository = getRepository(MediaRequest);
  const request = new MediaRequest({
    media,
    requestedBy,
    type: media.mediaType,
    status: MediaRequestStatus.PENDING,
    is4k: false,
    seasons: seasons.map(
      (seasonNumber) =>
        new SeasonRequest({
          seasonNumber,
          status: MediaRequestStatus.PENDING,
        })
    ),
    ...overrides,
  });

  // Saved as PENDING: inserting APPROVED would send it to the stubbed arr
  const { status } = request;
  request.status = MediaRequestStatus.PENDING;
  await repository.save(request);

  if (status !== MediaRequestStatus.PENDING) {
    await repository.update(request.id, { status });
  }

  return repository.findOneOrFail({ where: { id: request.id } });
};

const notifications = () =>
  sent.mock.calls
    .map((call) => {
      const [type, payload] = call.arguments as unknown as [
        Notification,
        NotificationPayload,
      ];

      return {
        type,
        to: payload.notifyUser?.id,
        admin: payload.notifyAdmin,
        message: payload.message,
        extra: payload.extra,
      };
    })
    // Seeding a request announces it; everything after that must not
    .filter(({ type }) => type !== Notification.MEDIA_PENDING);

const reload = (request: MediaRequest) =>
  getRepository(MediaRequest).findOneOrFail({ where: { id: request.id } });

const reloadMedia = (media: Media) =>
  getRepository(Media).findOneOrFail({ where: { id: media.id } });

const seasonStatus = (media: Media, seasonNumber: number) =>
  media.seasons.find((s) => s.seasonNumber === seasonNumber)?.status;

describe('closeRequestAsNotFound: movies', () => {
  it('closes, removes without deleting files, blocklists and emails', async () => {
    const media = await movieMedia({
      serviceId: 0,
      externalServiceId: 7,
      externalServiceSlug: 'test-movie',
      ratingKey: '55',
    });
    const request = await seedRequest(media, alex, [], {
      status: MediaRequestStatus.APPROVED,
    });
    libraryMovies = [{ id: 7, tmdbId: 100, hasFile: false }];

    const closed = await closeRequestAsNotFound(request.id, admin);

    assert.strictEqual(closed.status, MediaRequestStatus.CLOSED);
    assert.strictEqual(closed.modifiedBy?.id, admin.id);
    assert.deepStrictEqual(radarrCalls, [[100, { deleteFiles: false }]]);

    const updated = await reloadMedia(media);
    assert.strictEqual(updated.status, MediaStatus.BLOCKLISTED);
    assert.strictEqual(updated.status4k, MediaStatus.BLOCKLISTED);
    assert.strictEqual(updated.externalServiceId, null);
    assert.strictEqual(updated.ratingKey, '55');

    const row = await getRepository(Blocklist).findOneOrFail({
      where: { tmdbId: 100, mediaType: MediaType.MOVIE },
      relations: { media: true },
    });
    assert.strictEqual(row.title, 'Test Movie');
    assert.strictEqual(row.user?.id, admin.id);
    assert.strictEqual(row.media.id, media.id);

    assert.deepStrictEqual(notifications(), [
      {
        type: Notification.MEDIA_NOT_FOUND,
        to: alex.id,
        admin: false,
        message:
          "The system searched for Test Movie but could not find it, so your request has been closed. It can't be requested again.",
        extra: undefined,
      },
    ]);
  });

  it('refuses with 409 and changes nothing when Radarr has the file', async () => {
    const media = await movieMedia();
    const request = await seedRequest(media, alex, [], {
      status: MediaRequestStatus.APPROVED,
    });
    libraryMovies = [{ id: 7, tmdbId: 100, hasFile: true }];

    await assert.rejects(
      () => closeRequestAsNotFound(request.id, admin),
      (e: NotFoundCloseError) => {
        assert.strictEqual(e.status, 409);
        assert.strictEqual(
          e.message,
          'Radarr has a file for this. Check the match instead.'
        );
        return true;
      }
    );

    assert.deepStrictEqual(radarrCalls, []);
    assert.strictEqual(
      (await reload(request)).status,
      MediaRequestStatus.APPROVED
    );
    assert.strictEqual(
      (await reloadMedia(media)).status,
      MediaStatus.PROCESSING
    );
    assert.strictEqual(await getRepository(Blocklist).count(), 0);
    assert.deepStrictEqual(notifications(), []);
  });

  it('changes nothing when Radarr cannot be reached', async () => {
    const media = await movieMedia();
    const request = await seedRequest(media, alex);
    libraryMovies = [{ unreachable: true } as Partial<RadarrMovie>];

    await assert.rejects(
      () => closeRequestAsNotFound(request.id, admin),
      /Could not check Radarr or Sonarr, so nothing was changed/
    );

    assert.strictEqual(
      (await reload(request)).status,
      MediaRequestStatus.PENDING
    );
    assert.deepStrictEqual(notifications(), []);
  });

  it('closes a movie that was never added and emails every requester', async () => {
    const media = await movieMedia({ status: MediaStatus.PENDING });
    const request = await seedRequest(media, alex);
    const other = await seedRequest(media, sam);

    await closeRequestAsNotFound(request.id, admin);

    assert.deepStrictEqual(radarrCalls, []);
    assert.strictEqual((await reload(other)).status, MediaRequestStatus.CLOSED);
    assert.deepStrictEqual(
      notifications()
        .map((n) => n.to)
        .sort(),
      [alex.id, sam.id]
    );
    assert.ok(
      notifications().every((n) => n.type === Notification.MEDIA_NOT_FOUND)
    );
  });

  it('survives a Blocklist row that already exists', async () => {
    const media = await movieMedia();
    const request = await seedRequest(media, alex);
    await getRepository(Blocklist).save(
      new Blocklist({ tmdbId: 100, mediaType: MediaType.MOVIE, media })
    );

    await closeRequestAsNotFound(request.id, admin);

    assert.strictEqual(await getRepository(Blocklist).count(), 1);
    assert.strictEqual(
      (await reloadMedia(media)).status,
      MediaStatus.BLOCKLISTED
    );
  });

  it('blocks only the 4K quality when the movie is available, and new 4K requests are refused', async () => {
    const media = await movieMedia({
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.PROCESSING,
      serviceId4k: 1,
      externalServiceId4k: 9,
      serviceId: 0,
      externalServiceId: 7,
    });
    const request = await seedRequest(media, alex, [], {
      is4k: true,
      status: MediaRequestStatus.APPROVED,
    });
    libraryMovies = [{ id: 9, tmdbId: 100, hasFile: false }];

    await closeRequestAsNotFound(request.id, admin);

    const updated = await reloadMedia(media);
    assert.strictEqual(updated.status, MediaStatus.AVAILABLE);
    assert.strictEqual(updated.status4k, MediaStatus.BLOCKLISTED);
    assert.strictEqual(updated.externalServiceId, 7);
    assert.strictEqual(updated.externalServiceId4k, null);
    assert.strictEqual(await getRepository(Blocklist).count(), 0);

    await assert.rejects(
      () =>
        MediaRequest.request(
          { mediaId: 100, mediaType: MediaType.MOVIE, is4k: true },
          admin
        ),
      BlocklistedMediaError
    );
  });

  it('keeps the block when the closed request is deleted', async () => {
    const media = await movieMedia();
    const request = await seedRequest(media, alex);
    await closeRequestAsNotFound(request.id, admin);

    await getRepository(MediaRequest).remove(await reload(request));

    assert.strictEqual(
      (await reloadMedia(media)).status,
      MediaStatus.BLOCKLISTED
    );
  });

  it('does not count a closed request against the quota', async () => {
    const media = await movieMedia();
    const request = await seedRequest(media, alex);
    alex.movieQuotaLimit = 5;
    await getRepository(User).save(alex);
    await closeRequestAsNotFound(request.id, admin);

    assert.strictEqual((await alex.getQuota()).movie.used, 0);
  });

  it('rejects other statuses, upgrades and unknown requests', async () => {
    const media = await movieMedia({ status: MediaStatus.AVAILABLE });
    const completed = await seedRequest(media, alex, [], {
      status: MediaRequestStatus.COMPLETED,
    });
    const upgrade = await seedRequest(media, sam, [], { isUpgrade: true });

    for (const [id, status] of [
      [completed.id, 400],
      [upgrade.id, 400],
      [99999, 404],
    ]) {
      await assert.rejects(
        () => closeRequestAsNotFound(id, admin),
        (e: NotFoundCloseError) => e.status === status
      );
    }
  });
});

describe('closeRequestAsNotFound: series', () => {
  it('removes a series with no files and blocklists the show', async () => {
    const media = await showMedia();
    const request = await seedRequest(media, alex, [1, 2], {
      status: MediaRequestStatus.APPROVED,
    });
    librarySeries = [{ id: 5, tvdbId: 300 }];

    await closeRequestAsNotFound(request.id, admin);

    assert.deepStrictEqual(sonarrCalls, [[300, { deleteFiles: false }]]);
    assert.deepStrictEqual(unmonitored, []);
    assert.strictEqual(
      (await reloadMedia(media)).status,
      MediaStatus.BLOCKLISTED
    );
    assert.strictEqual(await getRepository(Blocklist).count(), 1);
    assert.match(
      notifications()[0].message ?? '',
      /Test Show \(Seasons 1 and 2\) but could not find it/
    );
    assert.deepStrictEqual(notifications()[0].extra, [
      { name: 'Requested Seasons', value: '1, 2' },
    ]);
  });

  it('unmonitors closed seasons of a series with files and never removes it', async () => {
    const media = await showMedia(
      [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.UNKNOWN,
        }),
      ],
      { status: MediaStatus.PARTIALLY_AVAILABLE, externalServiceId: 5 }
    );
    const request = await seedRequest(media, alex, [1, 2], {
      status: MediaRequestStatus.APPROVED,
    });
    librarySeries = [{ id: 5, tvdbId: 300 }];
    episodeFiles = [{ id: 1, seasonNumber: 1 }];

    await closeRequestAsNotFound(request.id, admin);

    assert.deepStrictEqual(sonarrCalls, []);
    assert.deepStrictEqual(unmonitored, [[5, [2]]]);

    const updated = await reloadMedia(media);
    assert.strictEqual(updated.status, MediaStatus.PARTIALLY_AVAILABLE);
    assert.strictEqual(updated.externalServiceId, 5);
    assert.strictEqual(seasonStatus(updated, 1), MediaStatus.AVAILABLE);
    assert.strictEqual(seasonStatus(updated, 2), MediaStatus.BLOCKLISTED);
    assert.strictEqual(await getRepository(Blocklist).count(), 0);

    const closed = await reload(request);
    assert.strictEqual(closed.status, MediaRequestStatus.CLOSED);
    assert.strictEqual(
      closed.seasons.find((s) => s.seasonNumber === 1)?.status,
      MediaRequestStatus.PENDING
    );

    assert.match(notifications()[0].message ?? '', /\(Season 2\)/);
    assert.deepStrictEqual(notifications()[0].extra, [
      { name: 'Requested Seasons', value: '2' },
    ]);
  });

  it('refuses a re-request of the closed seasons but allows the others', async () => {
    const media = await showMedia(
      [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.UNKNOWN,
        }),
      ],
      { status: MediaStatus.PARTIALLY_AVAILABLE }
    );
    const request = await seedRequest(media, alex, [2]);

    await closeRequestAsNotFound(request.id, admin);

    await assert.rejects(
      () =>
        MediaRequest.request(
          {
            mediaId: 200,
            mediaType: MediaType.TV,
            is4k: false,
            seasons: [2],
          },
          admin
        ),
      NoSeasonsAvailableError
    );

    // Holds the request as PENDING so nothing is sent to the stubbed Sonarr
    const friend = await getRepository(User).findOneOrFail({
      where: { id: alex.id },
    });
    friend.permissions = 2;
    await getRepository(User).save(friend);

    const next = await MediaRequest.request(
      { mediaId: 200, mediaType: MediaType.TV, is4k: false, seasons: [2, 3] },
      friend
    );
    assert.deepStrictEqual(
      next.seasons.map((s) => s.seasonNumber),
      [3]
    );
  });

  it('leaves a partly covered request open without touching its status', async () => {
    const media = await showMedia();
    const request = await seedRequest(media, alex, [2], {
      status: MediaRequestStatus.APPROVED,
    });
    const partly = await seedRequest(media, sam, [2, 3], {
      status: MediaRequestStatus.APPROVED,
      eraPlan: serializeEraPlan({
        pending: [
          { profileId: 3, seasons: [2] },
          { profileId: 4, seasons: [3] },
        ],
      }),
    });
    librarySeries = [{ id: 5, tvdbId: 300 }];

    await closeRequestAsNotFound(request.id, admin);

    assert.deepStrictEqual(sonarrCalls, []);
    assert.deepStrictEqual(unmonitored, [[5, [2]]]);
    assert.strictEqual(await getRepository(Blocklist).count(), 0);

    const stillOpen = await reload(partly);
    assert.strictEqual(stillOpen.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(
      stillOpen.seasons.find((s) => s.seasonNumber === 2)?.status,
      MediaRequestStatus.CLOSED
    );
    assert.notStrictEqual(
      stillOpen.seasons.find((s) => s.seasonNumber === 3)?.status,
      MediaRequestStatus.CLOSED
    );
    assert.deepStrictEqual(JSON.parse(stillOpen.eraPlan as string).pending, [
      { profileId: 4, seasons: [3] },
    ]);

    assert.strictEqual(
      seasonStatus(await reloadMedia(media), 2),
      MediaStatus.BLOCKLISTED
    );
    // Only Alex lost the whole request
    assert.deepStrictEqual(
      notifications().map((n) => [n.type, n.to]),
      [[Notification.MEDIA_NOT_FOUND, alex.id]]
    );
  });

  it('clears the era plan of a closed request', async () => {
    const media = await showMedia();
    const request = await seedRequest(media, alex, [1, 2], {
      status: MediaRequestStatus.APPROVED,
      eraPlan: serializeEraPlan({ pending: [{ profileId: 3, seasons: [2] }] }),
    });

    await closeRequestAsNotFound(request.id, admin);

    assert.strictEqual((await reload(request)).eraPlan, null);
  });
});
