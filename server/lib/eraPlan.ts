/**
 * Era plans: a TV request whose seasons match different override rules by
 * air year (e.g. "released in/before 2010 -> 720p") is sent to Sonarr in
 * phases, oldest era first. Sonarr only has one quality profile per series,
 * so each phase switches the profile, un-monitors the previous phase's
 * seasons (so they are not re-grabbed at the new quality) and searches the
 * next era's seasons.
 *
 * The plan is stored as JSON in `media_request.eraPlan`. It is null when the
 * request has a single era (the common case).
 */

export interface EraPhase {
  /** Sonarr quality profile id. null = the server default (resolved when sent). */
  profileId: number | null;
  seasons: number[];
}

export interface EraPlanCurrent extends EraPhase {
  /** Sonarr command ids of the SeasonSearch commands issued for this phase. */
  commandIds: number[];
  /** ISO timestamp of when this phase was sent to Sonarr. */
  startedAt: string;
}

export interface EraPlan {
  /** Phases still to send to Sonarr, in order (oldest era first). */
  pending: EraPhase[];
  /** The phase Sonarr is currently working on. Unset until the request is sent. */
  current?: EraPlanCurrent;
}

export const parseEraPlan = (raw?: string | null): EraPlan | null => {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as EraPlan;
    if (!parsed || !Array.isArray(parsed.pending)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const serializeEraPlan = (plan: EraPlan | null): string | null =>
  plan && plan.pending.length > 0 ? JSON.stringify(plan) : null;

/**
 * The plan without the given seasons, so no later phase re-monitors them.
 * Phases left with no seasons are dropped.
 */
export const removeSeasonsFromEraPlan = (
  plan: EraPlan,
  seasons: number[]
): EraPlan => {
  const keep = (seasonNumber: number) => !seasons.includes(seasonNumber);

  return {
    ...plan,
    pending: plan.pending
      .map((phase) => ({ ...phase, seasons: phase.seasons.filter(keep) }))
      .filter((phase) => phase.seasons.length > 0),
    ...(plan.current && {
      current: {
        ...plan.current,
        seasons: plan.current.seasons.filter(keep),
      },
    }),
  };
};

/**
 * Search order for a set of seasons: the first and last requested seasons
 * first (people usually want to start watching and to catch up on the latest
 * episodes), then the middle seasons in ascending order.
 */
export const orderSeasonsForSearch = (seasons: number[]): number[] => {
  const sorted = [...new Set(seasons)].sort((a, b) => a - b);
  if (sorted.length <= 2) {
    return sorted;
  }
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return [first, last, ...sorted.slice(1, -1)];
};

/**
 * Year a season should be matched against year-based override rules.
 * null = unknown / not aired yet; year rules never match null.
 */
export const seasonAirYear = (airDate?: string | null): number | null => {
  const year = Number((airDate ?? '').slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : null;
};

export interface SeasonEraGroup {
  profileId: number | null;
  seasons: number[];
  /** Smallest known air year in the group; Infinity when no season has a year. */
  minYear: number;
}

/**
 * Group requested seasons by the quality profile that applies to them.
 * `resolveProfile` returns the profile id an override rule gives for a season
 * of that air year, or null for "server default". Groups are returned oldest
 * era first; seasons with unknown years sort last.
 */
export const groupSeasonsByEra = (
  seasons: { seasonNumber: number; year: number | null }[],
  resolveProfile: (year: number | null) => number | null
): SeasonEraGroup[] => {
  const groups = new Map<number | null, SeasonEraGroup>();
  for (const season of seasons) {
    const profileId = resolveProfile(season.year);
    const group = groups.get(profileId) ?? {
      profileId,
      seasons: [],
      minYear: Infinity,
    };
    group.seasons.push(season.seasonNumber);
    if (season.year !== null && season.year < group.minYear) {
      group.minYear = season.year;
    }
    groups.set(profileId, group);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, seasons: g.seasons.sort((a, b) => a - b) }))
    .sort((a, b) => a.minYear - b.minYear);
};
