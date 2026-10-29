import type { MismatchStatus } from '@server/lib/availabilityMismatch';

export interface AvailabilityMismatchItem {
  id: number;
  mediaId: number;
  tmdbId: number;
  title: string | null;
  seasonNumber: number;
  plexEpisodes: number;
  sonarrEpisodes: number;
  status: MismatchStatus;
  firstSeenAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  resolvedBy: { id: number; displayName: string } | null;
}

export interface AvailabilityMismatchResultsResponse {
  results: AvailabilityMismatchItem[];
}

export interface AvailabilityMismatchFineResponse {
  mismatch: AvailabilityMismatchItem;
  /** Whether the Seerr season was marked available as well. */
  markedAvailable: boolean;
}

export interface AvailabilityMismatchFixedResponse {
  mismatch: AvailabilityMismatchItem;
  /** Set on a 409: the counts still disagree. */
  message?: string;
}
