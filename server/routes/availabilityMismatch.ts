import { getRepository } from '@server/datasource';
import AvailabilityMismatch from '@server/entity/AvailabilityMismatch';
import Media from '@server/entity/Media';
import type {
  AvailabilityMismatchFineResponse,
  AvailabilityMismatchFixedResponse,
  AvailabilityMismatchItem,
  AvailabilityMismatchResultsResponse,
} from '@server/interfaces/api/availabilityMismatchInterfaces';
import type { MismatchStatus } from '@server/lib/availabilityMismatch';
import {
  MISMATCH_STATUSES,
  markSeasonAvailableIfComplete,
  recheckShow,
} from '@server/lib/availabilityMismatch';
import logger from '@server/logger';
import { Router } from 'express';
import { In } from 'typeorm';

const availabilityMismatchRoutes = Router();

const toItem = (row: AvailabilityMismatch): AvailabilityMismatchItem => ({
  id: row.id,
  mediaId: row.mediaId,
  tmdbId: row.media?.tmdbId ?? 0,
  title: row.title ?? null,
  seasonNumber: row.seasonNumber,
  plexEpisodes: row.plexEpisodes,
  sonarrEpisodes: row.sonarrEpisodes,
  status: row.status,
  firstSeenAt: row.firstSeenAt,
  updatedAt: row.updatedAt,
  resolvedAt: row.resolvedAt ?? null,
  resolvedBy: row.resolvedBy
    ? { id: row.resolvedBy.id, displayName: row.resolvedBy.displayName }
    : null,
});

const findMismatch = (id: number) =>
  getRepository(AvailabilityMismatch).findOne({
    where: { id },
    relations: { media: true, resolvedBy: true },
  });

availabilityMismatchRoutes.get<
  Record<string, string>,
  AvailabilityMismatchResultsResponse
>('/', async (req, res, next) => {
  const filter = req.query.status ?? 'open';
  const statuses: MismatchStatus[] =
    filter === 'all'
      ? MISMATCH_STATUSES
      : MISMATCH_STATUSES.filter((status) => status === filter);

  if (!statuses.length) {
    return next({ status: 400, message: 'Unknown status filter.' });
  }

  try {
    const rows = await getRepository(AvailabilityMismatch).find({
      where: { status: In(statuses) },
      relations: { media: true, resolvedBy: true },
      order: { title: 'ASC', seasonNumber: 'ASC' },
    });

    return res.status(200).json({ results: rows.map(toItem) });
  } catch (e) {
    logger.error('Failed to list availability mismatches', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({ status: 500, message: 'Unable to load mismatches.' });
  }
});

availabilityMismatchRoutes.post<
  { id: string },
  AvailabilityMismatchFineResponse
>('/:id/fine', async (req, res, next) => {
  const row = await findMismatch(Number(req.params.id));

  if (!row) {
    return next({ status: 404, message: 'Mismatch not found.' });
  }

  row.status = 'fine';
  row.resolvedAt = new Date();
  row.resolvedBy = req.user;
  await getRepository(AvailabilityMismatch).save(row);

  // When Sonarr has every aired episode, the mismatch is Plex's way of
  // counting (multi-episode files): mark the season available, quietly
  let markedAvailable = false;

  try {
    markedAvailable = await markSeasonAvailableIfComplete(
      row.mediaId,
      row.seasonNumber,
      row.sonarrEpisodes
    );
  } catch (e) {
    logger.warn('Failed to mark season available for a Fine mismatch', {
      label: 'API',
      mismatchId: row.id,
      errorMessage: e.message,
    });
  }

  return res.status(200).json({ mismatch: toItem(row), markedAvailable });
});

availabilityMismatchRoutes.post<
  { id: string },
  AvailabilityMismatchFixedResponse
>('/:id/fixed', async (req, res, next) => {
  const row = await findMismatch(Number(req.params.id));

  if (!row) {
    return next({ status: 404, message: 'Mismatch not found.' });
  }

  const media = await getRepository(Media).findOne({
    where: { id: row.mediaId },
  });

  if (!media) {
    return next({ status: 404, message: 'Media not found.' });
  }

  let findings;

  try {
    findings = await recheckShow(media);
  } catch (e) {
    logger.warn('Failed to check a show again for a Fixed mismatch', {
      label: 'API',
      mismatchId: row.id,
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to check Plex and Sonarr right now.',
    });
  }

  const finding = findings.find((f) => f.seasonNumber === row.seasonNumber);
  const repository = getRepository(AvailabilityMismatch);

  if (finding) {
    // The recheck already updated the counts (and reopened it if needed)
    const current = (await findMismatch(row.id)) ?? row;

    return res.status(409).json({
      mismatch: toItem(current),
      message: `Still Plex ${finding.plexEpisodes}, Sonarr ${finding.sonarrEpisodes}`,
    });
  }

  const current = (await findMismatch(row.id)) ?? row;

  current.status = 'fixed';
  current.resolvedAt = new Date();
  current.resolvedBy = req.user;
  await repository.save(current);

  return res.status(200).json({ mismatch: toItem(current) });
});

export default availabilityMismatchRoutes;
