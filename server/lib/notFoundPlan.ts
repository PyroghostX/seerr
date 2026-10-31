import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
  NOT_FOUND_CLOSABLE_STATUSES,
} from '@server/constants/media';

/**
 * Decides what closing a request as "could not find it" does, given what
 * Seerr and the arr know. Only decisions live here; server/lib/notFoundClose.ts
 * carries them out.
 */

export interface PlanMediaSeason {
  seasonNumber: number;
  status: MediaStatus;
  status4k: MediaStatus;
}

export interface PlanRequest {
  id: number;
  status: MediaRequestStatus;
  is4k: boolean;
  isUpgrade: boolean;
  seasons: { seasonNumber: number; status: MediaRequestStatus }[];
}

export interface PlanInput {
  request: PlanRequest;
  /** Every other request on this media */
  otherRequests: PlanRequest[];
  media: {
    mediaType: MediaType;
    status: MediaStatus;
    status4k: MediaStatus;
    seasons: PlanMediaSeason[];
  };
  /** The arr of the request's own quality. hasFiles is false when not in it. */
  arr: { inArr: boolean; hasFiles: boolean };
}

export type ArrAction = 'none' | 'remove' | 'unmonitor';

/**
 * blocklist: a Blocklist row and both media statuses
 * quality: only this quality's media status (movie)
 * seasons: only the closed seasons' rows (TV)
 */
export type BlockKind = 'blocklist' | 'quality' | 'seasons';

export type PlanRefusal = 'file-in-arr' | 'already-available';

export interface NotFoundPlan {
  closedSeasons: number[];
  /** Requests that become CLOSED, including the one being closed */
  closeRequestIds: number[];
  /** Requests that stay open but lose these seasons */
  partialRequests: { id: number; seasons: number[] }[];
  arrAction: ArrAction;
  block: BlockKind;
  /** The arr no longer holds it, so the media's link to it is stale */
  clearServiceData: boolean;
  /** Nothing is on its way anymore, so PENDING/PROCESSING would be stale */
  resetMediaStatus: boolean;
}

const hasAny = (status: MediaStatus) =>
  status === MediaStatus.AVAILABLE ||
  status === MediaStatus.PARTIALLY_AVAILABLE;

const isOpen = (request: PlanRequest) =>
  !request.isUpgrade && NOT_FOUND_CLOSABLE_STATUSES.includes(request.status);

export const planNotFoundClose = ({
  request,
  otherRequests,
  media,
  arr,
}: PlanInput): NotFoundPlan | { refused: PlanRefusal } => {
  const isMovie = media.mediaType === MediaType.MOVIE;
  const statusKey = request.is4k ? 'status4k' : 'status';
  const otherKey = request.is4k ? 'status' : 'status4k';

  const availableSeasons = new Set(
    media.seasons
      .filter((season) => season[statusKey] === MediaStatus.AVAILABLE)
      .map((season) => season.seasonNumber)
  );
  const outstanding = (r: PlanRequest) =>
    r.seasons
      .filter(
        (season) =>
          season.status !== MediaRequestStatus.CLOSED &&
          !availableSeasons.has(season.seasonNumber)
      )
      .map((season) => season.seasonNumber);

  const closedSeasons = isMovie ? [] : outstanding(request);

  if (
    isMovie ? media[statusKey] === MediaStatus.AVAILABLE : !closedSeasons.length
  ) {
    return { refused: 'already-available' };
  }

  if (isMovie && arr.hasFiles) {
    return { refused: 'file-in-arr' };
  }

  const open = otherRequests.filter(isOpen);
  const sameQuality = open.filter((r) => r.is4k === request.is4k);

  const closeRequestIds = [request.id];
  const partialRequests: NotFoundPlan['partialRequests'] = [];
  let requestsStayOpen = false;

  for (const other of sameQuality) {
    const remaining = outstanding(other);
    const lost = remaining.filter((s) => closedSeasons.includes(s));

    if (isMovie || (remaining.length > 0 && lost.length === remaining.length)) {
      closeRequestIds.push(other.id);
    } else if (remaining.length > 0) {
      requestsStayOpen = true;

      if (lost.length > 0) {
        partialRequests.push({ id: other.id, seasons: lost });
      }
    }
  }

  // A request still open at the other quality, or one left open above, needs
  // the title to stay requestable and, at this quality, the series to stay in
  // Sonarr.
  const otherQualityActive =
    open.some((r) => r.is4k !== request.is4k) ||
    media[otherKey] === MediaStatus.PENDING ||
    media[otherKey] === MediaStatus.PROCESSING;

  const anythingAvailable =
    hasAny(media.status) ||
    hasAny(media.status4k) ||
    media.seasons.some(
      (season) => hasAny(season.status) || hasAny(season.status4k)
    );

  const block: BlockKind =
    !anythingAvailable &&
    !arr.hasFiles &&
    !otherQualityActive &&
    !requestsStayOpen
      ? 'blocklist'
      : isMovie
        ? 'quality'
        : 'seasons';

  const arrAction: ArrAction = !arr.inArr
    ? 'none'
    : arr.hasFiles || requestsStayOpen
      ? 'unmonitor'
      : 'remove';

  return {
    closedSeasons,
    closeRequestIds,
    partialRequests,
    arrAction,
    block,
    clearServiceData: arrAction !== 'unmonitor',
    resetMediaStatus:
      block === 'seasons' &&
      !requestsStayOpen &&
      (media[statusKey] === MediaStatus.PENDING ||
        media[statusKey] === MediaStatus.PROCESSING),
  };
};

export const NOT_FOUND_MESSAGE =
  'Sadly the system could not find your request.';
