import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  areSeasonsUpgraded,
  fileResolution,
  isMovieUpgraded,
} from './upgradeCheck';

const file = (resolution: number, seasonNumber = 1) => ({
  seasonNumber,
  quality: { quality: { resolution } },
});

describe('fileResolution', () => {
  it('prefers the quality Radarr or Sonarr recorded', () => {
    assert.equal(fileResolution(file(720)), 720);
  });

  it('falls back to the file height', () => {
    assert.equal(
      fileResolution({
        quality: { quality: { resolution: 0 } },
        mediaInfo: { resolution: '1280x720' },
      }),
      720
    );
  });

  it('counts wide films as 1080p', () => {
    assert.equal(
      fileResolution({ mediaInfo: { resolution: '1920x800' } }),
      1080
    );
  });

  it('is 0 when nothing is known', () => {
    assert.equal(fileResolution(undefined), 0);
    assert.equal(fileResolution({}), 0);
  });
});

describe('isMovieUpgraded', () => {
  it('waits for a 1080p file', () => {
    assert.equal(isMovieUpgraded(file(720)), false);
    assert.equal(isMovieUpgraded(undefined), false);
    assert.equal(isMovieUpgraded(file(1080)), true);
    assert.equal(isMovieUpgraded(file(2160)), true);
  });
});

describe('areSeasonsUpgraded', () => {
  it('waits for every episode of every requested season', () => {
    const files = [file(1080, 1), file(1080, 1), file(1080, 2), file(720, 2)];
    assert.equal(areSeasonsUpgraded(files, [1]), true);
    assert.equal(areSeasonsUpgraded(files, [1, 2]), false);
  });

  it('ignores seasons nobody asked about', () => {
    assert.equal(areSeasonsUpgraded([file(1080, 2), file(720, 1)], [2]), true);
  });

  it('does not count a season with no files', () => {
    assert.equal(areSeasonsUpgraded([file(1080, 1)], [1, 2]), false);
    assert.equal(areSeasonsUpgraded([], []), false);
  });
});
