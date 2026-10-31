import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
  NOT_FOUND_CLOSABLE_STATUSES,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import type { User } from '@server/entity/User';
import {
  parseEraPlan,
  removeSeasonsFromEraPlan,
  serializeEraPlan,
} from '@server/lib/eraPlan';
import type { NotFoundPlan, PlanInput } from '@server/lib/notFoundPlan';
import { planNotFoundClose } from '@server/lib/notFoundPlan';
import { silenceAvailableNotifications } from '@server/lib/notificationSilence';
import { Notification } from '@server/lib/notifications';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

/** Reported to the admin as is, with this HTTP status. */
export class NotFoundCloseError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * What the arr knows and how to change it. `remove` and `unmonitor` never
 * touch a file.
 */
interface ArrHandle {
  name: string;
  state: PlanInput['arr'];
  remove: () => Promise<void>;
  unmonitor?: (seasons: number[]) => Promise<void>;
}

/**
 * Same server choice as the media file delete route, plus the request's own
 * server, which is all a request not yet sent to the arr has.
 */
const findServer = <
  T extends { id: number; is4k: boolean; isDefault: boolean },
>(
  servers: T[],
  request: MediaRequest
): T | undefined => {
  const specificId =
    request.media[request.is4k ? 'serviceId4k' : 'serviceId'] ??
    request.serverId;

  return (
    (specificId !== null && specificId !== undefined && specificId >= 0
      ? servers.find((server) => server.id === specificId)
      : undefined) ??
    servers.find((server) => server.isDefault && server.is4k === request.is4k)
  );
};

const noServerError = (name: string) =>
  new NotFoundCloseError(409, `No ${name} server is configured for this.`);

const openRadarr = async (
  request: MediaRequest,
  tmdbId: number
): Promise<ArrHandle> => {
  const name = `${request.is4k ? '4K ' : ''}Radarr`;
  const settings = findServer(getSettings().radarr, request);

  if (!settings) {
    throw noServerError(name);
  }

  const radarr = new RadarrAPI({
    apiKey: settings.apiKey,
    url: RadarrAPI.buildUrl(settings, '/api/v3'),
  });
  const movie = (await radarr.getLibraryMoviesByTmdbId(tmdbId)).find(
    (m) => m.tmdbId === tmdbId
  );

  return {
    name,
    state: { inArr: !!movie, hasFiles: !!movie?.hasFile },
    remove: async () => {
      await radarr.removeMovie(tmdbId, { deleteFiles: false });
      radarr.clearCache({ tmdbId, externalId: movie?.id });
    },
  };
};

const openSonarr = async (
  request: MediaRequest,
  tvdbId: number | undefined
): Promise<ArrHandle> => {
  const name = `${request.is4k ? '4K ' : ''}Sonarr`;
  const settings = findServer(getSettings().sonarr, request);

  if (!settings) {
    throw noServerError(name);
  }

  const sonarr = new SonarrAPI({
    apiKey: settings.apiKey,
    url: SonarrAPI.buildUrl(settings, '/api/v3'),
  });
  const series = tvdbId
    ? (await sonarr.getLibrarySeriesByTvdbId(tvdbId)).find(
        (s) => s.tvdbId === tvdbId
      )
    : undefined;
  const seriesId = series?.id;
  const files = seriesId ? await sonarr.getEpisodeFiles(seriesId) : [];

  return {
    name,
    state: { inArr: !!seriesId, hasFiles: files.length > 0 },
    remove: async () => {
      await sonarr.removeSeries(tvdbId as number, { deleteFiles: false });
      sonarr.clearCache({ tvdbId, externalId: seriesId });
    },
    unmonitor: async (seasons) => {
      await sonarr.unmonitorSeasons(seriesId as number, seasons);
      sonarr.clearCache({ tvdbId, externalId: seriesId });
    },
  };
};

const toPlanRequest = (request: MediaRequest): PlanInput['request'] => ({
  id: request.id,
  status: request.status,
  is4k: request.is4k,
  isUpgrade: request.isUpgrade,
  seasons: (request.seasons ?? []).map((season) => ({
    seasonNumber: season.seasonNumber,
    status: season.status,
  })),
});

const markSeasonsClosed = (
  request: MediaRequest,
  seasonNumbers: number[]
): SeasonRequest[] =>
  (request.seasons ?? []).filter((season) => {
    const closes = seasonNumbers.includes(season.seasonNumber);

    if (closes) {
      season.status = MediaRequestStatus.CLOSED;
    }

    return closes;
  });

/** All of the Seerr side, so a failure part way leaves no half-closed title. */
const applyPlan = (
  plan: NotFoundPlan,
  requests: MediaRequest[],
  mediaId: number,
  is4k: boolean,
  title: string,
  user: User
): Promise<void> =>
  dataSource.transaction(async (em) => {
    const requestRepository = em.getRepository(MediaRequest);
    const seasonRequestRepository = em.getRepository(SeasonRequest);
    const mediaRepository = em.getRepository(Media);
    const statusKey = is4k ? 'status4k' : 'status';

    // Requests go first: saving the media below makes MediaSubscriber
    // re-evaluate whatever is still open.
    for (const request of requests) {
      if (plan.closeRequestIds.includes(request.id)) {
        markSeasonsClosed(request, plan.closedSeasons);
        request.status = MediaRequestStatus.CLOSED;
        request.modifiedBy = user;
        request.eraPlan = null;
        await requestRepository.save(request);
      }
    }

    // These stay open, so they aren't saved: saving an APPROVED request would
    // send it to the arr and tell the requester it was approved.
    for (const { id, seasons } of plan.partialRequests) {
      const request = requests.find((r) => r.id === id) as MediaRequest;

      await seasonRequestRepository.save(markSeasonsClosed(request, seasons));

      const eraPlan = parseEraPlan(request.eraPlan);

      if (eraPlan) {
        await requestRepository.update(id, {
          eraPlan: serializeEraPlan(removeSeasonsFromEraPlan(eraPlan, seasons)),
        });
      }
    }

    const media = await mediaRepository.findOneOrFail({
      where: { id: mediaId },
    });

    if (plan.clearServiceData) {
      media[is4k ? 'serviceId4k' : 'serviceId'] = null;
      media[is4k ? 'externalServiceId4k' : 'externalServiceId'] = null;
      media[is4k ? 'externalServiceSlug4k' : 'externalServiceSlug'] = null;
    }

    if (plan.resetMediaStatus) {
      media[statusKey] = MediaStatus.UNKNOWN;
    }

    if (plan.block === 'quality') {
      media[statusKey] = MediaStatus.BLOCKLISTED;
    }

    if (plan.block === 'blocklist') {
      media.status = MediaStatus.BLOCKLISTED;
      media.status4k = MediaStatus.BLOCKLISTED;
    }

    if (plan.block === 'seasons') {
      for (const seasonNumber of plan.closedSeasons) {
        const season = media.seasons.find(
          (s) => s.seasonNumber === seasonNumber
        );

        if (season) {
          season[statusKey] = MediaStatus.BLOCKLISTED;
        } else {
          media.seasons.push(
            new Season({
              seasonNumber,
              status: is4k ? MediaStatus.UNKNOWN : MediaStatus.BLOCKLISTED,
              status4k: is4k ? MediaStatus.BLOCKLISTED : MediaStatus.UNKNOWN,
            })
          );
        }
      }
    }

    await mediaRepository.save(media);

    if (plan.block === 'blocklist') {
      const hasRow = await em.getRepository(Blocklist).exists({
        where: { tmdbId: media.tmdbId, mediaType: media.mediaType },
      });

      if (!hasRow) {
        await Blocklist.addToBlocklist(
          {
            blocklistRequest: {
              mediaType: media.mediaType,
              title,
              tmdbId: media.tmdbId,
              user,
            },
          },
          em
        );
      }
    }
  });

/**
 * Closes a request as "could not find it". The arr is read and changed first,
 * so a failure there leaves Seerr untouched and the two can't drift. Throws
 * NotFoundCloseError for what the admin can act on.
 */
export const closeRequestAsNotFound = async (
  requestId: number,
  user: User
): Promise<MediaRequest> => {
  const requestRepository = getRepository(MediaRequest);

  const request = await requestRepository.findOne({
    where: { id: requestId },
  });

  if (!request) {
    throw new NotFoundCloseError(404, 'Request not found.');
  }

  if (!NOT_FOUND_CLOSABLE_STATUSES.includes(request.status)) {
    throw new NotFoundCloseError(
      400,
      'Only pending, approved or failed requests can be closed.'
    );
  }

  if (request.isUpgrade) {
    throw new NotFoundCloseError(
      400,
      'Upgrade requests cannot be closed as not found.'
    );
  }

  const media = await getRepository(Media).findOneOrFail({
    where: { id: request.media.id },
  });
  const allRequests = await requestRepository.find({
    where: { media: { id: media.id } },
  });
  const tmdb = new TheMovieDb();

  let arr: ArrHandle;
  let title: string;

  try {
    if (media.mediaType === MediaType.MOVIE) {
      title = (await tmdb.getMovie({ movieId: media.tmdbId })).title;
      arr = await openRadarr(request, media.tmdbId);
    } else {
      const show = await tmdb.getTvShow({ tvId: media.tmdbId });

      title = show.name;
      arr = await openSonarr(
        request,
        show.external_ids.tvdb_id ?? media.tvdbId
      );
    }
  } catch (e) {
    if (e instanceof NotFoundCloseError) {
      throw e;
    }

    throw new Error(
      `Could not check Radarr or Sonarr, so nothing was changed: ${e.message}`,
      { cause: e }
    );
  }

  const plan = planNotFoundClose({
    request: toPlanRequest(request),
    otherRequests: allRequests
      .filter((r) => r.id !== request.id)
      .map(toPlanRequest),
    media,
    arr: arr.state,
  });

  if ('refused' in plan) {
    throw new NotFoundCloseError(
      409,
      plan.refused === 'file-in-arr'
        ? `${arr.name} has a file for this. Check the match instead.`
        : 'This is already available.'
    );
  }

  try {
    if (plan.arrAction === 'remove') {
      await arr.remove();
    } else if (plan.arrAction === 'unmonitor') {
      await arr.unmonitor?.(plan.closedSeasons);
    }
  } catch (e) {
    throw new Error(
      `Could not update ${arr.name}, so nothing was changed: ${e.message}`,
      { cause: e }
    );
  }

  // Marking seasons can complete a request left open; that isn't an arrival
  if (plan.block === 'seasons') {
    silenceAvailableNotifications(media.id);
  }

  await applyPlan(plan, allRequests, media.id, request.is4k, title, user);

  logger.info('Closed request as not found', {
    label: 'Media Request',
    requestId,
    mediaId: media.id,
    closedRequests: plan.closeRequestIds,
    closedSeasons: plan.closedSeasons,
    arrAction: plan.arrAction,
    block: plan.block,
  });

  const closedMedia = await getRepository(Media).findOneOrFail({
    where: { id: media.id },
  });

  for (const closed of allRequests) {
    if (plan.closeRequestIds.includes(closed.id)) {
      await MediaRequest.sendNotification(
        closed,
        closedMedia,
        Notification.MEDIA_NOT_FOUND
      );
    }
  }

  return requestRepository.findOneOrFail({ where: { id: requestId } });
};
