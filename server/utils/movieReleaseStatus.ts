import type { MovieDetails } from '@server/models/Movie';

// Shared by the client (release badges, request modals) and the server
// (Morning Check), so both agree on whether a movie is out yet.

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
  region = 'US',
  now = Date.now()
): MovieReleaseStatus => {
  if (!movie) {
    return { isUnreleased: false };
  }
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
