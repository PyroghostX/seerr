export interface AiredEpisodeShow {
  last_episode_to_air?: {
    season_number: number;
    episode_number: number;
  } | null;
}

export interface AiredEpisodeSeason {
  season_number: number;
  episode_count: number;
  air_date?: string | null;
}

/**
 * Episodes of this season that have aired as of `now`. 0 means the season
 * has not started airing yet.
 *
 * Specials (season 0) are excluded from this logic and always return the
 * season's full episode count, since they're handled elsewhere.
 */
export function airedEpisodeCount(
  show: AiredEpisodeShow,
  season: AiredEpisodeSeason,
  now = new Date()
): number {
  if (season.season_number === 0) {
    return season.episode_count;
  }

  if (!season.air_date) {
    return 0;
  }

  const airDate = parseUtcDate(season.air_date);

  if (!airDate || airDate.getTime() > now.getTime()) {
    return 0;
  }

  const last = show.last_episode_to_air;

  if (!last) {
    return season.episode_count;
  }

  if (season.season_number < last.season_number) {
    return season.episode_count;
  }

  if (season.season_number === last.season_number) {
    if (season.episode_count === 0) {
      return last.episode_number;
    }

    return clamp(last.episode_number, 0, season.episode_count);
  }

  // season_number > last.season_number: the season's air_date has already
  // passed, but TMDB's last_episode_to_air hasn't caught up with it yet.
  // Be conservative and keep the old behaviour (treat it as fully aired).
  return season.episode_count;
}

function parseUtcDate(dateString: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString.trim());

  if (!match) {
    return null;
  }

  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));

  return Number.isNaN(date.getTime()) ? null : date;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
