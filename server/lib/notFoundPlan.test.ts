import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import type {
  NotFoundPlan,
  PlanInput,
  PlanRequest,
} from '@server/lib/notFoundPlan';
import { planNotFoundClose } from '@server/lib/notFoundPlan';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const NOT_IN_ARR = { inArr: false, hasFiles: false };
const IN_ARR_NO_FILES = { inArr: true, hasFiles: false };
const IN_ARR_WITH_FILES = { inArr: true, hasFiles: true };

function makeRequest(
  id: number,
  seasons: number[] = [],
  overrides: Partial<PlanRequest> = {}
): PlanRequest {
  return {
    id,
    status: MediaRequestStatus.APPROVED,
    is4k: false,
    isUpgrade: false,
    seasons: seasons.map((seasonNumber) => ({
      seasonNumber,
      status: MediaRequestStatus.APPROVED,
    })),
    ...overrides,
  };
}

function season(
  seasonNumber: number,
  status: MediaStatus,
  status4k = MediaStatus.UNKNOWN
) {
  return { seasonNumber, status, status4k };
}

function plan(
  input: Partial<PlanInput> & Pick<PlanInput, 'arr' | 'request'>,
  media: Partial<PlanInput['media']> = {}
): NotFoundPlan {
  const result = planNotFoundClose({
    otherRequests: [],
    ...input,
    media: {
      mediaType: input.request.seasons.length ? MediaType.TV : MediaType.MOVIE,
      status: MediaStatus.PROCESSING,
      status4k: MediaStatus.UNKNOWN,
      seasons: [],
      ...media,
    },
  });

  assert.ok(!('refused' in result));
  return result;
}

describe('planNotFoundClose: movies', () => {
  it('removes a movie with no file and blocklists it', () => {
    const result = plan({ request: makeRequest(1), arr: IN_ARR_NO_FILES });

    assert.strictEqual(result.arrAction, 'remove');
    assert.strictEqual(result.block, 'blocklist');
    assert.deepStrictEqual(result.closeRequestIds, [1]);
    assert.strictEqual(result.clearServiceData, true);
  });

  it('refuses a movie the arr has a file for', () => {
    assert.deepStrictEqual(
      planNotFoundClose({
        request: makeRequest(1),
        otherRequests: [],
        media: {
          mediaType: MediaType.MOVIE,
          status: MediaStatus.PROCESSING,
          status4k: MediaStatus.UNKNOWN,
          seasons: [],
        },
        arr: IN_ARR_WITH_FILES,
      }),
      { refused: 'file-in-arr' }
    );
  });

  it('refuses a movie Seerr already shows as available', () => {
    assert.deepStrictEqual(
      planNotFoundClose({
        request: makeRequest(1),
        otherRequests: [],
        media: {
          mediaType: MediaType.MOVIE,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.UNKNOWN,
          seasons: [],
        },
        arr: NOT_IN_ARR,
      }),
      { refused: 'already-available' }
    );
  });

  it('continues when the movie is not in the arr', () => {
    const result = plan({ request: makeRequest(1), arr: NOT_IN_ARR });

    assert.strictEqual(result.arrAction, 'none');
    assert.strictEqual(result.block, 'blocklist');
  });

  it('blocks only this quality when the other quality is available', () => {
    const result = plan(
      {
        request: makeRequest(1, [], { is4k: true }),
        arr: IN_ARR_NO_FILES,
      },
      { status: MediaStatus.AVAILABLE, status4k: MediaStatus.PROCESSING }
    );

    assert.strictEqual(result.block, 'quality');
    assert.strictEqual(result.arrAction, 'remove');
  });

  it('blocks only this quality while the other quality has an open request', () => {
    const result = plan({
      request: makeRequest(1),
      otherRequests: [makeRequest(2, [], { is4k: true })],
      arr: NOT_IN_ARR,
    });

    assert.strictEqual(result.block, 'quality');
    assert.deepStrictEqual(result.closeRequestIds, [1]);
  });

  it('closes other requesters at the same quality', () => {
    const result = plan({
      request: makeRequest(1),
      otherRequests: [
        makeRequest(2, [], { status: MediaRequestStatus.PENDING }),
        makeRequest(3, [], { status: MediaRequestStatus.FAILED }),
        makeRequest(4, [], { status: MediaRequestStatus.DECLINED }),
        makeRequest(5, [], { status: MediaRequestStatus.COMPLETED }),
        makeRequest(6, [], { isUpgrade: true }),
      ],
      arr: NOT_IN_ARR,
    });

    assert.deepStrictEqual(result.closeRequestIds, [1, 2, 3]);
  });
});

describe('planNotFoundClose: series', () => {
  it('removes a series with no files and blocklists it', () => {
    const result = plan({ request: makeRequest(1, [1]), arr: IN_ARR_NO_FILES });

    assert.strictEqual(result.arrAction, 'remove');
    assert.strictEqual(result.block, 'blocklist');
    assert.deepStrictEqual(result.closedSeasons, [1]);
  });

  it('only unmonitors a series with files, even if Seerr shows nothing', () => {
    const result = plan({
      request: makeRequest(1, [2]),
      arr: IN_ARR_WITH_FILES,
    });

    assert.strictEqual(result.arrAction, 'unmonitor');
    assert.strictEqual(result.block, 'seasons');
    assert.strictEqual(result.clearServiceData, false);
    assert.strictEqual(result.resetMediaStatus, true);
  });

  it('continues for a show that was never added', () => {
    const result = plan({ request: makeRequest(1, [1]), arr: NOT_IN_ARR });

    assert.strictEqual(result.arrAction, 'none');
    assert.strictEqual(result.block, 'blocklist');
  });

  it('blocks only the unavailable seasons of a partly available show', () => {
    const result = plan(
      { request: makeRequest(1, [1, 2, 3]), arr: IN_ARR_WITH_FILES },
      {
        status: MediaStatus.PARTIALLY_AVAILABLE,
        seasons: [
          season(1, MediaStatus.AVAILABLE),
          season(2, MediaStatus.PARTIALLY_AVAILABLE),
        ],
      }
    );

    assert.deepStrictEqual(result.closedSeasons, [2, 3]);
    assert.strictEqual(result.block, 'seasons');
    assert.strictEqual(result.arrAction, 'unmonitor');
    assert.strictEqual(result.resetMediaStatus, false);
  });

  it('judges availability at the request quality', () => {
    const result = plan(
      {
        request: makeRequest(1, [1, 2], { is4k: true }),
        arr: NOT_IN_ARR,
      },
      {
        status: MediaStatus.AVAILABLE,
        seasons: [
          season(1, MediaStatus.AVAILABLE, MediaStatus.AVAILABLE),
          season(2, MediaStatus.AVAILABLE),
        ],
      }
    );

    assert.deepStrictEqual(result.closedSeasons, [2]);
    assert.strictEqual(result.block, 'seasons');
  });

  it('refuses when every requested season is available', () => {
    assert.deepStrictEqual(
      planNotFoundClose({
        request: makeRequest(1, [1]),
        otherRequests: [],
        media: {
          mediaType: MediaType.TV,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.UNKNOWN,
          seasons: [season(1, MediaStatus.AVAILABLE)],
        },
        arr: IN_ARR_WITH_FILES,
      }),
      { refused: 'already-available' }
    );
  });

  it('closes a request whose outstanding seasons are all covered', () => {
    const result = plan(
      {
        request: makeRequest(1, [2, 3]),
        otherRequests: [makeRequest(2, [1, 2])],
        arr: NOT_IN_ARR,
      },
      {
        status: MediaStatus.PARTIALLY_AVAILABLE,
        seasons: [season(1, MediaStatus.AVAILABLE)],
      }
    );

    assert.deepStrictEqual(result.closeRequestIds, [1, 2]);
    assert.deepStrictEqual(result.partialRequests, []);
  });

  it('leaves a request open when it has other outstanding seasons', () => {
    const result = plan({
      request: makeRequest(1, [2]),
      otherRequests: [makeRequest(2, [2, 3])],
      arr: IN_ARR_NO_FILES,
    });

    assert.deepStrictEqual(result.closeRequestIds, [1]);
    assert.deepStrictEqual(result.partialRequests, [{ id: 2, seasons: [2] }]);
  });

  it('keeps the series and the title requestable for a request left open', () => {
    const result = plan({
      request: makeRequest(1, [2]),
      otherRequests: [makeRequest(2, [3])],
      arr: IN_ARR_NO_FILES,
    });

    assert.strictEqual(result.arrAction, 'unmonitor');
    assert.strictEqual(result.block, 'seasons');
    assert.strictEqual(result.resetMediaStatus, false);
    assert.deepStrictEqual(result.partialRequests, []);
  });

  it('leaves the other quality out of the closed requests', () => {
    const result = plan({
      request: makeRequest(1, [1]),
      otherRequests: [makeRequest(2, [1], { is4k: true })],
      arr: IN_ARR_NO_FILES,
    });

    assert.deepStrictEqual(result.closeRequestIds, [1]);
    assert.strictEqual(result.arrAction, 'remove');
    assert.strictEqual(result.block, 'seasons');
  });

  it('ignores seasons already closed on another request', () => {
    const other = makeRequest(2, [2, 3]);
    other.seasons[1].status = MediaRequestStatus.CLOSED;

    const result = plan({
      request: makeRequest(1, [2]),
      otherRequests: [other],
      arr: NOT_IN_ARR,
    });

    assert.deepStrictEqual(result.closeRequestIds, [1, 2]);
  });
});
