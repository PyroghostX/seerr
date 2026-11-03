import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { getRepository } from '@server/datasource';
import ScannedFile from '@server/entity/ScannedFile';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * Finds video files with stretches of nothing but zeros where the picture
 * should be, which is what a download looks like when it was imported before
 * all of it had been written. They play until they reach the gap, then break
 * up or stop.
 *
 * Reading the whole library every night would be far too slow, but a gap also
 * takes up no disk, so a file's size against its allocated blocks picks out the
 * few worth reading. Files with a few percent of gaps stay under that bar.
 *
 * The library folders must be mounted in this container at the paths Sonarr and
 * Radarr use (read-only is enough). Without them the job does nothing.
 */

const VIDEO_EXTENSIONS = new Set(['.avi', '.m4v', '.mkv', '.mp4', '.ts']);
const BLOCK_SIZE = 512;
const ZERO_RUN_BYTES = 64 * 1024;
const READ_BUFFER_BYTES = 64 * ZERO_RUN_BYTES;

/** Smaller files are samples and extras, not episodes. */
export const MIN_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_ALLOCATED_RATIO = 0.92;
export const MIN_ZERO_BYTES = 1024 * 1024;

export function isReadWorthy(size: number, blocks: number): boolean {
  return (
    size >= MIN_FILE_BYTES && (blocks * BLOCK_SIZE) / size < MAX_ALLOCATED_RATIO
  );
}

/** Bytes of `buffer` in whole ZERO_RUN_BYTES blocks of zeros. */
export function countZeroBytes(buffer: Buffer): number {
  const zeros = Buffer.alloc(ZERO_RUN_BYTES);
  let count = 0;

  for (let at = 0; at < buffer.length; at += ZERO_RUN_BYTES) {
    const block = buffer.subarray(at, at + ZERO_RUN_BYTES);

    if (block.compare(zeros, 0, block.length) === 0) {
      count += block.length;
    }
  }

  return count;
}

export function isDamaged(zeroBytes: number): boolean {
  return zeroBytes >= MIN_ZERO_BYTES;
}

/** "Show - S02E05" for an episode, the folder name for a movie. */
export function damagedFileLabel(filePath: string): string {
  const name = path.basename(filePath);
  const episode = name.match(/^(.+? - S\d+E\d+(?:-?E\d+)*)/i);

  return episode ? episode[1] : path.basename(path.dirname(filePath));
}

export function formatDamagedLine(
  file: Pick<ScannedFile, 'path' | 'zeroPercent'>
): string {
  return `• ${damagedFileLabel(file.path)} (${file.zeroPercent}% blank)`;
}

async function libraryRoots(): Promise<string[]> {
  const settings = getSettings();
  const roots = new Set<string>();
  const servers = [
    ...settings.sonarr
      .filter((s) => !s.is4k)
      .map(
        (s) =>
          new SonarrAPI({
            apiKey: s.apiKey,
            url: SonarrAPI.buildUrl(s, '/api/v3'),
          })
      ),
    ...settings.radarr
      .filter((r) => !r.is4k)
      .map(
        (r) =>
          new RadarrAPI({
            apiKey: r.apiKey,
            url: RadarrAPI.buildUrl(r, '/api/v3'),
          })
      ),
  ];

  for (const server of servers) {
    for (const folder of await server.getRootFolders()) {
      roots.add(folder.path.replace(/\/+$/, ''));
    }
  }

  return [...roots];
}

/** Every video file under `folder`, with what a stat says about it. */
async function walk(
  folder: string,
  found: Map<string, { size: number; blocks: number; mtimeMs: number }>
): Promise<void> {
  const entries = await fs.readdir(folder, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(folder, entry.name);

    if (entry.isDirectory()) {
      await walk(entryPath, found);
    } else if (
      entry.isFile() &&
      VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    ) {
      const { size, blocks, mtimeMs } = await fs.stat(entryPath);

      found.set(entryPath, { size, blocks, mtimeMs });
    }
  }
}

async function readZeroBytes(filePath: string): Promise<number> {
  const file = await fs.open(filePath, 'r');
  const buffer = Buffer.alloc(READ_BUFFER_BYTES);
  let zeroBytes = 0;

  try {
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, READ_BUFFER_BYTES);

      if (!bytesRead) {
        return zeroBytes;
      }

      zeroBytes += countZeroBytes(buffer.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
}

let running = false;

export function isDamagedFilesCheckRunning(): boolean {
  return running;
}

export async function runDamagedFilesCheck(): Promise<void> {
  if (running) {
    return;
  }

  running = true;

  try {
    const repository = getRepository(ScannedFile);
    const stored = new Map(
      (await repository.find()).map((file) => [file.path, file])
    );
    const files = new Map<
      string,
      { size: number; blocks: number; mtimeMs: number }
    >();
    const walked: string[] = [];

    for (const root of await libraryRoots()) {
      try {
        const before = files.size;

        await walk(root, files);

        // An empty folder is a share that isn't mounted, not a deleted library
        if (files.size > before) {
          walked.push(root);
        }
      } catch (e) {
        logger.warn('Failed to walk a library folder', {
          label: 'Damaged Files',
          root,
          errorMessage: e.message,
        });
      }
    }

    if (!walked.length) {
      logger.info('Damaged Files skipped: no library folders are mounted', {
        label: 'Damaged Files',
      });
      return;
    }

    let read = 0;

    for (const [filePath, { size, blocks, mtimeMs }] of files) {
      if (!isReadWorthy(size, blocks)) {
        continue;
      }

      const fingerprint = `${size}:${Math.round(mtimeMs)}`;
      const known = stored.get(filePath);

      if (known?.fingerprint === fingerprint) {
        continue;
      }

      try {
        const zeroBytes = await readZeroBytes(filePath);

        read++;
        await repository.save(
          Object.assign(known ?? new ScannedFile({ path: filePath }), {
            fingerprint,
            damaged: isDamaged(zeroBytes),
            zeroPercent: Math.max(1, Math.round((zeroBytes / size) * 100)),
          })
        );
      } catch (e) {
        logger.warn('Failed to read a file', {
          label: 'Damaged Files',
          filePath,
          errorMessage: e.message,
        });
      }
    }

    // Gone, or rewritten so that it no longer has anything to read
    const stale = [...stored.values()].filter((file) => {
      const current = files.get(file.path);

      return (
        walked.some((root) => file.path.startsWith(`${root}/`)) &&
        (!current || !isReadWorthy(current.size, current.blocks))
      );
    });

    await repository.remove(stale);

    logger.info('Damaged Files complete', {
      label: 'Damaged Files',
      files: files.size,
      read,
      damaged: await repository.count({ where: { damaged: true } }),
    });
  } finally {
    running = false;
  }
}
