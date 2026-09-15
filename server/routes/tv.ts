import { getMetadataProvider } from '@server/api/metadata';
import RottenTomatoes from '@server/api/rating/rottentomatoes';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import type { TmdbKeyword } from '@server/api/themoviedb/interfaces';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { Watchlist } from '@server/entity/Watchlist';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { mapTvResult } from '@server/models/Search';
import { mapSeasonWithEpisodes, mapTvDetails } from '@server/models/Tv';
import { Router } from 'express';

const tvRoutes = Router();

tvRoutes.get('/:id', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const tmdbTv = await tmdb.getTvShow({
      tvId: Number(req.params.id),
    });
    const metadataProvider = tmdbTv.keywords.results.some(
      (keyword: TmdbKeyword) => keyword.id === ANIME_KEYWORD_ID
    )
      ? await getMetadataProvider('anime')
      : await getMetadataProvider('tv');
    const tv = await metadataProvider.getTvShow({
      tvId: Number(req.params.id),
      language: (req.query.language as string) ?? req.locale,
    });
    const media = await Media.getMedia(tv.id, MediaType.TV);

    const onUserWatchlist = await getRepository(Watchlist).exist({
      where: {
        tmdbId: Number(req.params.id),
        mediaType: MediaType.TV,
        requestedBy: {
          id: req.user?.id,
        },
      },
    });

    const data = mapTvDetails(tv, media, onUserWatchlist);

    // When upgrade requests are enabled, report Sonarr's current quality profile
    // and the lowest resolution held per season so the UI can offer season upgrades.
    if (
      media &&
      (media.status === MediaStatus.AVAILABLE ||
        media.status === MediaStatus.PARTIALLY_AVAILABLE)
    ) {
      const sonarrSettings = getSettings().sonarr.find(
        (s) => !s.is4k && s.isDefault && s.upgradeProfileId
      );
      const tvdbId = data.externalIds?.tvdbId ?? media.tvdbId;
      if (sonarrSettings && tvdbId) {
        try {
          const sonarr = new SonarrAPI({
            apiKey: sonarrSettings.apiKey,
            url: SonarrAPI.buildUrl(sonarrSettings, '/api/v3'),
          });
          const [series] = await sonarr.getLibrarySeriesByTvdbId(tvdbId);
          if (series?.id) {
            const [profiles, files] = await Promise.all([
              sonarr.getProfiles(),
              sonarr.getEpisodeFiles(series.id),
            ]);
            data.currentQualityProfile = profiles.find(
              (p) => p.id === series.qualityProfileId
            )?.name;
            const lowest = new Map<number, number>();
            for (const file of files) {
              let resolution = file.quality?.quality?.resolution;
              if (!resolution && file.mediaInfo?.resolution) {
                const height = Number(file.mediaInfo.resolution.split('x')[1]);
                if (height) {
                  resolution = height;
                }
              }
              if (!resolution) {
                continue;
              }
              const current = lowest.get(file.seasonNumber);
              if (current === undefined || resolution < current) {
                lowest.set(file.seasonNumber, resolution);
              }
            }
            data.seasonResolutions = [...lowest.entries()]
              .map(([seasonNumber, resolution]) => ({
                seasonNumber,
                resolution,
              }))
              .sort((a, b) => a.seasonNumber - b.seasonNumber);
          }
        } catch (e) {
          logger.debug('Could not read current season quality from Sonarr', {
            label: 'API',
            errorMessage: e.message,
            tvId: req.params.id,
          });
        }
      }
    }

    // TMDB issue where it doesnt fallback to English when no overview is available in requested locale.
    if (!data.overview) {
      const tvEnglish = await metadataProvider.getTvShow({
        tvId: Number(req.params.id),
      });
      data.overview = tvEnglish.overview;
    }

    return res.status(200).json(data);
  } catch (e) {
    logger.debug('Something went wrong retrieving series', {
      label: 'API',
      errorMessage: e.message,
      tvId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve series.',
    });
  }
});

tvRoutes.get('/:id/season/:seasonNumber', async (req, res, next) => {
  try {
    const tmdb = new TheMovieDb();
    const tmdbTv = await tmdb.getTvShow({
      tvId: Number(req.params.id),
    });
    const metadataProvider = tmdbTv.keywords.results.some(
      (keyword: TmdbKeyword) => keyword.id === ANIME_KEYWORD_ID
    )
      ? await getMetadataProvider('anime')
      : await getMetadataProvider('tv');

    const season = await metadataProvider.getTvSeason({
      tvId: Number(req.params.id),
      seasonNumber: Number(req.params.seasonNumber),
      language: (req.query.language as string) ?? req.locale,
    });

    return res.status(200).json(mapSeasonWithEpisodes(season));
  } catch (e) {
    logger.debug('Something went wrong retrieving season', {
      label: 'API',
      errorMessage: e.message,
      tvId: req.params.id,
      seasonNumber: req.params.seasonNumber,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve season.',
    });
  }
});

tvRoutes.get('/:id/recommendations', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const results = await tmdb.getTvRecommendations({
      tvId: Number(req.params.id),
      page: Number(req.query.page),
      language: (req.query.language as string) ?? req.locale,
    });

    const media = await Media.getRelatedMedia(
      req.user,
      results.results.map((result) => ({
        tmdbId: result.id,
        mediaType: MediaType.TV,
      })),
      { includeActiveRequest: true }
    );

    return res.status(200).json({
      page: results.page,
      totalPages: results.total_pages,
      totalResults: results.total_results,
      results: results.results.map((result) =>
        mapTvResult(
          result,
          media.find(
            (req) => req.tmdbId === result.id && req.mediaType === MediaType.TV
          )
        )
      ),
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving series recommendations', {
      label: 'API',
      errorMessage: e.message,
      tvId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve series recommendations.',
    });
  }
});

tvRoutes.get('/:id/similar', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const results = await tmdb.getTvSimilar({
      tvId: Number(req.params.id),
      page: Number(req.query.page),
      language: (req.query.language as string) ?? req.locale,
    });

    const media = await Media.getRelatedMedia(
      req.user,
      results.results.map((result) => ({
        tmdbId: result.id,
        mediaType: MediaType.TV,
      })),
      { includeActiveRequest: true }
    );

    return res.status(200).json({
      page: results.page,
      totalPages: results.total_pages,
      totalResults: results.total_results,
      results: results.results.map((result) =>
        mapTvResult(
          result,
          media.find(
            (req) => req.tmdbId === result.id && req.mediaType === MediaType.TV
          )
        )
      ),
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving similar series', {
      label: 'API',
      errorMessage: e.message,
      tvId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve similar series.',
    });
  }
});

tvRoutes.get('/:id/ratings', async (req, res, next) => {
  const tmdb = new TheMovieDb();
  const rtapi = new RottenTomatoes();

  try {
    const tv = await tmdb.getTvShow({
      tvId: Number(req.params.id),
    });

    const rtratings = await rtapi.getTVRatings(
      tv.name,
      tv.first_air_date ? Number(tv.first_air_date.slice(0, 4)) : undefined
    );

    if (!rtratings) {
      return next({
        status: 404,
        message: 'Rotten Tomatoes ratings not found.',
      });
    }

    return res.status(200).json(rtratings);
  } catch (e) {
    logger.debug('Something went wrong retrieving series ratings', {
      label: 'API',
      errorMessage: e.message,
      tvId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve series ratings.',
    });
  }
});

export default tvRoutes;
