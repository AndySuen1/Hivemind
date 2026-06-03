import { z } from 'zod';
import { tool, type Tool } from 'ai';
import type { DiscordPushToolConfig } from '@hivemind/shared';
import type { MentionExperimentalContext } from './mention-bot.js';

/**
 * 构建 discord_push 工具（Phase 3.5）：让 bot 主动把消息推送到指定 Discord 频道，无需等用户先问
 *（常用于定时播报、任务完成通知）。只能推到 cfg.channelIds 白名单内的频道——fail-closed：空白名单全拒。
 * 实际发送经 experimental_context.push.sendToChannel（由 BotInstance 绑定到本 bot client）。
 */
export function buildDiscordPushTool(_botId: string, cfg: DiscordPushToolConfig): Record<string, Tool> {
  const discord_push = tool({
    description:
      '主动把一条消息推送到指定 Discord 频道（无需等用户提问）。只能推到你被授权的频道白名单内，' +
      '常用于定时播报、任务完成通知。channel_id 必须在白名单内，否则会被拒绝。',
    inputSchema: z.object({
      channel_id: z.string().min(1).describe('目标频道 id（必须在你的 discord_push 白名单内）'),
      content: z.string().min(1).max(4000).describe('要推送的消息正文（纯文本，过长会自动分块）'),
    }),
    execute: async ({ channel_id, content }, { experimental_context }) => {
      const ec = experimental_context as MentionExperimentalContext | undefined;
      const push = ec?.push;
      if (!push) return '错误：推送上下文缺失（内部错误），无法主动推消息。';
      // 双保险：既用工具自身快照的 cfg.channelIds，也用注入的 allowedChannelIds（同源），任一不含即拒。
      if (!cfg.channelIds.includes(channel_id) || !push.allowedChannelIds.includes(channel_id)) {
        return `错误：频道 ${channel_id} 不在你的推送白名单内，已拒绝。`;
      }
      const res = await push.sendToChannel(channel_id, content);
      return res.ok ? `已推送到频道 ${channel_id}。` : `错误：推送失败（${res.error ?? '频道不可用'}）。`;
    },
  });

  return { discord_push };
}
