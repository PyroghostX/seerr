import {
  DISCORD_SNOWFLAKE_REGEX,
  EmbedColors,
} from '@server/constants/discord';
import { IssueStatus, IssueTypeName } from '@server/constants/issue';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { getIntl } from '@server/i18n';
import globalMessages from '@server/i18n/globalMessages';
import type { NotificationAgentDiscord } from '@server/lib/settings';
import { NotificationAgentKey, getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { AvailableLocale } from '@server/types/languages';
import axios from 'axios';
import {
  Notification,
  hasNotificationType,
  shouldSendAdminNotification,
} from '..';
import type { NotificationAgent, NotificationPayload } from './agent';
import { BaseAgent } from './agent';

const isValidSnowflake = (id: string): boolean =>
  DISCORD_SNOWFLAKE_REGEX.test(id);

const DISCORD_API_URL = 'https://discord.com/api/v10';

/**
 * Discord IDs to mention in the channel post: everyone who would have been
 * mentioned, minus the users who already got the notification as a direct
 * message, without duplicates.
 */
export const channelMentionIds = (
  ids: string[],
  directMessaged: Set<string>
): string[] => [...new Set(ids.filter((id) => !directMessaged.has(id)))];

interface DiscordImageEmbed {
  url?: string;
  proxy_url?: string;
  height?: number;
  width?: number;
}

interface Field {
  name: string;
  value: string;
  inline?: boolean;
}
interface DiscordRichEmbed {
  title?: string;
  type?: 'rich';
  description?: string;
  url?: string;
  timestamp?: string;
  color?: number;
  footer?: {
    text: string;
    icon_url?: string;
    proxy_icon_url?: string;
  };
  image?: DiscordImageEmbed;
  thumbnail?: DiscordImageEmbed;
  provider?: {
    name?: string;
    url?: string;
  };
  author?: {
    name?: string;
    url?: string;
    icon_url?: string;
    proxy_icon_url?: string;
  };
  fields?: Field[];
}

interface DiscordWebhookPayload {
  embeds: DiscordRichEmbed[];
  username?: string;
  avatar_url?: string;
  tts: boolean;
  content?: string;
  allowed_mentions?: {
    parse?: ('users' | 'roles' | 'everyone')[];
    roles?: string[];
    users?: string[];
  };
}

class DiscordAgent
  extends BaseAgent<NotificationAgentDiscord>
  implements NotificationAgent
{
  protected getSettings(): NotificationAgentDiscord {
    if (this.settings) {
      return this.settings;
    }

    const settings = getSettings();

    return settings.notifications.agents.discord;
  }

  public buildEmbed(
    type: Notification,
    payload: NotificationPayload,
    locale?: AvailableLocale
  ): DiscordRichEmbed {
    const intl = getIntl(locale);
    const settings = getSettings();
    const { applicationUrl } = settings.main;
    const { embedPoster } = settings.notifications.agents.discord;

    const appUrl =
      applicationUrl || `http://localhost:${process.env.port || 5055}`;
    let color = EmbedColors.DARK_PURPLE;
    const fields: Field[] = [];

    if (payload.request) {
      fields.push({
        name: intl.formatMessage(globalMessages.requestedBy),
        value: payload.request.requestedBy.displayName,
        inline: true,
      });

      let status = '';
      switch (type) {
        case Notification.MEDIA_PENDING:
          color = EmbedColors.ORANGE;
          status = `[${intl.formatMessage(globalMessages.pendingApproval)}](${appUrl}/requests)`;
          break;
        case Notification.MEDIA_APPROVED:
        case Notification.MEDIA_AUTO_APPROVED:
          color = EmbedColors.PURPLE;
          status = intl.formatMessage(globalMessages.processing);
          break;
        case Notification.MEDIA_AVAILABLE:
          color = EmbedColors.GREEN;
          status = intl.formatMessage(globalMessages.available);
          break;
        case Notification.MEDIA_DECLINED:
          color = EmbedColors.RED;
          status = intl.formatMessage(globalMessages.declined);
          break;
        case Notification.MEDIA_FAILED:
          color = EmbedColors.RED;
          status = intl.formatMessage(globalMessages.failed);
          break;
      }

      if (status) {
        fields.push({
          name: intl.formatMessage(globalMessages.requestStatus),
          value: status,
          inline: true,
        });
      }
    } else if (payload.comment) {
      fields.push({
        name: intl.formatMessage(globalMessages.commentFrom, {
          userName: payload.comment.user.displayName,
        }),
        value: payload.comment.message,
        inline: false,
      });
    } else if (payload.issue) {
      fields.push(
        {
          name: intl.formatMessage(globalMessages.reportedBy),
          value: payload.issue.createdBy.displayName,
          inline: true,
        },
        {
          name: intl.formatMessage(globalMessages.issueType),
          value: IssueTypeName[payload.issue.issueType],
          inline: true,
        },
        {
          name: intl.formatMessage(globalMessages.issueStatus),
          value:
            payload.issue.status === IssueStatus.OPEN
              ? intl.formatMessage(globalMessages.open)
              : intl.formatMessage(globalMessages.resolved),
          inline: true,
        }
      );

      switch (type) {
        case Notification.ISSUE_CREATED:
        case Notification.ISSUE_REOPENED:
          color = EmbedColors.RED;
          break;
        case Notification.ISSUE_COMMENT:
          color = EmbedColors.ORANGE;
          break;
        case Notification.ISSUE_RESOLVED:
          color = EmbedColors.GREEN;
          break;
      }
    }

    for (const extra of payload.extra ?? []) {
      fields.push({
        name: extra.name,
        value: extra.value,
        inline: true,
      });
    }

    const url = applicationUrl
      ? payload.issue
        ? `${applicationUrl}/issues/${payload.issue.id}`
        : payload.media
          ? `${applicationUrl}/${payload.media.mediaType}/${payload.media.tmdbId}`
          : undefined
      : undefined;

    return {
      title: payload.event
        ? `${payload.event}: ${payload.subject}`
        : payload.subject,
      url,
      description: payload.message,
      color,
      timestamp: new Date().toISOString(),
      fields,
      thumbnail: embedPoster
        ? {
            url: payload.image,
          }
        : undefined,
    };
  }

  public shouldSend(): boolean {
    const settings = this.getSettings();

    // A bot token alone is enough: users still get their direct messages
    // even without a channel webhook.
    if (
      settings.enabled &&
      (settings.options.webhookUrl || settings.options.botToken)
    ) {
      return true;
    }

    return false;
  }

  /**
   * Sends the embed to each Discord user ID as a direct message from the
   * bot. Returns the IDs that were delivered; failures are logged (without
   * the token) and left for the caller to mention in the channel instead.
   */
  private async sendDirectMessages(
    botToken: string,
    discordIds: string[],
    embed: DiscordRichEmbed,
    type: Notification
  ): Promise<Set<string>> {
    const delivered = new Set<string>();
    const headers = { Authorization: `Bot ${botToken}` };

    for (const recipientId of discordIds) {
      try {
        const channel = await axios.post<{ id: string }>(
          `${DISCORD_API_URL}/users/@me/channels`,
          { recipient_id: recipientId },
          { headers }
        );

        await axios.post(
          `${DISCORD_API_URL}/channels/${channel.data.id}/messages`,
          { embeds: [embed] },
          { headers }
        );

        delivered.add(recipientId);
        logger.info('Sent Discord direct message', {
          label: 'Notifications',
          type: Notification[type],
          recipientId,
          subject: embed.title,
        });
      } catch (e) {
        logger.warn(
          'Failed to send Discord direct message; mentioning in the channel instead',
          {
            label: 'Notifications',
            type: Notification[type],
            recipientId,
            errorMessage: e.message,
            response: e?.response?.data,
          }
        );
      }
    }

    return delivered;
  }

  public async send(
    type: Notification,
    payload: NotificationPayload
  ): Promise<boolean> {
    const settings = this.getSettings();

    if (
      !payload.notifySystem ||
      !hasNotificationType(type, settings.types ?? 0)
    ) {
      return true;
    }

    logger.debug('Sending Discord notification', {
      label: 'Notifications',
      type: Notification[type],
      subject: payload.subject,
    });

    try {
      const notifyUserIds =
        payload.notifyUser?.settings?.hasNotificationType(
          NotificationAgentKey.DISCORD,
          type
        ) && payload.notifyUser.settings.discordIds?.length
          ? payload.notifyUser.settings.discordIds.filter((id) =>
              isValidSnowflake(id)
            )
          : [];

      // With a bot token, the user being notified gets the embed as a direct
      // message instead of a mention in the channel
      let directMessaged = new Set<string>();

      if (settings.options.botToken && notifyUserIds.length) {
        directMessaged = await this.sendDirectMessages(
          settings.options.botToken,
          notifyUserIds,
          this.buildEmbed(
            type,
            payload,
            (payload.notifyUser?.settings?.locale ||
              settings.options.locale) as AvailableLocale
          ),
          type
        );
      }

      if (!settings.options.webhookUrl) {
        return true;
      }

      const mentionIds: string[] = [];

      if (settings.options.enableMentions) {
        mentionIds.push(...notifyUserIds);

        if (payload.notifyAdmin) {
          const userRepository = getRepository(User);
          const users = await userRepository.find();

          mentionIds.push(
            ...users
              .filter(
                (user) =>
                  user.settings?.hasNotificationType(
                    NotificationAgentKey.DISCORD,
                    type
                  ) &&
                  user.settings.discordIds?.length &&
                  shouldSendAdminNotification(type, user, payload)
              )
              .flatMap((user) =>
                user.settings!.discordIds.filter((id) => isValidSnowflake(id))
              )
          );
        }
      }

      const allowedUserIds = channelMentionIds(mentionIds, directMessaged);
      const userMentions = allowedUserIds.map((id) => `<@${id}>`);

      const allowedRoleIds: string[] = [];

      if (
        settings.options.webhookRoleId &&
        isValidSnowflake(settings.options.webhookRoleId)
      ) {
        userMentions.push(`<@&${settings.options.webhookRoleId}>`);
        allowedRoleIds.push(settings.options.webhookRoleId);
      }

      // Discord webhooks go to a channel, not per-user,
      // so if use user locale is set, we'll use the locale of the user being notified
      // if not, we'll use the default locale set in the notification settings
      const locale = settings.options.useUserLocale
        ? (payload.notifyUser?.settings?.locale as AvailableLocale)
        : (settings.options.locale as AvailableLocale);

      const webhookUrl = new URL(settings.options.webhookUrl);
      if (settings.options.webhookThreadId) {
        webhookUrl.searchParams.set(
          'thread_id',
          settings.options.webhookThreadId
        );
      }

      await axios.post(webhookUrl.toString(), {
        username: settings.options.botUsername
          ? settings.options.botUsername
          : getSettings().main.applicationTitle,
        avatar_url: settings.options.botAvatarUrl,
        embeds: [this.buildEmbed(type, payload, locale)],
        content: userMentions.join(' '),
        allowed_mentions: {
          users: allowedUserIds,
          roles: allowedRoleIds,
        },
      } as DiscordWebhookPayload);

      return true;
    } catch (e) {
      logger.error('Error sending Discord notification', {
        label: 'Notifications',
        type: Notification[type],
        subject: payload.subject,
        errorMessage: e.message,
        response: e?.response?.data,
      });

      return false;
    }
  }
}

export default DiscordAgent;
