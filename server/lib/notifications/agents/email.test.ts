import { MediaType } from '@server/constants/media';
import { ALL_NOTIFICATIONS } from '@server/entity/UserSettings';
import { initI18n } from '@server/i18n';
import { hasNotificationType, Notification } from '@server/lib/notifications';
import Email from 'email-templates';
import assert from 'node:assert/strict';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import type { NotificationPayload } from './agent';
import EmailAgent from './email';

type BuildMessage = (
  type: Notification,
  payload: NotificationPayload,
  recipientEmail: string,
  recipientName?: string
) => { template: string; locals: Record<string, unknown> };

const payload = {
  event: 'Movie Could Not Be Found',
  subject: 'Test Movie (2020)',
  message: 'The system searched for Test Movie but could not find it.',
  notifyAdmin: false,
  notifySystem: true,
  media: { mediaType: MediaType.MOVIE, tmdbId: 100 },
  request: {
    is4k: false,
    isUpgrade: false,
    requestedBy: { displayName: 'Alex' },
  },
} as unknown as NotificationPayload;

const build = (type: Notification, overrides = {}) => {
  const agent = new EmailAgent() as unknown as { buildMessage: BuildMessage };

  return agent.buildMessage(
    type,
    { ...payload, ...overrides },
    'alex@seerr.dev',
    'Alex'
  );
};

const render = (template: string, file: string, locals: object) =>
  new Email({
    views: {
      root: path.dirname(template),
      options: { extension: 'pug' },
    },
  }).render(`${path.basename(template)}/${file}`, locals);

describe('EmailAgent, not found notification', () => {
  before(() => initI18n());

  it('fills the request template with the subject and sentence', async () => {
    const { template, locals } = build(Notification.MEDIA_NOT_FOUND);

    assert.strictEqual(path.basename(template), 'media-request');
    assert.strictEqual(
      await render(template, 'subject', locals),
      'Test Movie (2020) could not be found'
    );

    const html = await render(template, 'html', locals);
    assert.ok(
      html.includes('The system searched for Test Movie but could not find it.')
    );
    assert.ok(html.includes('Test Movie (2020)'));
  });

  it('is on for users with default settings and off when email is off', () => {
    assert.strictEqual(
      hasNotificationType(Notification.MEDIA_NOT_FOUND, ALL_NOTIFICATIONS),
      true
    );
    assert.strictEqual(
      hasNotificationType(Notification.MEDIA_NOT_FOUND, 0),
      false
    );
  });

  it('leaves the subject of other request emails as it was', async () => {
    const { template, locals } = build(Notification.MEDIA_DECLINED, {
      event: 'Movie Request Declined',
    });

    assert.match(
      await render(template, 'subject', locals),
      /^Movie Request Declined - Test Movie \(2020\) \[.*\]$/
    );
  });
});
