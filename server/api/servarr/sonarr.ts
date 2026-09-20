import { orderSeasonsForSearch } from '@server/lib/eraPlan';
import logger from '@server/logger';
import type { AxiosResponse } from 'axios';
import ServarrBase from './base';

export interface SonarrSeason {
  seasonNumber: number;
  monitored: boolean;
  statistics?: {
    previousAiring?: string;
    episodeFileCount: number;
    episodeCount: number;
    totalEpisodeCount: number;
    sizeOnDisk: number;
    percentOfEpisodes: number;
  };
}
interface EpisodeResult {
  seriesId: number;
  episodeFileId: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  airDate: string;
  airDateUtc: string;
  overview: string;
  hasFile: boolean;
  monitored: boolean;
  absoluteEpisodeNumber: number;
  unverifiedSceneNumbering: boolean;
  id: number;
}

export interface SonarrSeries {
  title: string;
  sortTitle: string;
  seasonCount: number;
  status: string;
  overview: string;
  network: string;
  airTime: string;
  images: {
    coverType: string;
    url: string;
  }[];
  remotePoster: string;
  seasons: SonarrSeason[];
  year: number;
  path: string;
  profileId: number;
  languageProfileId: number;
  seasonFolder: boolean;
  monitored: boolean;
  monitorNewItems: 'all' | 'none';
  useSceneNumbering: boolean;
  runtime: number;
  tvdbId: number;
  tvRageId: number;
  tvMazeId: number;
  firstAired: string;
  lastInfoSync?: string;
  seriesType: 'standard' | 'daily' | 'anime';
  cleanTitle: string;
  imdbId: string;
  titleSlug: string;
  certification: string;
  genres: string[];
  tags: number[];
  added: string;
  ratings: {
    votes: number;
    value: number;
  };
  qualityProfileId: number;
  id?: number;
  rootFolderPath?: string;
  addOptions?: {
    ignoreEpisodesWithFiles?: boolean;
    ignoreEpisodesWithoutFiles?: boolean;
    searchForMissingEpisodes?: boolean;
  };
  statistics: {
    seasonCount: number;
    episodeFileCount: number;
    episodeCount: number;
    totalEpisodeCount: number;
    sizeOnDisk: number;
    releaseGroups: string[];
    percentOfEpisodes: number;
  };
}

export interface SonarrEpisodeFile {
  id: number;
  seriesId: number;
  seasonNumber: number;
  relativePath?: string;
  size: number;
  quality: {
    quality: {
      id: number;
      name: string;
      source?: string;
      resolution?: number;
    };
  };
  mediaInfo?: {
    resolution?: string;
  };
}

export interface AddSeriesOptions {
  tvdbid: number;
  title: string;
  profileId: number;
  languageProfileId?: number;
  seasons: number[];
  seasonFolder: boolean;
  rootFolderPath: string;
  tags?: number[];
  seriesType: SonarrSeries['seriesType'];
  monitored?: boolean;
  monitorNewItems?: SonarrSeries['monitorNewItems'];
  searchNow?: boolean;
}

export interface AddSeriesResult extends SonarrSeries {
  searchCommandIds?: number[];
}

export interface LanguageProfile {
  id: number;
  name: string;
}

class SonarrAPI extends ServarrBase<{
  seriesId: number;
  episodeId: number;
  episode: EpisodeResult;
}> {
  constructor({ url, apiKey }: { url: string; apiKey: string }) {
    super({ url, apiKey, apiName: 'Sonarr', cacheName: 'sonarr' });
  }

  public async getSeries(): Promise<SonarrSeries[]> {
    try {
      const response = await this.axios.get<SonarrSeries[]>('/series');

      return response.data;
    } catch (e) {
      throw new Error(`[Sonarr] Failed to retrieve series: ${e.message}`, {
        cause: e,
      });
    }
  }

  public async getLibrarySeriesByTvdbId(
    tvdbId: number
  ): Promise<SonarrSeries[]> {
    try {
      const response = await this.axios.get<SonarrSeries[]>('/series', {
        params: { tvdbId },
      });

      return response.data;
    } catch (e) {
      throw new Error(
        `[Sonarr] Failed to retrieve series by TVDB ID: ${e.message}`,
        { cause: e }
      );
    }
  }

  public async getSeriesById(id: number): Promise<SonarrSeries> {
    try {
      const response = await this.axios.get<SonarrSeries>(`/series/${id}`);

      return response.data;
    } catch (e) {
      throw new Error(
        `[Sonarr] Failed to retrieve series by ID: ${e.message}`,
        { cause: e }
      );
    }
  }

  public async getSeriesByTitle(title: string): Promise<SonarrSeries[]> {
    try {
      const response = await this.axios.get<SonarrSeries[]>('/series/lookup', {
        params: {
          term: title,
        },
      });

      if (!response.data[0]) {
        throw new Error('No series found');
      }

      return response.data;
    } catch (e) {
      logger.error('Error retrieving series by series title', {
        label: 'Sonarr API',
        errorMessage: e.message,
        title,
      });
      throw new Error('No series found', { cause: e });
    }
  }

  public async getSeriesByTvdbId(id: number): Promise<SonarrSeries> {
    let response: AxiosResponse<SonarrSeries[]>;
    try {
      response = await this.axios.get<SonarrSeries[]>('/series/lookup', {
        params: {
          term: `tvdb:${id}`,
        },
      });
    } catch (e) {
      logger.error('Error retrieving series by tvdb ID', {
        label: 'Sonarr API',
        errorMessage: e.message,
        tvdbId: id,
      });
      throw e;
    }

    if (!response.data[0]) {
      throw new Error('Series not found');
    }

    return response.data[0];
  }

  public async addSeries(options: AddSeriesOptions): Promise<AddSeriesResult> {
    try {
      const series = await this.getSeriesByTvdbId(options.tvdbid);

      // If the series already exists, we will simply just update it
      if (series.id) {
        series.monitored = options.monitored ?? series.monitored;
        series.tags = options.tags
          ? Array.from(new Set([...series.tags, ...options.tags]))
          : series.tags;
        series.seasons = this.buildSeasonList(options.seasons, series.seasons);

        const newSeriesResponse = await this.axios.put<SonarrSeries>(
          '/series',
          series
        );

        if (newSeriesResponse.data.id) {
          logger.info('Updated existing series in Sonarr.', {
            label: 'Sonarr',
            seriesId: newSeriesResponse.data.id,
            seriesTitle: newSeriesResponse.data.title,
          });
          logger.debug('Sonarr update details', {
            label: 'Sonarr',
            series: newSeriesResponse.data,
          });

          try {
            const episodes = await this.getEpisodes(newSeriesResponse.data.id);
            const episodeIdsToMonitor = episodes
              .filter(
                (ep) =>
                  options.seasons.includes(ep.seasonNumber) && !ep.monitored
              )
              .map((ep) => ep.id);

            if (episodeIdsToMonitor.length > 0) {
              logger.debug(
                'Re-monitoring unmonitored episodes for requested seasons.',
                {
                  label: 'Sonarr',
                  seriesId: newSeriesResponse.data.id,
                  episodeCount: episodeIdsToMonitor.length,
                }
              );
              await this.monitorEpisodes(episodeIdsToMonitor);
            }
          } catch (e) {
            logger.warn('Failed to re-monitor episodes', {
              label: 'Sonarr',
              errorMessage: e.message,
              seriesId: newSeriesResponse.data.id,
            });
          }

          let searchCommandIds: number[] | undefined;
          if (options.searchNow && options.seasons.length > 0) {
            searchCommandIds = await this.searchSeasonsOrdered(
              newSeriesResponse.data.id,
              options.seasons
            );
          }

          return { ...newSeriesResponse.data, searchCommandIds };
        } else {
          logger.error('Failed to update series in Sonarr', {
            label: 'Sonarr',
            options,
          });
          throw new Error('Failed to update series in Sonarr');
        }
      }

      const createdSeriesResponse = await this.axios.post<SonarrSeries>(
        '/series',
        {
          tvdbId: options.tvdbid,
          title: options.title,
          qualityProfileId: options.profileId,
          languageProfileId: options.languageProfileId,
          seasons: this.buildSeasonList(
            options.seasons,
            series.seasons.map((season) => ({
              seasonNumber: season.seasonNumber,
              // We force all seasons to false if its the first request
              monitored: false,
            }))
          ),
          tags: options.tags,
          seasonFolder: options.seasonFolder,
          monitored: options.monitored,
          monitorNewItems: options.monitorNewItems,
          rootFolderPath: options.rootFolderPath,
          seriesType: options.seriesType,
          addOptions: {
            ignoreEpisodesWithFiles: true,
            searchForMissingEpisodes: false,
          },
        } as Partial<SonarrSeries>
      );

      if (createdSeriesResponse.data.id) {
        logger.info('Sonarr accepted request', { label: 'Sonarr' });
        logger.debug('Sonarr add details', {
          label: 'Sonarr',
          series: createdSeriesResponse.data,
        });
      } else {
        logger.error('Failed to add series to Sonarr', {
          label: 'Sonarr',
          options,
        });
        throw new Error('Failed to add series to Sonarr');
      }

      let searchCommandIds: number[] | undefined;
      if (options.searchNow && options.seasons.length > 0) {
        searchCommandIds = await this.searchSeasonsOrdered(
          createdSeriesResponse.data.id,
          options.seasons
        );
      }

      return { ...createdSeriesResponse.data, searchCommandIds };
    } catch (e) {
      logger.error('Something went wrong while adding a series to Sonarr.', {
        label: 'Sonarr API',
        errorMessage: e.message,
        options,
        response: e?.response?.data,
      });
      throw new Error('Failed to add series', { cause: e });
    }
  }

  public async getLanguageProfiles(): Promise<LanguageProfile[]> {
    try {
      const data = await this.getRolling<LanguageProfile[]>(
        '/languageprofile',
        undefined,
        3600
      );

      return data;
    } catch (e) {
      logger.error(
        'Something went wrong while retrieving Sonarr language profiles.',
        {
          label: 'Sonarr API',
          errorMessage: e.message,
        }
      );

      throw new Error('Failed to get language profiles', { cause: e });
    }
  }

  public async getEpisodeFiles(seriesId: number): Promise<SonarrEpisodeFile[]> {
    try {
      const response = await this.axios.get<SonarrEpisodeFile[]>(
        '/episodefile',
        { params: { seriesId } }
      );
      return response.data;
    } catch (e) {
      throw new Error(
        `[Sonarr] Failed to retrieve episode files: ${e.message}`,
        {
          cause: e,
        }
      );
    }
  }

  public async upgradeSeries(options: {
    tvdbid: number;
    profileId: number;
    searchNow: boolean;
    seasons?: number[];
    futureSeasons?: boolean;
  }): Promise<SonarrSeries> {
    const series = await this.getSeriesByTvdbId(options.tvdbid);

    if (!series.id) {
      throw new Error('Series is not in Sonarr, cannot upgrade');
    }
    const seriesId = series.id;

    // The quality profile is series-wide, so seasons that were not chosen are
    // unmonitored to keep Sonarr from upgrading them too. Specials are left alone.
    const chosen = new Set(options.seasons ?? []);
    const seasons = series.seasons.map((season) =>
      season.seasonNumber === 0
        ? season
        : { ...season, monitored: chosen.has(season.seasonNumber) }
    );

    const response = await this.axios.put<SonarrSeries>(`/series/${seriesId}`, {
      ...series,
      seasons,
      qualityProfileId: options.profileId,
      monitored: true,
      ...(options.futureSeasons ? { monitorNewItems: 'all' } : {}),
    });

    logger.info(
      'Changed quality profile of existing series in Sonarr for upgrade.',
      {
        label: 'Sonarr',
        seriesId: response.data.id,
        seriesTitle: response.data.title,
        qualityProfileId: options.profileId,
        monitoredSeasons: [...chosen],
        futureSeasons: !!options.futureSeasons,
      }
    );

    if (options.searchNow) {
      try {
        if (options.seasons && options.seasons.length > 0) {
          await this.searchSeasonsOrdered(seriesId, options.seasons);
        } else {
          const monitoredSeasons = response.data.seasons
            .filter((s) => s.seasonNumber !== 0 && s.monitored)
            .map((s) => s.seasonNumber);

          if (monitoredSeasons.length > 0) {
            await this.searchSeasonsOrdered(seriesId, monitoredSeasons);
          } else {
            await this.runCommand('SeriesSearch', {
              seriesId: response.data.id,
            });
          }
        }
      } catch (e) {
        logger.error(
          'Something went wrong while executing Sonarr series search.',
          {
            label: 'Sonarr API',
            errorMessage: e.message,
            seriesId: response.data.id,
          }
        );
      }
    }

    return response.data;
  }

  /**
   * Search the given seasons of a series in the order requested by
   * `orderSeasonsForSearch` (first and last requested season, then the
   * middle seasons ascending) by posting SeasonSearch commands one at a
   * time. Sonarr runs commands of the same name in submission order, so
   * posting sequentially is enough to control the search order.
   *
   * Freshly added series have their episodes populated asynchronously, so
   * this waits (briefly) for at least one episode of the requested seasons
   * to show up before searching.
   */
  public async searchSeasonsOrdered(
    seriesId: number,
    seasons: number[]
  ): Promise<number[]> {
    if (seasons.length === 0) {
      return [];
    }

    const seasonSet = new Set(seasons);
    const maxAttempts = 20;
    const delayMs = 3000;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const episodes = await this.getEpisodes(seriesId);
      if (episodes.some((ep) => seasonSet.has(ep.seasonNumber))) {
        break;
      }
      if (attempt === maxAttempts - 1) {
        logger.warn(
          'Timed out waiting for Sonarr to populate episodes before searching seasons',
          {
            label: 'Sonarr API',
            seriesId,
            seasons,
          }
        );
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const order = orderSeasonsForSearch(seasons);
    logger.info('Queuing season searches', {
      label: 'Sonarr API',
      seriesId,
      order,
    });

    const commandIds: number[] = [];
    for (const seasonNumber of order) {
      try {
        const command = await this.runCommand('SeasonSearch', {
          seriesId,
          seasonNumber,
        });
        if (command?.id) {
          commandIds.push(command.id);
        }
      } catch (e) {
        logger.error('Failed to queue season search', {
          label: 'Sonarr API',
          errorMessage: e.message,
          seriesId,
          seasonNumber,
        });
      }
    }

    return commandIds;
  }

  public async searchSeries(seriesId: number): Promise<void> {
    logger.info('Executing series search command.', {
      label: 'Sonarr API',
      seriesId,
    });

    try {
      await this.runCommand('MissingEpisodeSearch', { seriesId });
    } catch (e) {
      logger.error(
        'Something went wrong while executing Sonarr missing episode search.',
        {
          label: 'Sonarr API',
          errorMessage: e.message,
          seriesId,
        }
      );
    }
  }

  public async getEpisodes(seriesId: number): Promise<EpisodeResult[]> {
    try {
      const response = await this.axios.get<EpisodeResult[]>('/episode', {
        params: { seriesId },
      });
      return response.data;
    } catch (e) {
      logger.error('Failed to retrieve episodes', {
        label: 'Sonarr API',
        errorMessage: e.message,
        seriesId,
      });
      throw new Error('Failed to get episodes', { cause: e });
    }
  }

  public async monitorEpisodes(episodeIds: number[]): Promise<void> {
    try {
      await this.axios.put('/episode/monitor', {
        episodeIds,
        monitored: true,
      });
    } catch (e) {
      logger.error('Failed to monitor episodes', {
        label: 'Sonarr API',
        errorMessage: e.message,
        episodeIds,
      });
      throw new Error('Failed to monitor episodes', { cause: e });
    }
  }

  public async getSeasonProgress(seriesId: number): Promise<
    {
      seasonNumber: number;
      monitored: boolean;
      episodeFileCount: number;
      episodeCount: number;
    }[]
  > {
    const series = await this.getSeriesById(seriesId);

    return series.seasons.map((season) => ({
      seasonNumber: season.seasonNumber,
      monitored: season.monitored,
      episodeFileCount: season.statistics?.episodeFileCount ?? 0,
      episodeCount: season.statistics?.episodeCount ?? 0,
    }));
  }

  public async getQueueForSeries(seriesId: number): Promise<unknown[]> {
    try {
      const response = await this.axios.get<unknown>('/queue/details', {
        params: {
          seriesId,
          includeSeries: false,
          includeEpisode: false,
        },
      });

      return Array.isArray(response.data) ? response.data : [];
    } catch (e) {
      throw new Error(
        `[Sonarr] Failed to retrieve queue for series: ${e.message}`,
        { cause: e }
      );
    }
  }

  public async applyEraPhase(options: {
    seriesId: number;
    profileId: number;
    monitorSeasons: number[];
    unmonitorSeasons: number[];
    searchNow: boolean;
  }): Promise<{ series: SonarrSeries; commandIds: number[] }> {
    const series = await this.getSeriesById(options.seriesId);

    const seasons = series.seasons.map((season) => {
      if (season.seasonNumber === 0) {
        return season;
      }
      if (options.unmonitorSeasons.includes(season.seasonNumber)) {
        return { ...season, monitored: false };
      }
      if (options.monitorSeasons.includes(season.seasonNumber)) {
        return { ...season, monitored: true };
      }
      return season;
    });

    const response = await this.axios.put<SonarrSeries>(
      `/series/${series.id}`,
      {
        ...series,
        qualityProfileId: options.profileId,
        monitored: true,
        seasons,
      }
    );

    try {
      const episodes = await this.getEpisodes(options.seriesId);
      const episodeIdsToMonitor = episodes
        .filter(
          (ep) =>
            options.monitorSeasons.includes(ep.seasonNumber) && !ep.monitored
        )
        .map((ep) => ep.id);

      if (episodeIdsToMonitor.length > 0) {
        await this.monitorEpisodes(episodeIdsToMonitor);
      }
    } catch (e) {
      logger.warn('Failed to re-monitor episodes for era phase', {
        label: 'Sonarr',
        errorMessage: e.message,
        seriesId: options.seriesId,
      });
    }

    const commandIds = options.searchNow
      ? await this.searchSeasonsOrdered(
          options.seriesId,
          options.monitorSeasons
        )
      : [];

    logger.info('Applied era phase', {
      label: 'Sonarr',
      seriesId: response.data.id,
      seriesTitle: response.data.title,
      qualityProfileId: options.profileId,
      monitoredSeasons: options.monitorSeasons,
      unmonitoredSeasons: options.unmonitorSeasons,
    });

    return { series: response.data, commandIds };
  }

  private buildSeasonList(
    seasons: number[],
    existingSeasons?: SonarrSeason[]
  ): SonarrSeason[] {
    if (existingSeasons) {
      const newSeasons = existingSeasons.map((season) => {
        if (seasons.includes(season.seasonNumber)) {
          season.monitored = true;
        }
        return season;
      });

      return newSeasons;
    }

    const newSeasons = seasons.map(
      (seasonNumber): SonarrSeason => ({
        seasonNumber,
        monitored: true,
      })
    );

    return newSeasons;
  }
  public removeSeries = async (tvdbId: number): Promise<void> => {
    const { id, title } = await this.getSeriesByTvdbId(tvdbId);

    if (!id) {
      logger.info(`[Sonarr] Series not in library, nothing to remove`, {
        tvdbId,
      });
      return;
    }

    try {
      await this.axios.delete(`/series/${id}`, {
        params: {
          deleteFiles: true,
          addImportExclusion: false,
        },
      });
      logger.info(`[Sonarr] Removed series ${title}`);
    } catch (e) {
      if (e?.response?.status === 404) {
        logger.info(`[Sonarr] Series already removed from Sonarr`, {
          tvdbId,
        });
        return;
      }
      throw e;
    }
  };

  public clearCache = ({
    tvdbId,
    externalId,
    title,
  }: {
    tvdbId?: number | null;
    externalId?: number | null;
    title?: string | null;
  }) => {
    if (tvdbId) {
      this.removeCache('/series/lookup', {
        term: `tvdb:${tvdbId}`,
      });
    }
    if (externalId) {
      this.removeCache(`/series/${externalId}`);
    }
    if (title) {
      this.removeCache('/series/lookup', {
        term: title,
      });
    }
  };
}

export default SonarrAPI;
