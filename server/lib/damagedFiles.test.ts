import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MIN_FILE_BYTES,
  MIN_ZERO_BYTES,
  countZeroBytes,
  damagedFileLabel,
  formatDamagedLine,
  isDamaged,
  isReadWorthy,
} from './damagedFiles';

const BLOCK = 64 * 1024;

describe('isReadWorthy', () => {
  it('picks a large file that takes up less disk than its size', () => {
    assert.equal(isReadWorthy(MIN_FILE_BYTES, MIN_FILE_BYTES / 1024), true);
  });

  it('skips a fully allocated file', () => {
    assert.equal(isReadWorthy(MIN_FILE_BYTES, MIN_FILE_BYTES / 512), false);
  });

  it('skips small files', () => {
    assert.equal(isReadWorthy(MIN_FILE_BYTES - 1, 0), false);
  });
});

describe('countZeroBytes', () => {
  it('counts whole blocks of zeros', () => {
    assert.equal(countZeroBytes(Buffer.alloc(BLOCK * 3)), BLOCK * 3);
  });

  it('ignores a block with anything in it', () => {
    const buffer = Buffer.alloc(BLOCK * 3);

    buffer[BLOCK + 5] = 1;
    assert.equal(countZeroBytes(buffer), BLOCK * 2);
  });

  it('counts a short last block', () => {
    assert.equal(countZeroBytes(Buffer.alloc(BLOCK + 100)), BLOCK + 100);
  });

  it('is 0 for real data', () => {
    assert.equal(countZeroBytes(Buffer.alloc(BLOCK, 7)), 0);
  });
});

describe('isDamaged', () => {
  it('needs at least a megabyte of zeros', () => {
    assert.equal(isDamaged(MIN_ZERO_BYTES - 1), false);
    assert.equal(isDamaged(MIN_ZERO_BYTES), true);
  });
});

describe('damagedFileLabel', () => {
  it('names an episode by show and number', () => {
    assert.equal(
      damagedFileLabel(
        '/tv/Show/Show - Season 2/Show (2020) - S02E05 - Some Title - WEBDL-1080p h264.mkv'
      ),
      'Show (2020) - S02E05'
    );
  });

  it('keeps a double episode', () => {
    assert.equal(
      damagedFileLabel('/tv/Show/Show - S01E01-E02 - Pilot.mkv'),
      'Show - S01E01-E02'
    );
  });

  it('names a movie by its folder', () => {
    assert.equal(
      damagedFileLabel('/movies/Some Movie (2020)/file.mkv'),
      'Some Movie (2020)'
    );
  });
});

describe('formatDamagedLine', () => {
  it('says how much is blank', () => {
    assert.equal(
      formatDamagedLine({ path: '/tv/S/S - S01E02 - T.mkv', zeroPercent: 29 }),
      '• S - S01E02 (29% blank)'
    );
  });
});
