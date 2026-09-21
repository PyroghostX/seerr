import TheMovieDb from '@server/api/themoviedb';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import { MediaRequest } from '@server/entity/MediaRequest';
import type Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import logger from '@server/logger';
import { airedEpisodeCount } from '@server/utils/airedEpisodes';
import type { EntityManager } from 'typeorm';

export interface TvRequestCompletionSeason {
  season_number: number;
  episode_count: number;
  air_date?: string | null;
}

export interface TvRequestCompletionShow {
  last_episode_to_air?: {
    season_number: number;
    episode_number: number;
  } | null;
  seasons: TvRequestCompletionSeason[];
}

export interface RequestSeasonsSatisfiedResult {
  complete: boolean;
  availableSeasonNumbers: number[];
}

/**
 * Determines whether a TV request's own seasons are fully accounted for,
 * independent of the show's overall rollup status: every requested season
 * must either be AVAILABLE/DELETED, or not have aired yet, and at least one
 * requested season must actually be available.
 *
 * This is what allows a request for a currently-airing season (e.g. season
 * 27) alongside a not-yet-aired season (e.g. season 28) to complete once
 * season 27 lands, without waiting on the show's older, unavailable seasons
 * to roll the whole media up to AVAILABLE.
 */
export function requestSeasonsSatisfied(
  request: MediaRequest,
  mediaSeasons: Season[],
  tvShow: TvRequestCompletionShow | undefined
): RequestSeasonsSatisfiedResult {
  const statusKey = request.is4k ? 'status4k' : 'status';
  const availableSeasonNumbers: number[] = [];
  let everySeasonSatisfied = request.seasons.length > 0;

  for (const requestSeason of request.seasons) {
    const mediaSeason = mediaSeasons.find(
      (season) => season.seasonNumber === requestSeason.seasonNumber
    );

    const isAvailable =
      !!mediaSeason &&
      (mediaSeason[statusKey] === MediaStatus.AVAILABLE ||
        mediaSeason[statusKey] === MediaStatus.DELETED);

    if (isAvailable) {
      availableSeasonNumbers.push(requestSeason.seasonNumber);
      continue;
    }

    const tmdbSeason = tvShow?.seasons.find(
      (season) => season.season_number === requestSeason.seasonNumber
    );

    const isUnaired =
      !!tvShow && !!tmdbSeason && airedEpisodeCount(tvShow, tmdbSeason) === 0;

    if (!isUnaired) {
      everySeasonSatisfied = false;
    }
  }

  return {
    complete: everySeasonSatisfied && availableSeasonNumbers.length > 0,
    availableSeasonNumbers,
  };
}

/**
 * Syncs a TV request's SeasonRequest rows to COMPLETED for every season the
 * media already has available, and completes the parent request itself once
 * `requestSeasonsSatisfied` says it's fully satisfied. A request that is
 * already COMPLETED only has its season rows synced; its parent status (and
 * therefore save, which would re-fire the availability notification) is
 * left untouched.
 *
 * Returns whether the request's own status changed as a result of this call.
 */
export async function completeTvRequestIfSatisfied(
  manager: EntityManager,
  request: MediaRequest,
  mediaSeasons: Season[],
  tvShow: TvRequestCompletionShow | undefined
): Promise<boolean> {
  const { complete, availableSeasonNumbers } = requestSeasonsSatisfied(
    request,
    mediaSeasons,
    tvShow
  );

  const availableSet = new Set(availableSeasonNumbers);
  const seasonRequestRepository = manager.getRepository(SeasonRequest);

  for (const requestSeason of request.seasons) {
    if (
      availableSet.has(requestSeason.seasonNumber) &&
      requestSeason.status !== MediaRequestStatus.COMPLETED
    ) {
      requestSeason.status = MediaRequestStatus.COMPLETED;
      await seasonRequestRepository.save(requestSeason);
    }
  }

  if (
    complete &&
    (request.status === MediaRequestStatus.APPROVED ||
      request.status === MediaRequestStatus.FAILED)
  ) {
    request.status = MediaRequestStatus.COMPLETED;
    const requestRepository = manager.getRepository(MediaRequest);
    await requestRepository.save(request);
    return true;
  }

  return false;
}

/**
 * Fetches TMDB's scan-shaped TV show details for use with
 * `requestSeasonsSatisfied`/`completeTvRequestIfSatisfied`. Failures are
 * logged and swallowed so callers fall back to only completing requests
 * whose seasons are already fully available.
 */
export async function fetchTvShowForCompletion(
  tmdbId: number
): Promise<TvRequestCompletionShow | undefined> {
  try {
    const tmdb = new TheMovieDb();
    return await tmdb.getTvShowForScan({ tvId: tmdbId });
  } catch (e) {
    logger.warn(
      'Failed to fetch TMDB show details while checking TV request season completion',
      {
        label: 'TV Request Completion',
        tmdbId,
        errorMessage: e instanceof Error ? e.message : String(e),
      }
    );
    return undefined;
  }
}
