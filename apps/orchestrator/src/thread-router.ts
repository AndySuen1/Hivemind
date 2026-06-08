// Claude 帖直通的分流判定（纯函数，不碰 discord.js / DB，便于单测）。
// bot-manager 在 handleMessage 早期把消息上下文 + 绑定查询结果喂进来，按返回的 kind 走对应 handler：
//   create      → 在论坛频道建帖 + 起首个直通回合
//   passthrough → 帖内消息直接喂给绑定的 Claude session（跳过 DeepSeek）
//   reset       → 帖内「重开 session」命令
//   normal      → 其余，走现有 DeepSeek 流（不变）

export type ThreadFork =
  | { kind: 'create'; prompt: string }
  | { kind: 'passthrough' }
  | { kind: 'reset'; instruction: string }
  | { kind: 'normal' };

export interface ThreadClassifyInput {
  /** bot.tools.claudeThread.enabled */
  enabled: boolean;
  /** bot.tools.claudeThread.forumChannelId（建帖目标；空=未配置，不建帖） */
  forumChannelId: string;
  /** bot.tools.claudeThread.triggerKeyword */
  triggerKeyword: string;
  /** bot.tools.claudeThread.resetKeywords */
  resetKeywords: string[];
  /** 消息是否发生在 thread 内 */
  isThread: boolean;
  /** 是否 @了本 bot（建帖触发需要） */
  isMentioned: boolean;
  /** 已清洗的消息正文（@self 前缀已去除） */
  content: string;
  /** 该 thread 是否绑定了**本 bot**的一个 active session（threadSessionRepo.getByThread 命中） */
  boundActive: boolean;
}

/** content 是否以某关键词开头（关键词后须是空白或结尾，避免「重开机」误命中「重开」）。命中返回剩余正文。 */
function matchPrefixKeyword(content: string, keywords: string[]): { rest: string } | null {
  const trimmed = content.trimStart();
  for (const kwRaw of keywords) {
    const kw = kwRaw.trim();
    if (!kw) continue;
    if (trimmed === kw) return { rest: '' };
    if (trimmed.startsWith(kw)) {
      const after = trimmed.slice(kw.length);
      // 关键词后须是空白（防 '重开机' 命中 '重开'）。允许紧跟标点/换行视作分隔。
      if (/^[\s:：,，。]/.test(after) || after === '') return { rest: after.trim() };
    }
  }
  return null;
}

export function classifyThreadMessage(input: ThreadClassifyInput): ThreadFork {
  if (!input.enabled) return { kind: 'normal' };

  // 1) 绑定帖内：免 @，每条消息都算一个 Claude turn；先看是不是 reset 命令。
  if (input.isThread && input.boundActive) {
    const reset = matchPrefixKeyword(input.content, input.resetKeywords);
    if (reset) return { kind: 'reset', instruction: reset.rest };
    return { kind: 'passthrough' };
  }

  // 2) 非帖内 + @bot + 触发词 + 已配置论坛频道 → 建帖。
  if (!input.isThread && input.isMentioned && input.forumChannelId.trim()) {
    const create = matchPrefixKeyword(input.content, [input.triggerKeyword]);
    if (create) return { kind: 'create', prompt: create.rest };
  }

  return { kind: 'normal' };
}
