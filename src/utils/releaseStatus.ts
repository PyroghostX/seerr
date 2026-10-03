import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';

// TMDB release date types:
// 1 Premiere, 2 Theatrical (limited), 3 Theatrical, 4 Digital, 5 Physical, 6 TV
const HOME_RELEASE_TYPES = [4, 5, 6];

// A movie whose theatrical/primary release is older than this is assumed to be
// available at home even if TMDB has no digital/physical entry for it.
const ASSUME_RELEASED_AFTER_DAYS = 180;

// TMDB production statuses for a movie that has not come out at all yet.
// These often have no release date or release entries (e.g. a rumored
// sequel), so the date-based checks below would miss them.
const PRE_RELEASE_STATUSES = [
  'Rumored',
  'Planned',
  'In Production',
  'Post Production',
];

export interface MovieReleaseStatus {
  /** True when no digital, physical or TV release has happened yet. */
  isUnreleased: boolean;
  /** Earliest known digital (streaming) release date, past or future, ISO string. */
  digitalReleaseDate?: string;
  /** Earliest known home release of any kind (digital, physical, TV). */
  homeReleaseDate?: string;
}

const toTime = (value?: string): number | undefined => {
  if (!value) {
    return undefined;
  }
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? undefined : time;
};

/**
 * Work out whether a movie can be watched at home yet, based on TMDB release
 * dates. Region-specific dates win; if the region has no home-release entry at
 * all, fall back to every region so a US-only digital release still counts.
 */
export const getMovieReleaseStatus = (
  movie: Pick<MovieDetails, 'releases' | 'releaseDate' | 'status'> | undefined,
  region = 'US'
): MovieReleaseStatus => {
  if (!movie) {
    return { isUnreleased: false };
  }
  const now = Date.now();
  const allResults = movie.releases?.results ?? [];
  const regionDates =
    allResults.find((r) => r.iso_3166_1 === region)?.release_dates ?? [];
  const regionHome = regionDates.filter((r) =>
    HOME_RELEASE_TYPES.includes(r.type)
  );
  const homeDates =
    regionHome.length > 0
      ? regionHome
      : allResults
          .flatMap((r) => r.release_dates)
          .filter((r) => HOME_RELEASE_TYPES.includes(r.type));

  const sortedHome = [...homeDates].sort(
    (a, b) => (toTime(a.release_date) ?? 0) - (toTime(b.release_date) ?? 0)
  );
  const digital = sortedHome.find((r) => r.type === 4);
  const homeReleaseDate = sortedHome[0]?.release_date;
  const digitalReleaseDate = digital?.release_date;

  const homeReleased = sortedHome.some((r) => {
    const t = toTime(r.release_date);
    return t !== undefined && t <= now;
  });
  if (homeReleased) {
    return { isUnreleased: false, digitalReleaseDate, homeReleaseDate };
  }

  if (PRE_RELEASE_STATUSES.includes(movie.status)) {
    return { isUnreleased: true, digitalReleaseDate, homeReleaseDate };
  }

  // No home release on record: an old film is almost certainly available
  // anyway; a recent or upcoming one is genuinely unreleased.
  const primaryTime = toTime(movie.releaseDate);
  const ageDays =
    primaryTime !== undefined ? (now - primaryTime) / 86_400_000 : undefined;
  const isUnreleased =
    ageDays === undefined ? false : ageDays < ASSUME_RELEASED_AFTER_DAYS;

  return { isUnreleased, digitalReleaseDate, homeReleaseDate };
};

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
