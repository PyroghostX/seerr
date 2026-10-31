import type { User } from '@server/entity/User';
import { Notification } from '@server/lib/notifications';
import DiscordAgent, {
  channelMentionIds,
} from '@server/lib/notifications/agents/discord';
import type { NotificationAgentDiscord } from '@server/lib/settings';
import axios from 'axios';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

const USER_ID = '123456789012345678';
const WEBHOOK_URL = 'https://discord.test/api/webhooks/1/abc';
const BOT_TOKEN = 'bot-token';

function makeAgent(
  options: Partial<NotificationAgentDiscord['options']> = {}
): DiscordAgent {
  return new DiscordAgent({
    enabled: true,
    embedPoster: false,
    types: Notification.MEDIA_AVAILABLE,
    options: {
      webhookUrl: WEBHOOK_URL,
      enableMentions: true,
      locale: 'en',
      useUserLocale: false,
      ...options,
    },
  });
}

const notifyUser = {
  displayName: 'alex',
  settings: {
    discordIds: [USER_ID],
    locale: 'en',
    hasNotificationType: () => true,
  },
} as unknown as User;

const payload = {
  subject: 'Movie (2026)',
  notifySystem: true,
  notifyAdmin: false,
  notifyUser,
};

type PostCall = {
  url: string;
  body: Record<string, unknown>;
  config?: unknown;
};

function mockPost(failDirectMessages = false): PostCall[] {
  const calls: PostCall[] = [];

  mock.method(
    axios,
    'post',
    async (url: string, body: Record<string, unknown>, config?: unknown) => {
      calls.push({ url, body, config });

      if (url.endsWith('/users/@me/channels')) {
        if (failDirectMessages) {
          throw new Error('Cannot send messages to this user');
        }
        return { data: { id: '999' } };
      }

      return { data: {} };
    }
  );

  return calls;
}

describe('channelMentionIds', () => {
  it('drops users who got a direct message and duplicates', () => {
    assert.deepEqual(channelMentionIds(['1', '2', '2', '3'], new Set(['2'])), [
      '1',
      '3',
    ]);
  });
});

describe('DiscordAgent direct messages', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('messages the user directly and leaves them out of the channel mentions', async () => {
    const calls = mockPost();

    const sent = await makeAgent({ botToken: BOT_TOKEN }).send(
      Notification.MEDIA_AVAILABLE,
      payload
    );

    assert.equal(sent, true);
    assert.deepEqual(
      calls.map((call) => call.url),
      [
        'https://discord.com/api/v10/users/@me/channels',
        'https://discord.com/api/v10/channels/999/messages',
        WEBHOOK_URL,
      ]
    );
    assert.deepEqual(calls[0].body, { recipient_id: USER_ID });
    assert.deepEqual(calls[0].config, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` },
    });
    assert.equal((calls[1].body.embeds as unknown[]).length, 1);
    assert.equal(calls[2].body.content, '');
    assert.deepEqual(calls[2].body.allowed_mentions, { users: [], roles: [] });
  });

  it('falls back to a channel mention when the direct message fails', async () => {
    const calls = mockPost(true);

    await makeAgent({ botToken: BOT_TOKEN }).send(
      Notification.MEDIA_AVAILABLE,
      payload
    );

    const webhookPost = calls[calls.length - 1];
    assert.equal(webhookPost.url, WEBHOOK_URL);
    assert.equal(webhookPost.body.content, `<@${USER_ID}>`);
    assert.deepEqual(webhookPost.body.allowed_mentions, {
      users: [USER_ID],
      roles: [],
    });
  });

  it('mentions in the channel as before without a bot token', async () => {
    const calls = mockPost();

    await makeAgent().send(Notification.MEDIA_AVAILABLE, payload);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, WEBHOOK_URL);
    assert.equal(calls[0].body.content, `<@${USER_ID}>`);
  });

  it('stays silent on the not found type when set to available only', async () => {
    const calls = mockPost();

    assert.equal(
      await makeAgent({ botToken: BOT_TOKEN }).send(
        Notification.MEDIA_NOT_FOUND,
        payload
      ),
      true
    );
    assert.equal(calls.length, 0);
  });

  it('sends direct messages without a channel webhook', async () => {
    const calls = mockPost();
    const agent = makeAgent({ webhookUrl: '', botToken: BOT_TOKEN });

    assert.equal(agent.shouldSend(), true);
    assert.equal(await agent.send(Notification.MEDIA_AVAILABLE, payload), true);
    assert.deepEqual(
      calls.map((call) => call.url),
      [
        'https://discord.com/api/v10/users/@me/channels',
        'https://discord.com/api/v10/channels/999/messages',
      ]
    );
  });

  it('does not send without a webhook or a bot token', () => {
    assert.equal(makeAgent({ webhookUrl: '' }).shouldSend(), false);
  });
});
