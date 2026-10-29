import type { PlexMetadata } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import SonarrAPI, {
  type SonarrSeason,
  type SonarrSeries,
} from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import type { TmdbTvDetails } from '@server/api/themoviedb/interfaces';
import { MediaStatus, MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import AvailabilityMismatch from '@server/entity/AvailabilityMismatch';
import Media from '@server/entity/Media';
import Season from '@server/entity/Season';
import { User } from '@server/entity/User';
import { silenceAvailableNotifications } from '@server/lib/notificationSilence';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { airedEpisodeCount } from '@server/utils/airedEpisodes';
import { IsNull, Not } from 'typeorm';

/**
 * Plex counts a multi-episode file (S05E01-02) as one episode, so a season
 * can show fewer episodes in Plex than Sonarr has files for, and Seerr then
 * calls the show partially available. This check compares the two per season
 * and keeps a list the admin works through: "fine" means expected (stop
 * reporting it), "fixed" means they changed something and it matches now.
 */
export type MismatchStatus = 'open' | 'fine' | 'fixed' | 'resolved';

export const MISMATCH_STATUSES: MismatchStatus[] = [
  'open',
  'fine',
  'fixed',
  'resolved',
];

export interface SeasonCounts {
  seasonNumber: number;
  plexEpisodes: number;
  sonarrEpisodes: number;
}

export interface MismatchFinding extends SeasonCounts {
  mediaId: number;
  title?: string | null;
}

export interface MismatchRow extends MismatchFinding {
  id: number;
  status: MismatchStatus;
}

export interface NewMismatch extends MismatchFinding {
  status: 'open';
  firstSeenAt: Date;
}

export interface MismatchChange {
  id: number;
  changes: Partial<
    Pick<
      AvailabilityMismatch,
      | 'status'
      | 'plexEpisodes'
      | 'sonarrEpisodes'
      | 'title'
      | 'firstSeenAt'
      | 'resolvedAt'
      | 'resolvedBy'
    >
  >;
}

/**
 * Seasons (1 and up) whose Sonarr episode file count differs from the
 * episode count Plex shows. A season missing on one side counts as 0 there.
 */
export function findSeasonMismatches(
  sonarrSeasons: Pick<SonarrSeason, 'seasonNumber' | 'statistics'>[],
  plexSeasons: Pick<PlexMetadata, 'index' | 'leafCount'>[]
): SeasonCounts[] {
  const sonarrCounts = new Map<number, number>();
  const plexCounts = new Map<number, number>();

  for (const season of sonarrSeasons) {
    sonarrCounts.set(
      season.seasonNumber,
      season.statistics?.episodeFileCount ?? 0
    );
  }

  for (const season of plexSeasons) {
    plexCounts.set(season.index, season.leafCount ?? 0);
  }

  const seasonNumbers = [
    ...new Set([...sonarrCounts.keys(), ...plexCounts.keys()]),
  ]
    .filter((n) => n >= 1)
    .sort((a, b) => a - b);

  const mismatches: SeasonCounts[] = [];

  for (const seasonNumber of seasonNumbers) {
    const plexEpisodes = plexCounts.get(seasonNumber) ?? 0;
    const sonarrEpisodes = sonarrCounts.get(seasonNumber) ?? 0;

    if (plexEpisodes !== sonarrEpisodes) {
      mismatches.push({ seasonNumber, plexEpisodes, sonarrEpisodes });
    }
  }

  return mismatches;
}

/**
 * Turns the findings of a check into row inserts and updates. New mismatches
 * open; open rows follow the latest counts; "fine" rows stay quiet while the
 * counts are the ones the admin accepted; anything else that shows up again
 * reopens. Open rows of checked shows that match now resolve on their own.
 * `inScope` says which shows this check covered, so a show that failed to
 * load keeps its rows as they were.
 */
export function reconcileMismatches(
  existing: MismatchRow[],
  findings: MismatchFinding[],
  inScope: (mediaId: number) => boolean,
  now = new Date()
): { create: NewMismatch[]; update: MismatchChange[] } {
  const key = (row: { mediaId: number; seasonNumber: number }) =>
    `${row.mediaId}:${row.seasonNumber}`;
  const existingByKey = new Map(existing.map((row) => [key(row), row]));
  const foundKeys = new Set<string>();
  const create: NewMismatch[] = [];
  const update: MismatchChange[] = [];

  for (const finding of findings) {
    foundKeys.add(key(finding));

    const row = existingByKey.get(key(finding));

    if (!row) {
      create.push({ ...finding, status: 'open', firstSeenAt: now });
      continue;
    }

    const sameCounts =
      row.plexEpisodes === finding.plexEpisodes &&
      row.sonarrEpisodes === finding.sonarrEpisodes;
    const titleChanged = !!finding.title && finding.title !== row.title;

    if (row.status === 'open' || (row.status === 'fine' && sameCounts)) {
      if (!sameCounts || titleChanged) {
        update.push({
          id: row.id,
          changes: {
            plexEpisodes: finding.plexEpisodes,
            sonarrEpisodes: finding.sonarrEpisodes,
            ...(titleChanged ? { title: finding.title } : {}),
          },
        });
      }
      continue;
    }

    update.push({
      id: row.id,
      changes: {
        status: 'open',
        plexEpisodes: finding.plexEpisodes,
        sonarrEpisodes: finding.sonarrEpisodes,
        ...(titleChanged ? { title: finding.title } : {}),
        firstSeenAt: now,
        resolvedAt: null,
        resolvedBy: null,
      },
    });
  }

  for (const row of existing) {
    if (
      row.status === 'open' &&
      !foundKeys.has(key(row)) &&
      inScope(row.mediaId)
    ) {
      update.push({
        id: row.id,
        changes: { status: 'resolved', resolvedAt: now, resolvedBy: null },
      });
    }
  }

  return { create, update };
}

/**
 * Whether "Fine" should also mark the Seerr season available: Sonarr has a
 * file for every aired episode and Seerr doesn't show it available yet.
 */
export function shouldMarkSeasonAvailable(
  sonarrEpisodes: number,
  tvShow: Pick<TmdbTvDetails, 'last_episode_to_air' | 'seasons'>,
  seasonNumber: number,
  currentStatus: MediaStatus | undefined,
  now = new Date()
): boolean {
  if (currentStatus === MediaStatus.AVAILABLE) {
    return false;
  }

  const tmdbSeason = tvShow.seasons.find(
    (season) => season.season_number === seasonNumber
  );

  if (!tmdbSeason) {
    return false;
  }

  const aired = airedEpisodeCount(tvShow, tmdbSeason, now);

  return aired > 0 && sonarrEpisodes >= aired;
}

/**
 * The show's status after a season was marked available: available once
 * every aired season (1 and up) is, else partially available.
 */
export function rollUpShowStatus(
  seasons: Pick<Season, 'seasonNumber' | 'status'>[],
  tvShow: Pick<TmdbTvDetails, 'last_episode_to_air' | 'seasons'>,
  currentStatus: MediaStatus,
  now = new Date()
): MediaStatus {
  const airedSeasons = tvShow.seasons.filter(
    (season) =>
      season.season_number >= 1 && airedEpisodeCount(tvShow, season, now) > 0
  );

  const isAvailable = (seasonNumber: number) =>
    seasons.some(
      (season) =>
        season.seasonNumber === seasonNumber &&
        season.status === MediaStatus.AVAILABLE
    );

  if (
    airedSeasons.length > 0 &&
    airedSeasons.every((season) => isAvailable(season.season_number))
  ) {
    return MediaStatus.AVAILABLE;
  }

  if (
    seasons.some(
      (season) =>
        season.seasonNumber >= 1 &&
        (season.status === MediaStatus.AVAILABLE ||
          season.status === MediaStatus.PARTIALLY_AVAILABLE)
    )
  ) {
    return MediaStatus.PARTIALLY_AVAILABLE;
  }

  return currentStatus;
}

let running = false;

/**
 * Whether an Availability Check is currently in progress, for the scheduled
 * jobs UI.
 */
export function isAvailabilityCheckRunning(): boolean {
  return running;
}

async function getPlexClient(): Promise<PlexAPI | null> {
  const admin = await getRepository(User).findOne({
    select: { id: true, plexToken: true },
    where: { id: 1 },
  });

  return admin ? new PlexAPI({ plexToken: admin.plexToken }) : null;
}

function sonarrClients(): { name: string; api: SonarrAPI }[] {
  return getSettings()
    .sonarr.filter((server) => !server.is4k)
    .map((server) => ({
      name: server.name,
      api: new SonarrAPI({
        apiKey: server.apiKey,
        url: SonarrAPI.buildUrl(server, '/api/v3'),
      }),
    }));
}

async function checkShow(
  plex: PlexAPI,
  media: Pick<Media, 'id' | 'ratingKey'>,
  series: Pick<SonarrSeries, 'title' | 'seasons'>
): Promise<MismatchFinding[]> {
  const plexSeasons = media.ratingKey
    ? (await plex.getChildrenMetadata(media.ratingKey)).filter(
        (child) => child.type === 'season'
      )
    : [];

  return findSeasonMismatches(series.seasons ?? [], plexSeasons).map(
    (counts) => ({ ...counts, mediaId: media.id, title: series.title })
  );
}

async function applyReconcile(
  existing: MismatchRow[],
  findings: MismatchFinding[],
  inScope: (mediaId: number) => boolean,
  now: Date
): Promise<{ created: number; updated: number }> {
  const repository = getRepository(AvailabilityMismatch);
  const { create, update } = reconcileMismatches(
    existing,
    findings,
    inScope,
    now
  );

  if (create.length) {
    await repository.save(create.map((row) => new AvailabilityMismatch(row)));
  }

  for (const { id, changes } of update) {
    await repository.update(id, changes);
  }

  return { created: create.length, updated: update.length };
}

/**
 * Compares every standard Sonarr series that has files with its show in
 * Plex and records the seasons that disagree. Plex calls run one show at a
 * time; a show that fails to load is logged and left as it was.
 */
export async function runAvailabilityCheck(): Promise<void> {
  if (running) {
    return;
  }

  running = true;

  try {
    if (getSettings().main.mediaServerType !== MediaServerType.PLEX) {
      logger.info('Availability Check skipped: Plex is not the media server', {
        label: 'Availability Check',
      });
      return;
    }

    const plex = await getPlexClient();

    if (!plex) {
      logger.warn('Availability Check skipped: no admin configured', {
        label: 'Availability Check',
      });
      return;
    }

    const now = new Date();
    const tvMedia = await getRepository(Media).find({
      select: { id: true, tvdbId: true, ratingKey: true },
      where: { mediaType: MediaType.TV, tvdbId: Not(IsNull()) },
    });
    const mediaByTvdbId = new Map(
      tvMedia.map((media) => [media.tvdbId as number, media])
    );

    const findings: MismatchFinding[] = [];
    const checked = new Set<number>();
    const failed = new Set<number>();
    let allServersLoaded = true;

    for (const server of sonarrClients()) {
      let seriesList: SonarrSeries[];

      try {
        seriesList = await server.api.getSeries();
      } catch (e) {
        allServersLoaded = false;
        logger.warn('Failed to fetch Sonarr series for Availability Check', {
          label: 'Availability Check',
          server: server.name,
          errorMessage: e.message,
        });
        continue;
      }

      for (const series of seriesList) {
        if (!(series.statistics?.episodeFileCount > 0)) {
          continue;
        }

        const media = mediaByTvdbId.get(series.tvdbId);

        if (!media || checked.has(media.id)) {
          continue;
        }

        try {
          findings.push(...(await checkShow(plex, media, series)));
          checked.add(media.id);
        } catch (e) {
          failed.add(media.id);
          logger.warn('Failed to check show for Availability Check', {
            label: 'Availability Check',
            title: series.title,
            mediaId: media.id,
            errorMessage: e.message,
          });
        }
      }
    }

    const existing = await getRepository(AvailabilityMismatch).find();
    // With every Sonarr server loaded, a show that isn't there (or has no
    // files any more) has nothing left to mismatch; otherwise only the shows
    // actually checked can resolve.
    const { created, updated } = await applyReconcile(
      existing,
      findings,
      allServersLoaded
        ? (mediaId) => !failed.has(mediaId) || checked.has(mediaId)
        : (mediaId) => checked.has(mediaId),
      now
    );

    logger.info('Availability Check complete', {
      label: 'Availability Check',
      showsChecked: checked.size,
      showsFailed: failed.size,
      mismatches: findings.length,
      created,
      updated,
    });
  } finally {
    running = false;
  }
}

/**
 * Checks one show again right away (the "Fixed" button) and reconciles its
 * rows. Returns the show's current mismatches. Throws when Plex or Sonarr
 * can't be reached, so a failed check is never taken as a fix.
 */
export async function recheckShow(
  media: Pick<Media, 'id' | 'tvdbId' | 'ratingKey'>
): Promise<MismatchFinding[]> {
  const plex = await getPlexClient();

  if (!plex) {
    throw new Error('No admin configured');
  }

  let series: SonarrSeries | undefined;

  if (media.tvdbId) {
    for (const server of sonarrClients()) {
      const matches = await server.api.getLibrarySeriesByTvdbId(media.tvdbId);

      series = matches.find((s) => s.tvdbId === media.tvdbId && s.id);

      if (series) {
        break;
      }
    }
  }

  // A show no longer in Sonarr (or without files) has nothing to compare,
  // the same as in the full check.
  const findings =
    series && series.statistics?.episodeFileCount > 0
      ? await checkShow(plex, media, series)
      : [];

  const existing = await getRepository(AvailabilityMismatch).find({
    where: { mediaId: media.id },
  });

  await applyReconcile(existing, findings, () => true, new Date());

  return findings;
}

/**
 * The "Fine" side effect: when Sonarr has every aired episode of the season,
 * mark the Seerr season available without notifying anyone, then roll the
 * show's status up. Returns whether anything changed.
 */
export async function markSeasonAvailableIfComplete(
  mediaId: number,
  seasonNumber: number,
  sonarrEpisodes: number
): Promise<boolean> {
  const mediaRepository = getRepository(Media);
  const media = await mediaRepository.findOne({
    where: { id: mediaId },
    relations: { seasons: true },
  });

  if (!media || media.mediaType !== MediaType.TV) {
    return false;
  }

  const tvShow = await new TheMovieDb().getTvShow({ tvId: media.tmdbId });
  const season = media.seasons.find((s) => s.seasonNumber === seasonNumber);
  const now = new Date();

  if (
    !shouldMarkSeasonAvailable(
      sonarrEpisodes,
      tvShow,
      seasonNumber,
      season?.status,
      now
    )
  ) {
    return false;
  }

  silenceAvailableNotifications(media.id);

  if (season) {
    season.status = MediaStatus.AVAILABLE;
  } else {
    media.seasons.push(
      getRepository(Season).create({
        seasonNumber,
        status: MediaStatus.AVAILABLE,
      })
    );
  }

  media.status = rollUpShowStatus(media.seasons, tvShow, media.status, now);

  await mediaRepository.save(media);

  logger.info('Marked season available from a Fine mismatch', {
    label: 'Availability Check',
    mediaId: media.id,
    seasonNumber,
    status: media.status,
  });

  return true;
}
