import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import { parseEraPlan, serializeEraPlan } from '@server/lib/eraPlan';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { IsNull, Not } from 'typeorm';

/**
 * Advances era plans (see server/lib/eraPlan.ts) one phase at a time.
 *
 * A TV request with an era plan has already had its first phase sent to
 * Sonarr by MediaRequestSubscriber#sendToSonarr. This job periodically checks
 * whether the currently active phase looks finished (searches done and
 * nothing left in the queue, all its seasons fully downloaded, or it has
 * simply been running too long) and, if so, applies the next phase: switches
 * the series' quality profile, un-monitors the previous phase's seasons and
 * kicks off searches for the new phase's seasons.
 */
class EraPhaseRunner {
  public running = false;

  public async run(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;

    try {
      const requestRepository = getRepository(MediaRequest);
      const requests = await requestRepository.find({
        where: { type: MediaType.TV, eraPlan: Not(IsNull()) },
        relations: { media: true, seasons: true },
      });

      for (const request of requests) {
        try {
          await this.processRequest(request);
        } catch (e) {
          logger.error('Failed to process era plan for request', {
            label: 'Era Phases',
            requestId: request.id,
            errorMessage: e instanceof Error ? e.message : String(e),
          });
        }
      }
    } catch (e) {
      logger.error('Failed to run era phase job', {
        label: 'Era Phases',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.running = false;
    }
  }

  public cancel(): void {
    this.running = false;
  }

  private async processRequest(request: MediaRequest): Promise<void> {
    const requestRepository = getRepository(MediaRequest);

    const plan = parseEraPlan(request.eraPlan);
    if (!plan || plan.pending.length === 0) {
      await requestRepository.update(request.id, { eraPlan: null });
      return;
    }
    if (!plan.current) {
      // Not sent to Sonarr yet (or mid-send); nothing to do this pass.
      return;
    }
    const current = plan.current;

    const settings = getSettings();
    let sonarrSettings = settings.sonarr.find(
      (sonarr) => sonarr.isDefault && sonarr.is4k === request.is4k
    );
    if (
      request.serverId !== null &&
      request.serverId >= 0 &&
      sonarrSettings?.id !== request.serverId
    ) {
      sonarrSettings = settings.sonarr.find(
        (sonarr) => sonarr.id === request.serverId
      );
    }
    if (!sonarrSettings) {
      logger.warn('No Sonarr server configured for era phase request', {
        label: 'Era Phases',
        requestId: request.id,
      });
      return;
    }

    const media = request.media;
    if (!media) {
      logger.warn('No media found for era phase request', {
        label: 'Era Phases',
        requestId: request.id,
      });
      return;
    }

    const sonarr = new SonarrAPI({
      apiKey: sonarrSettings.apiKey,
      url: SonarrAPI.buildUrl(sonarrSettings, '/api/v3'),
    });

    let seriesId = request.is4k
      ? media.externalServiceId4k
      : media.externalServiceId;

    if (!seriesId) {
      if (!media.tvdbId) {
        logger.warn('No TVDB ID found for era phase request', {
          label: 'Era Phases',
          requestId: request.id,
        });
        return;
      }
      try {
        const series = await sonarr.getSeriesByTvdbId(media.tvdbId);
        seriesId = series.id ?? null;
      } catch (e) {
        logger.warn('Failed to look up Sonarr series for era phase request', {
          label: 'Era Phases',
          requestId: request.id,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
        return;
      }
    }

    if (!seriesId) {
      logger.warn('Could not resolve Sonarr series for era phase request', {
        label: 'Era Phases',
        requestId: request.id,
      });
      return;
    }

    try {
      let ready = false;
      let reason = '';

      if (Date.now() - Date.parse(current.startedAt) > 24 * 60 * 60 * 1000) {
        ready = true;
        reason = 'timeout';
      }

      if (!ready && current.seasons.length > 0) {
        const progress = await sonarr.getSeasonProgress(seriesId);
        const progressBySeason = new Map(
          progress.map((season) => [season.seasonNumber, season])
        );
        const seasonsComplete = current.seasons.every((seasonNumber) => {
          const season = progressBySeason.get(seasonNumber);
          return !!season && season.episodeFileCount >= season.episodeCount;
        });
        if (seasonsComplete) {
          ready = true;
          reason = 'seasons complete';
        }
      }

      if (!ready) {
        const commandsFinished = await this.allCommandsFinished(
          sonarr,
          current.commandIds
        );
        if (commandsFinished) {
          const queue = await sonarr.getQueueForSeries(seriesId);
          if (queue.length === 0) {
            ready = true;
            reason = 'searches finished and queue empty';
          }
        }
      }

      if (!ready) {
        logger.debug('Era phase not ready yet', {
          label: 'Era Phases',
          requestId: request.id,
          seriesId,
          currentSeasons: current.seasons,
        });
        return;
      }

      const next = plan.pending[0];
      const profileId = next.profileId ?? sonarrSettings.activeProfileId;

      const { commandIds } = await sonarr.applyEraPhase({
        seriesId,
        profileId,
        monitorSeasons: next.seasons,
        unmonitorSeasons: current.seasons,
        searchNow: !sonarrSettings.preventSearch,
      });

      const newPlan = {
        pending: plan.pending.slice(1),
        current: {
          profileId,
          seasons: next.seasons,
          commandIds,
          startedAt: new Date().toISOString(),
        },
      };

      await requestRepository.update(request.id, {
        eraPlan: serializeEraPlan(newPlan),
        profileId,
      });

      logger.info('Era phase applied', {
        label: 'Era Phases',
        requestId: request.id,
        seriesId,
        reason,
        profileId,
        monitoredSeasons: next.seasons,
        unmonitoredSeasons: current.seasons,
        remainingPhases: newPlan.pending.length,
      });
    } finally {
      sonarr.clearCache({ tvdbId: media.tvdbId, externalId: seriesId });
    }
  }

  private async allCommandsFinished(
    sonarr: SonarrAPI,
    commandIds: number[]
  ): Promise<boolean> {
    for (const commandId of commandIds) {
      const command = await sonarr.getCommand(commandId);
      if (command && ['queued', 'started'].includes(command.status)) {
        return false;
      }
    }
    return true;
  }
}

export const eraPhaseRunner = new EraPhaseRunner();
export default eraPhaseRunner;
