import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import type { TvRequestCompletionShow } from '@server/lib/tvRequestCompletion';
import {
  completeTvRequestIfSatisfied,
  fetchTvShowForCompletion,
} from '@server/lib/tvRequestCompletion';
import logger from '@server/logger';
import { withNestedTransaction } from '@server/utils/nestedTransaction';
import type {
  EntityManager,
  EntitySubscriberInterface,
  UpdateEvent,
} from 'typeorm';
import { EventSubscriber, In } from 'typeorm';

@EventSubscriber()
export class MediaSubscriber implements EntitySubscriberInterface<Media> {
  private async updateChildRequestStatus(
    manager: EntityManager,
    event: Media,
    is4k: boolean
  ) {
    const requestRepository = manager.getRepository(MediaRequest);

    const requests = await requestRepository.find({
      where: { media: { id: event.id } },
    });

    for (const request of requests) {
      if (
        request.is4k === is4k &&
        request.status === MediaRequestStatus.PENDING
      ) {
        request.status = MediaRequestStatus.APPROVED;
        await requestRepository.save(request);
      }
    }
  }

  /**
   * A request needs the TMDB show (to tell an unaired season apart from one
   * that's simply missing) only when it has a requested season that isn't
   * already AVAILABLE/DELETED on the media itself.
   */
  private requestHasUnavailableSeason(request: MediaRequest, event: Media) {
    const statusKey = request.is4k ? 'status4k' : 'status';

    return request.seasons.some((requestSeason) => {
      const mediaSeason = event.seasons.find(
        (season) => season.seasonNumber === requestSeason.seasonNumber
      );

      return (
        !mediaSeason ||
        (mediaSeason[statusKey] !== MediaStatus.AVAILABLE &&
          mediaSeason[statusKey] !== MediaStatus.DELETED)
      );
    });
  }

  private async updateRelatedMediaRequest(
    manager: EntityManager,
    event: Media,
    databaseEvent: Media,
    is4k: boolean
  ) {
    const requestRepository = manager.getRepository(MediaRequest);

    const relatedRequests = await requestRepository.find({
      relations: {
        media: true,
      },
      where: {
        media: { id: event.id },
        status: In([MediaRequestStatus.APPROVED, MediaRequestStatus.FAILED]),
        is4k,
      },
    });

    // Fetch TMDB at most once per call, and only if some request actually
    // needs it to tell an unaired season apart from a missing one.
    let tvShow: TvRequestCompletionShow | undefined;
    let tvShowFetched = false;
    const getTvShow = async (): Promise<
      TvRequestCompletionShow | undefined
    > => {
      if (!tvShowFetched) {
        tvShowFetched = true;
        tvShow = await fetchTvShowForCompletion(event.tmdbId);
      }
      return tvShow;
    };

    // Check the media entity status and if available
    // or deleted, set the related request to completed
    if (relatedRequests.length > 0) {
      const completedRequests: MediaRequest[] = [];

      for (const request of relatedRequests) {
        if (event.mediaType === MediaType.MOVIE) {
          if (
            event[request.is4k ? 'status4k' : 'status'] ===
              MediaStatus.AVAILABLE ||
            event[request.is4k ? 'status4k' : 'status'] === MediaStatus.DELETED
          ) {
            request.status = MediaRequestStatus.COMPLETED;
            completedRequests.push(request);
          }
        } else if (event.mediaType === MediaType.TV) {
          const show = this.requestHasUnavailableSeason(request, event)
            ? await getTvShow()
            : undefined;

          const statusChanged = await completeTvRequestIfSatisfied(
            manager,
            request,
            event.seasons,
            show
          );

          if (!statusChanged) {
            // The show's overall status (rolled up from aired seasons) can
            // still complete the request even when its own seasons aren't
            // individually satisfied, e.g. a request for a season that
            // wasn't tracked as a SeasonRequest.
            if (
              event[request.is4k ? 'status4k' : 'status'] ===
                MediaStatus.AVAILABLE ||
              event[request.is4k ? 'status4k' : 'status'] ===
                MediaStatus.DELETED
            ) {
              request.status = MediaRequestStatus.COMPLETED;
              completedRequests.push(request);
            }
          }
        }
      }

      if (completedRequests.length > 0) {
        await requestRepository.save(completedRequests);
      }
    }

    // Already-completed TV requests can still have unaired seasons pending
    // (e.g. season 28 of a show whose season 27 already rolled the media up
    // to AVAILABLE). Keep their SeasonRequest rows in sync as those seasons
    // land, without re-saving the parent MediaRequest: its status is
    // unchanged, and re-saving it would re-fire the availability
    // notification in MediaRequestSubscriber.afterUpdate.
    if (event.mediaType === MediaType.TV) {
      const completedTvRequests = await requestRepository.find({
        relations: {
          media: true,
        },
        where: {
          media: { id: event.id },
          status: MediaRequestStatus.COMPLETED,
          is4k,
        },
      });

      for (const request of completedTvRequests) {
        const show = this.requestHasUnavailableSeason(request, event)
          ? await getTvShow()
          : undefined;

        await completeTvRequestIfSatisfied(
          manager,
          request,
          event.seasons,
          show
        );
      }
    }
  }

  public async beforeUpdate(event: UpdateEvent<Media>): Promise<void> {
    if (!event.entity || !event.databaseEntity) {
      return;
    }

    try {
      if (
        event.entity.status === MediaStatus.AVAILABLE &&
        event.databaseEntity?.status === MediaStatus.PENDING
      ) {
        await withNestedTransaction(event.manager, async (manager) => {
          await this.updateChildRequestStatus(
            manager,
            event.entity as Media,
            false
          );
        });
      }
    } catch (e) {
      logger.error(
        'Error while updating child request status in beforeUpdate subscriber',
        {
          label: 'Media',
          mediaId: event.entity.id,
          is4k: false,
          errorMessage: e instanceof Error ? e.message : String(e),
        }
      );
    }

    try {
      if (
        event.entity.status4k === MediaStatus.AVAILABLE &&
        event.databaseEntity?.status4k === MediaStatus.PENDING
      ) {
        await withNestedTransaction(event.manager, async (manager) => {
          await this.updateChildRequestStatus(
            manager,
            event.entity as Media,
            true
          );
        });
      }
    } catch (e) {
      logger.error(
        'Error while updating child request status in beforeUpdate subscriber',
        {
          label: 'Media',
          mediaId: event.entity.id,
          is4k: true,
          errorMessage: e instanceof Error ? e.message : String(e),
        }
      );
    }

    // Manually load related seasons into databaseEntity
    // for seasonStatusCheck in afterUpdate
    const seasons = await event.manager
      .getRepository(Season)
      .createQueryBuilder('season')
      .leftJoin('season.media', 'media')
      .where('media.id = :id', { id: event.databaseEntity.id })
      .getMany();

    event.databaseEntity.seasons = seasons;
  }

  public async afterUpdate(event: UpdateEvent<Media>): Promise<void> {
    if (!event.entity || !event.databaseEntity) {
      return;
    }

    const validStatuses = [
      MediaStatus.PARTIALLY_AVAILABLE,
      MediaStatus.AVAILABLE,
      MediaStatus.DELETED,
    ];

    const seasonStatusCheck = (is4k: boolean) => {
      return event.entity?.seasons?.some((season: Season, index: number) => {
        const previousSeason = event.databaseEntity.seasons[index];

        return (
          season[is4k ? 'status4k' : 'status'] !==
          previousSeason?.[is4k ? 'status4k' : 'status']
        );
      });
    };

    try {
      if (
        (event.entity.status !== event.databaseEntity?.status ||
          (event.entity.mediaType === MediaType.TV &&
            seasonStatusCheck(false))) &&
        validStatuses.includes(event.entity.status)
      ) {
        await withNestedTransaction(event.manager, async (manager) => {
          await this.updateRelatedMediaRequest(
            manager,
            event.entity as Media,
            event.databaseEntity as Media,
            false
          );
        });
      }
    } catch (e) {
      logger.error(
        'Error while updating related requests in afterUpdate subscriber',
        {
          label: 'Media',
          mediaId: event.entity.id,
          is4k: false,
          errorMessage: e instanceof Error ? e.message : String(e),
        }
      );
    }

    try {
      if (
        (event.entity.status4k !== event.databaseEntity?.status4k ||
          (event.entity.mediaType === MediaType.TV &&
            seasonStatusCheck(true))) &&
        validStatuses.includes(event.entity.status4k)
      ) {
        await withNestedTransaction(event.manager, async (manager) => {
          await this.updateRelatedMediaRequest(
            manager,
            event.entity as Media,
            event.databaseEntity as Media,
            true
          );
        });
      }
    } catch (e) {
      logger.error(
        'Error while updating related requests in afterUpdate subscriber',
        {
          label: 'Media',
          mediaId: event.entity.id,
          is4k: true,
          errorMessage: e instanceof Error ? e.message : String(e),
        }
      );
    }
  }

  public listenTo(): typeof Media {
    return Media;
  }
}
