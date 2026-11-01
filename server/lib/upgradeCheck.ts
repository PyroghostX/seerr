import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import notificationManager, { Notification } from '@server/lib/notifications';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { truncate } from 'lodash';

/**
 * An upgrade request is COMPLETED as soon as Radarr or Sonarr has it, long
 * before the better file exists, and the title was already available, so
 * nothing tells the requester it arrived. This job watches those requests and
 * sends the usual "now available" notification once the files are 1080p.
 */
export const UPGRADE_RESOLUTION = 1080;
/** Past this the release most likely doesn't exist, so stop looking. */
export const UPGRADE_WAIT_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ArrFile {
  quality?: { quality?: { resolution?: number } };
  mediaInfo?: { resolution?: string };
}

/** Lines of a file's resolution, 0 when neither Radarr nor Sonarr knows it. */
export function fileResolution(file: ArrFile | undefined): number {
  const resolution = file?.quality?.quality?.resolution;
  if (resolution) {
    return resolution;
  }
  // mediaInfo.resolution looks like "1920x1080"; wide films are 1920x800
  const [width, height] = (file?.mediaInfo?.resolution ?? '')
    .split('x')
    .map(Number);
  return width >= 1900 ? Math.max(height, UPGRADE_RESOLUTION) : height || 0;
}

export function isMovieUpgraded(file: ArrFile | undefined): boolean {
  return fileResolution(file) >= UPGRADE_RESOLUTION;
}

/** Every requested season has files and none of them is below 1080p. */
export function areSeasonsUpgraded(
  files: (ArrFile & { seasonNumber: number })[],
  seasonNumbers: number[]
): boolean {
  return (
    seasonNumbers.length > 0 &&
    seasonNumbers.every((seasonNumber) => {
      const season = files.filter((f) => f.seasonNumber === seasonNumber);
      return (
        season.length > 0 &&
        season.every((f) => fileResolution(f) >= UPGRADE_RESOLUTION)
      );
    })
  );
}

const requestedSeasons = (request: MediaRequest): number[] =>
  request.seasons
    .filter((season) => season.status !== MediaRequestStatus.CLOSED)
    .map((season) => season.seasonNumber);

async function isUpgraded(request: MediaRequest): Promise<boolean> {
  const settings = getSettings();
  if (request.media.mediaType === MediaType.MOVIE) {
    const server = settings.radarr.find((r) => !r.is4k && r.isDefault);
    if (!server) {
      return false;
    }
    const radarr = new RadarrAPI({
      apiKey: server.apiKey,
      url: RadarrAPI.buildUrl(server, '/api/v3'),
    });
    const movie = await radarr.getMovieByTmdbId(request.media.tmdbId);
    return isMovieUpgraded(movie.movieFile);
  }

  const server = settings.sonarr.find((s) => !s.is4k && s.isDefault);
  if (!server || !request.media.tvdbId) {
    return false;
  }
  const sonarr = new SonarrAPI({
    apiKey: server.apiKey,
    url: SonarrAPI.buildUrl(server, '/api/v3'),
  });
  const [series] = await sonarr.getLibrarySeriesByTvdbId(request.media.tvdbId);
  if (!series?.id) {
    return false;
  }
  return areSeasonsUpgraded(
    await sonarr.getEpisodeFiles(series.id),
    requestedSeasons(request)
  );
}

async function notifyUpgraded(request: MediaRequest): Promise<void> {
  const tmdb = new TheMovieDb();
  const repository = getRepository(MediaRequest);
  const shared = {
    notifyAdmin: false,
    notifySystem: true,
    notifyUser: request.requestedBy,
    media: request.media,
    request,
  };
  const overview = (text?: string) =>
    truncate(text, { length: 500, separator: /\s/, omission: '…' });
  const poster = (path?: string) =>
    `https://image.tmdb.org/t/p/w600_and_h900_bestv2${path}`;

  // Update, not save: the request subscriber must not see this as a new
  // completion. Cleared before sending so a crash can't repeat the email.
  if (request.media.mediaType === MediaType.MOVIE) {
    const movie = await tmdb.getMovie({ movieId: request.media.tmdbId });
    await repository.update(request.id, { upgradePending: false });
    notificationManager.sendNotification(Notification.MEDIA_AVAILABLE, {
      ...shared,
      event: 'Movie Request Now Available',
      subject: `${movie.title}${
        movie.release_date ? ` (${movie.release_date.slice(0, 4)})` : ''
      }`,
      message: overview(movie.overview),
      image: poster(movie.poster_path),
    });
    return;
  }

  const tv = await tmdb.getTvShow({ tvId: request.media.tmdbId });
  await repository.update(request.id, { upgradePending: false });
  notificationManager.sendNotification(Notification.MEDIA_AVAILABLE, {
    ...shared,
    event: 'Series Request Now Available',
    subject: `${tv.name}${
      tv.first_air_date ? ` (${tv.first_air_date.slice(0, 4)})` : ''
    }`,
    message: overview(tv.overview),
    image: poster(tv.poster_path),
    extra: [
      {
        name: 'Requested Seasons',
        value: requestedSeasons(request).join(', '),
      },
    ],
  });
}

let running = false;

export function isUpgradeCheckRunning(): boolean {
  return running;
}

export async function runUpgradeCheck(): Promise<void> {
  if (running) {
    return;
  }
  running = true;
  try {
    const repository = getRepository(MediaRequest);
    const pending = await repository.find({
      where: { upgradePending: true },
      relations: { media: true, requestedBy: true, seasons: true },
    });
    for (const request of pending) {
      try {
        if (await isUpgraded(request)) {
          await notifyUpgraded(request);
          logger.info('Upgrade finished, requester notified', {
            label: 'Upgrade Check',
            requestId: request.id,
          });
        } else if (
          Date.now() - request.createdAt.getTime() >
          UPGRADE_WAIT_DAYS * MS_PER_DAY
        ) {
          await repository.update(request.id, { upgradePending: false });
          logger.info('Upgrade never arrived, no longer watching it', {
            label: 'Upgrade Check',
            requestId: request.id,
          });
        }
      } catch (e) {
        logger.warn('Could not check an upgrade request, will retry', {
          label: 'Upgrade Check',
          requestId: request.id,
          errorMessage: e.message,
        });
      }
    }
  } finally {
    running = false;
  }
}
