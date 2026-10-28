import SonarrAPI, {
  type SonarrMissingEpisode,
} from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieDetails,
  TmdbTvDetails,
} from '@server/api/themoviedb/interfaces';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import type Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import type Season from '@server/entity/Season';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { airedEpisodeCount } from '@server/utils/airedEpisodes';
import { getMovieReleaseStatus } from '@server/utils/movieReleaseStatus';
import axios from 'axios';
import { LessThan } from 'typeorm';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// A request this old that still isn't available gets reported.
export const UNFILLED_AFTER_MS = 24 * HOUR_MS;
// Missing episodes that aired between these two ages get reported: younger
// ones are probably still downloading, older ones were reported already.
export const MISSING_MIN_AGE_MS = 20 * HOUR_MS;
export const MISSING_MAX_AGE_MS = 14 * DAY_MS;

export const UNFILLED_LINE_CAP = 15;
export const MISSING_LINE_CAP = 20;
// Discord rejects webhook messages whose content is over 2000 characters.
export const DISCORD_CONTENT_LIMIT = 2000;
const MAX_LINE_LENGTH = 200;

export interface UnfilledRequestLine {
  title: string;
  year?: string;
  requestedBy: string;
  createdAt: Date;
  /** Requested TV seasons that have aired but are not available yet. */
  missingSeasons?: number[];
}

export interface MissingEpisodeLine {
  seriesTitle: string;
  seasonNumber: number;
  episodeNumber: number;
  airDateUtc: string;
}

/**
 * Whether an approved request is old enough and still unavailable at its own
 * quality (status4k for 4K requests) to be a Morning Check candidate. Movie
 * release and TV aired-season checks happen afterwards with TMDB data.
 */
export function isUnfilledCandidate(
  request: Pick<
    MediaRequest,
    'status' | 'isUpgrade' | 'createdAt' | 'is4k' | 'media'
  >,
  now = new Date()
): boolean {
  if (request.status !== MediaRequestStatus.APPROVED || request.isUpgrade) {
    return false;
  }

  if (!request.media) {
    return false;
  }

  const createdAt = new Date(request.createdAt).getTime();

  if (
    Number.isNaN(createdAt) ||
    now.getTime() - createdAt <= UNFILLED_AFTER_MS
  ) {
    return false;
  }

  const status = request.is4k ? request.media.status4k : request.media.status;

  return status !== MediaStatus.AVAILABLE;
}

/**
 * Whether a movie can be watched at home yet, using the same rules as the
 * client's release badges.
 */
export function isMovieReleased(
  movie: Pick<TmdbMovieDetails, 'release_dates' | 'release_date' | 'status'>,
  region = 'US',
  now = new Date()
): boolean {
  return !getMovieReleaseStatus(
    {
      releases: movie.release_dates,
      releaseDate: movie.release_date,
      status: movie.status,
    },
    region,
    now.getTime()
  ).isUnreleased;
}

/**
 * Requested seasons that are not completed/available yet but have at least
 * one aired episode, sorted. An empty result means the request is not
 * overdue (everything outstanding is still unaired, or TMDB was missing).
 */
export function missingAiredSeasons(
  request: Pick<MediaRequest, 'is4k' | 'seasons'>,
  mediaSeasons: Pick<Season, 'seasonNumber' | 'status' | 'status4k'>[],
  tvShow: Pick<TmdbTvDetails, 'last_episode_to_air' | 'seasons'> | undefined,
  now = new Date()
): number[] {
  if (!tvShow) {
    return [];
  }

  const statusKey = request.is4k ? 'status4k' : 'status';
  const missing: number[] = [];

  for (const requestSeason of request.seasons ?? []) {
    if (requestSeason.status === MediaRequestStatus.COMPLETED) {
      continue;
    }

    const mediaSeason = mediaSeasons.find(
      (season) => season.seasonNumber === requestSeason.seasonNumber
    );

    if (
      mediaSeason &&
      (mediaSeason[statusKey] === MediaStatus.AVAILABLE ||
        mediaSeason[statusKey] === MediaStatus.DELETED)
    ) {
      continue;
    }

    const tmdbSeason = tvShow.seasons.find(
      (season) => season.season_number === requestSeason.seasonNumber
    );

    if (tmdbSeason && airedEpisodeCount(tvShow, tmdbSeason, now) > 0) {
      missing.push(requestSeason.seasonNumber);
    }
  }

  return missing.sort((a, b) => a - b);
}

/**
 * Sonarr missing episodes that aired more than 20 hours and less than 14
 * days ago, sorted by series title then season and episode.
 */
export function filterRecentMissing(
  records: SonarrMissingEpisode[],
  seriesTitles: Map<number, string>,
  now = new Date()
): MissingEpisodeLine[] {
  const lines: MissingEpisodeLine[] = [];

  for (const record of records) {
    if (!record.airDateUtc) {
      continue;
    }

    const airTime = new Date(record.airDateUtc).getTime();

    if (Number.isNaN(airTime)) {
      continue;
    }

    const age = now.getTime() - airTime;

    if (age <= MISSING_MIN_AGE_MS || age >= MISSING_MAX_AGE_MS) {
      continue;
    }

    lines.push({
      seriesTitle:
        seriesTitles.get(record.seriesId) ?? `Series ${record.seriesId}`,
      seasonNumber: record.seasonNumber,
      episodeNumber: record.episodeNumber,
      airDateUtc: record.airDateUtc,
    });
  }

  return lines.sort(
    (a, b) =>
      a.seriesTitle.localeCompare(b.seriesTitle) ||
      a.seasonNumber - b.seasonNumber ||
      a.episodeNumber - b.episodeNumber
  );
}

export function formatUnfilledLine(
  line: UnfilledRequestLine,
  now = new Date()
): string {
  const days = Math.max(
    1,
    Math.floor((now.getTime() - new Date(line.createdAt).getTime()) / DAY_MS)
  );
  const title = line.year ? `${line.title} (${line.year})` : line.title;
  let text = `• ${title} — requested by ${line.requestedBy}, ${days} ${
    days === 1 ? 'day' : 'days'
  } ago`;

  if (line.missingSeasons?.length) {
    text += ` — ${line.missingSeasons.map((n) => `S${n}`).join(', ')}`;
  }

  return truncate(text);
}

export function formatMissingLine(line: MissingEpisodeLine): string {
  return truncate(
    `• ${line.seriesTitle} — S${line.seasonNumber}E${line.episodeNumber}`
  );
}

function truncate(text: string): string {
  return text.length > MAX_LINE_LENGTH
    ? `${text.slice(0, MAX_LINE_LENGTH - 1)}…`
    : text;
}

function renderSection(header: string, lines: string[], cap: number): string {
  const shown = lines.slice(0, cap);
  const rest = lines.length - shown.length;
  const out = [header, ...shown];

  if (rest > 0) {
    out.push(`…and ${rest} more`);
  }

  return out.join('\n');
}

/**
 * The whole Morning Check message, or null when there is nothing to report.
 * Lists are capped (15 requests, 20 episodes) and trimmed further, longest
 * list first, until the message fits Discord's content limit.
 */
export function buildMorningCheckMessage(
  unfilledLines: string[],
  missingLines: string[],
  limit = DISCORD_CONTENT_LIMIT
): string | null {
  if (!unfilledLines.length && !missingLines.length) {
    return null;
  }

  let unfilledCap = Math.min(UNFILLED_LINE_CAP, unfilledLines.length);
  let missingCap = Math.min(MISSING_LINE_CAP, missingLines.length);

  const render = (): string => {
    const sections: string[] = [];

    if (unfilledLines.length) {
      sections.push(
        renderSection(
          `**${unfilledLines.length} ${
            unfilledLines.length === 1 ? 'request' : 'requests'
          } not filled after 24 hours:**`,
          unfilledLines,
          unfilledCap
        )
      );
    }

    if (missingLines.length) {
      sections.push(
        renderSection(
          `**${missingLines.length} recently missing ${
            missingLines.length === 1 ? 'episode' : 'episodes'
          }:**`,
          missingLines,
          missingCap
        )
      );
    }

    return sections.join('\n\n');
  };

  let message = render();

  while (message.length > limit && (unfilledCap > 0 || missingCap > 0)) {
    if (missingCap >= unfilledCap) {
      missingCap--;
    } else {
      unfilledCap--;
    }
    message = render();
  }

  return message;
}

let running = false;

/**
 * Whether a Morning Check is currently in progress, for the scheduled jobs
 * UI.
 */
export function isMorningCheckRunning(): boolean {
  return running;
}

function getMorningCheckWebhook(): string | undefined {
  const discord = getSettings().notifications.agents.discord;
  const { morningCheckWebhookUrl, webhookUrl, webhookThreadId } =
    discord.options;

  // The Morning Check is its own job: its webhook works even with the Discord
  // agent turned off. Falling back to the channel webhook needs the agent on.
  if (morningCheckWebhookUrl) {
    return morningCheckWebhookUrl;
  }

  if (!discord.enabled || !webhookUrl) {
    return undefined;
  }

  const url = new URL(webhookUrl);

  if (webhookThreadId) {
    url.searchParams.set('thread_id', webhookThreadId);
  }

  return url.toString();
}

async function collectUnfilledRequests(
  now: Date
): Promise<UnfilledRequestLine[]> {
  const settings = getSettings();
  const region = settings.main.discoverRegion || 'US';
  const tmdb = new TheMovieDb();
  const requestRepository = getRepository(MediaRequest);

  const requests = await requestRepository.find({
    relations: {
      media: { seasons: true },
      seasons: true,
      requestedBy: true,
    },
    where: {
      status: MediaRequestStatus.APPROVED,
      isUpgrade: false,
      createdAt: LessThan(new Date(now.getTime() - UNFILLED_AFTER_MS)),
    },
    order: { createdAt: 'ASC' },
  });

  const movies = new Map<number, TmdbMovieDetails | null>();
  const shows = new Map<number, TmdbTvDetails | null>();
  const lines: UnfilledRequestLine[] = [];

  for (const request of requests) {
    if (!isUnfilledCandidate(request, now)) {
      continue;
    }

    const media = request.media as Media;
    const requestedBy = request.requestedBy?.displayName ?? 'Unknown';

    try {
      if (request.type === MediaType.MOVIE) {
        if (!movies.has(media.tmdbId)) {
          movies.set(
            media.tmdbId,
            await tmdb.getMovie({ movieId: media.tmdbId }).catch((e) => {
              logger.warn('Failed to fetch TMDB movie for Morning Check', {
                label: 'Morning Check',
                tmdbId: media.tmdbId,
                errorMessage: e.message,
              });
              return null;
            })
          );
        }

        const movie = movies.get(media.tmdbId);

        if (!movie || !isMovieReleased(movie, region, now)) {
          continue;
        }

        lines.push({
          title: movie.title,
          year: movie.release_date?.slice(0, 4) || undefined,
          requestedBy,
          createdAt: request.createdAt,
        });
      } else {
        if (!shows.has(media.tmdbId)) {
          shows.set(
            media.tmdbId,
            await tmdb.getTvShow({ tvId: media.tmdbId }).catch((e) => {
              logger.warn('Failed to fetch TMDB show for Morning Check', {
                label: 'Morning Check',
                tmdbId: media.tmdbId,
                errorMessage: e.message,
              });
              return null;
            })
          );
        }

        const show = shows.get(media.tmdbId);

        if (!show) {
          continue;
        }

        const missingSeasons = missingAiredSeasons(
          request,
          media.seasons ?? [],
          show,
          now
        );

        if (!missingSeasons.length) {
          continue;
        }

        lines.push({
          title: show.name,
          year: show.first_air_date?.slice(0, 4) || undefined,
          requestedBy,
          createdAt: request.createdAt,
          missingSeasons,
        });
      }
    } catch (e) {
      logger.warn('Failed to check request for Morning Check', {
        label: 'Morning Check',
        requestId: request.id,
        errorMessage: e.message,
      });
    }
  }

  return lines;
}

async function collectMissingEpisodes(
  now: Date
): Promise<MissingEpisodeLine[]> {
  const lines: MissingEpisodeLine[] = [];

  for (const server of getSettings().sonarr.filter((s) => !s.is4k)) {
    try {
      const sonarr = new SonarrAPI({
        apiKey: server.apiKey,
        url: SonarrAPI.buildUrl(server, '/api/v3'),
      });
      const [series, missing] = await Promise.all([
        sonarr.getSeries(),
        sonarr.getWantedMissing(1000),
      ]);
      const titles = new Map<number, string>();

      for (const s of series) {
        if (s.id !== undefined) {
          titles.set(s.id, s.title);
        }
      }

      lines.push(...filterRecentMissing(missing, titles, now));
    } catch (e) {
      logger.warn('Failed to fetch missing episodes for Morning Check', {
        label: 'Morning Check',
        server: server.name,
        errorMessage: e.message,
      });
    }
  }

  return lines;
}

/**
 * Daily Discord summary of approved requests still not filled after a day
 * (released movies, TV with aired but unavailable seasons) and episodes
 * Sonarr has been missing for a while. Sends nothing when both are empty.
 */
export async function runMorningCheck(): Promise<void> {
  if (running) {
    return;
  }

  running = true;

  try {
    const webhookUrl = getMorningCheckWebhook();

    if (!webhookUrl) {
      logger.info('Morning Check skipped: no Discord webhook configured', {
        label: 'Morning Check',
      });
      return;
    }

    const now = new Date();
    const unfilled = await collectUnfilledRequests(now);
    const missing = await collectMissingEpisodes(now);

    const message = buildMorningCheckMessage(
      unfilled.map((line) => formatUnfilledLine(line, now)),
      missing.map(formatMissingLine)
    );

    if (message) {
      const settings = getSettings();
      const { botUsername, botAvatarUrl } =
        settings.notifications.agents.discord.options;

      await axios.post(webhookUrl, {
        username: botUsername || settings.main.applicationTitle,
        avatar_url: botAvatarUrl || undefined,
        content: message,
        allowed_mentions: { parse: [] },
      });
    }

    logger.info('Morning Check complete', {
      label: 'Morning Check',
      unfilledRequests: unfilled.length,
      missingEpisodes: missing.length,
      sent: !!message,
    });
  } finally {
    running = false;
  }
}
