/**
 * Media whose "now available" notifications are suppressed for a short time,
 * for an admin's "Mark as Available (no notification)". Marking a title
 * available completes its requests in subscribers that run after the save,
 * so the suppression is a time window per media ID rather than a flag passed
 * through the save.
 */
const SILENCE_MS = 2 * 60 * 1000;

const silencedUntil = new Map<number, number>();

export const silenceAvailableNotifications = (
  mediaId: number,
  now = Date.now()
): void => {
  silencedUntil.set(mediaId, now + SILENCE_MS);
};

export const isAvailableNotificationSilenced = (
  mediaId: number,
  now = Date.now()
): boolean => {
  const until = silencedUntil.get(mediaId);

  if (until === undefined) {
    return false;
  }

  if (until <= now) {
    silencedUntil.delete(mediaId);
    return false;
  }

  return true;
};
