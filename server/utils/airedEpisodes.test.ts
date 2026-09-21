import { airedEpisodeCount } from '@server/utils/airedEpisodes';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const NOW = new Date('2026-09-21T00:00:00Z');

describe('airedEpisodeCount', () => {
  it('returns the full episode count for specials regardless of air date', () => {
    const show = {
      last_episode_to_air: { season_number: 1, episode_number: 3 },
    };
    const season = { season_number: 0, episode_count: 5, air_date: null };

    assert.strictEqual(airedEpisodeCount(show, season, NOW), 5);
  });

  it('returns 0 when the season has no air date', () => {
    const show = {};
    const season = { season_number: 1, episode_count: 10, air_date: null };

    assert.strictEqual(airedEpisodeCount(show, season, NOW), 0);
  });

  it('returns 0 when the air date is unparseable', () => {
    const show = {};
    const season = { season_number: 1, episode_count: 10, air_date: 'soon' };

    assert.strictEqual(airedEpisodeCount(show, season, NOW), 0);
  });

  it('returns 0 when the season has not started airing yet', () => {
    const show = {
      last_episode_to_air: { season_number: 27, episode_number: 24 },
    };
    const season = {
      season_number: 28,
      episode_count: 10,
      air_date: '2026-10-01',
    };

    assert.strictEqual(airedEpisodeCount(show, season, NOW), 0);
  });

  it('returns the full episode count for a season before last_episode_to_air', () => {
    const show = {
      last_episode_to_air: { season_number: 27, episode_number: 24 },
    };
    const season = {
      season_number: 26,
      episode_count: 22,
      air_date: '2025-09-01',
    };

    assert.strictEqual(airedEpisodeCount(show, season, NOW), 22);
  });

  it('clamps to last_episode_to_air for the currently airing season', () => {
    const show = {
      last_episode_to_air: { season_number: 27, episode_number: 12 },
    };
    const season = {
      season_number: 27,
      episode_count: 24,
      air_date: '2025-09-01',
    };

    assert.strictEqual(airedEpisodeCount(show, season, NOW), 12);
  });

  it('clamps to the episode count when last_episode_to_air exceeds it', () => {
    const show = {
      last_episode_to_air: { season_number: 27, episode_number: 30 },
    };
    const season = {
      season_number: 27,
      episode_count: 24,
      air_date: '2025-09-01',
    };

    assert.strictEqual(airedEpisodeCount(show, season, NOW), 24);
  });

  it('is fully complete for Law & Order season 27 with 24 episodes aired', () => {
    const show = {
      last_episode_to_air: { season_number: 27, episode_number: 24 },
    };
    const season = {
      season_number: 27,
      episode_count: 24,
      air_date: '2025-09-25',
    };

    assert.strictEqual(airedEpisodeCount(show, season, NOW), 24);
  });

  it('falls back to last_episode_to_air when episode_count is unknown for the current season', () => {
    const show = {
      last_episode_to_air: { season_number: 27, episode_number: 12 },
    };
    const season = {
      season_number: 27,
      episode_count: 0,
      air_date: '2025-09-01',
    };

    assert.strictEqual(airedEpisodeCount(show, season, NOW), 12);
  });

  it('is conservative for a season after last_episode_to_air whose air date has passed', () => {
    const show = {
      last_episode_to_air: { season_number: 26, episode_number: 22 },
    };
    const season = {
      season_number: 27,
      episode_count: 24,
      air_date: '2025-09-01',
    };

    assert.strictEqual(airedEpisodeCount(show, season, NOW), 24);
  });

  it('returns the full episode count when there is no last_episode_to_air but the season has aired', () => {
    const show = {};
    const season = {
      season_number: 1,
      episode_count: 10,
      air_date: '2020-01-01',
    };

    assert.strictEqual(airedEpisodeCount(show, season, NOW), 10);
  });
});
