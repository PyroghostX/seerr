import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isAvailableNotificationSilenced,
  silenceAvailableNotifications,
} from '@server/lib/notificationSilence';

describe('notificationSilence', () => {
  it('silences a media item for two minutes', () => {
    silenceAvailableNotifications(101, 1_000);
    assert.equal(isAvailableNotificationSilenced(101, 1_000 + 60_000), true);
    assert.equal(isAvailableNotificationSilenced(101, 1_000 + 120_001), false);
  });

  it('leaves other media alone', () => {
    silenceAvailableNotifications(102, 1_000);
    assert.equal(isAvailableNotificationSilenced(103, 2_000), false);
  });
});
