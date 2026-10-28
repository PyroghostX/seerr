import type { TvDetails } from '@server/models/Tv';

export {
  getMovieReleaseStatus,
  type MovieReleaseStatus,
} from '@server/utils/movieReleaseStatus';

export const getDiscoverRegion = (
  userRegion?: string,
  settingsRegion?: string
): string => userRegion || settingsRegion || 'US';

export interface SeasonReleaseStatus {
  /** True when zero episodes of the season have aired yet. */
  isUnreleased: boolean;
  /** The season's TMDB air date, if known, as an ISO date string. */
  airDate?: string;
  /** Number of episodes of the season that have aired so far. */
  airedEpisodeCount: number;
}

/**
 * Work out how many episodes of a TV season have aired, and whether the
 * season should be considered unreleased (zero aired episodes). Specials
 * (season 0) are always treated as released based on their own episode
 * count. Unknown seasons (or a missing show) are reported as released so we
 * never incorrectly flag something we can't evaluate.
 */
export const getSeasonReleaseStatus = (
  show: Pick<TvDetails, 'lastEpisodeToAir' | 'seasons'> | undefined,
  seasonNumber: number,
  now = new Date()
): SeasonReleaseStatus => {
  if (seasonNumber === 0) {
    const specialSeason = show?.seasons.find((s) => s.seasonNumber === 0);
    const airedEpisodeCount = specialSeason?.episodeCount ?? 0;
    return {
      isUnreleased: airedEpisodeCount === 0,
      airDate: specialSeason?.airDate || undefined,
      airedEpisodeCount,
    };
  }

  if (!show) {
    return { isUnreleased: false, airedEpisodeCount: 0 };
  }

  const season = show.seasons.find((s) => s.seasonNumber === seasonNumber);
  if (!season) {
    return { isUnreleased: false, airedEpisodeCount: 0 };
  }

  const airDate = season.airDate || undefined;
  const airDateTime = airDate ? new Date(airDate).getTime() : undefined;
  const hasValidPastAirDate =
    airDateTime !== undefined &&
    !Number.isNaN(airDateTime) &&
    airDateTime <= now.getTime();

  if (!hasValidPastAirDate) {
    return { isUnreleased: true, airDate, airedEpisodeCount: 0 };
  }

  const episodeCount = season.episodeCount;
  const last = show.lastEpisodeToAir;
  let airedEpisodeCount: number;

  if (!last) {
    airedEpisodeCount = episodeCount;
  } else if (seasonNumber < last.seasonNumber) {
    airedEpisodeCount = episodeCount;
  } else if (seasonNumber === last.seasonNumber) {
    airedEpisodeCount =
      episodeCount === 0
        ? last.episodeNumber
        : Math.min(Math.max(last.episodeNumber, 0), episodeCount);
  } else {
    // seasonNumber > last.seasonNumber: data is inconsistent (an air date in
    // the past for a season after the last aired one); be conservative and
    // don't flag it as unreleased.
    airedEpisodeCount = episodeCount;
  }

  return {
    isUnreleased: airedEpisodeCount === 0,
    airDate,
    airedEpisodeCount,
  };
};
