import { MediaRequestStatus, MediaType } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import type Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import {
  completeTvRequestIfSatisfied,
  fetchTvShowForCompletion,
} from '@server/lib/tvRequestCompletion';
import logger from '@server/logger';
import { In } from 'typeorm';

export interface TvRequestReconcileResult {
  checked: number;
  completed: number;
}

let running = false;

/**
 * Whether a reconcile sweep is currently in progress, for the scheduled
 * jobs UI.
 */
export function isTvRequestReconcileRunning(): boolean {
  return running;
}

/**
 * Periodic sweep that catches TV requests which should have completed on
 * their own seasons (see server/lib/tvRequestCompletion.ts) but never got a
 * Media update to trigger MediaSubscriber, e.g. a request whose seasons
 * finished airing/became available without any further scan touching the
 * show's overall status.
 */
export async function reconcileTvRequests(): Promise<TvRequestReconcileResult> {
  running = true;

  try {
    const requestRepository = getRepository(MediaRequest);

    const requests = await requestRepository.find({
      relations: {
        media: { seasons: true },
        seasons: true,
        requestedBy: true,
        modifiedBy: true,
      },
      where: {
        type: MediaType.TV,
        isUpgrade: false,
        status: In([MediaRequestStatus.APPROVED, MediaRequestStatus.FAILED]),
      },
    });

    const requestsByMedia = new Map<
      number,
      { media: Media; requests: MediaRequest[] }
    >();

    for (const request of requests) {
      if (!request.media) {
        continue;
      }

      const existing = requestsByMedia.get(request.media.id);

      if (existing) {
        existing.requests.push(request);
      } else {
        requestsByMedia.set(request.media.id, {
          media: request.media,
          requests: [request],
        });
      }
    }

    let checked = 0;
    let completed = 0;

    for (const { media, requests: mediaRequests } of requestsByMedia.values()) {
      const tvShow = await fetchTvShowForCompletion(media.tmdbId);

      for (const request of mediaRequests) {
        checked++;

        const statusChanged = await completeTvRequestIfSatisfied(
          dataSource.manager,
          request,
          media.seasons ?? [],
          tvShow
        );

        if (statusChanged) {
          completed++;
        }
      }
    }

    logger.info('TV request reconcile complete', {
      label: 'TV Request Reconcile',
      checked,
      completed,
    });

    return { checked, completed };
  } finally {
    running = false;
  }
}
