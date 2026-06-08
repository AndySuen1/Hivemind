import { z } from 'zod';
import { tool, type Tool } from 'ai';
import type { DelegationContext } from '../claude/delegation.js';

// open_claude_thread 工具的上下文：复用 delegate 的 .discord（DelegationContext）。由 bot-manager 注入。
export interface OpenThreadExperimentalContext {
  discord?: DelegationContext;
}

/** 主脑判定用户想「开一个 Claude 编码会话帖」时回调到 BotInstance 建帖 + 起首轮。返回给主脑转告的结果串。 */
export type OpenThreadFn = (
  ctx: DelegationContext,
  args: { task: string; workdir?: string }
) => Promise<{ ok: boolean; message: string }>;

/**
 * 构建 open_claude_thread 工具：当用户**口语**表达「想开一个独立的 Claude Code 编码会话/在某工作区动手写改代码、
 * 并要一个专属论坛帖承载」时，DeepSeek 主脑调它——在论坛频道建帖、绑定一个本地 Claude session、把首个任务交给它；
 * 之后用户在那个帖子里继续对话（直通 Claude，主脑不再参与）。与 delegate_to_claude 的区别：delegate 是在当前频道
 * 一次性委派、主脑等结果；本工具是开一个**持续的帖子会话**，建完即返回帖子链接、用户去帖里自己继续。
 */
export function buildOpenThreadTool(openThread: OpenThreadFn): Record<string, Tool> {
  const open_claude_thread = tool({
    description:
      '当用户想「开一个独立的 Claude Code 编码会话」——即让 Claude 在某个工作目录里动手写/改/调代码，并希望有一个专门的论坛帖子承载这次会话（之后在帖子里持续对话）时，调用它。它会在论坛频道建一个帖子、绑定一个本地 Claude Code session、把首个任务交给它，并把帖子链接返回给你转告用户。用户随后在那个帖子里继续（无需你参与）。识别「开会话」的口语很多：「开个/新建一个 claude（会话）」「在 X 工作区开 claude 帮我…」「起一个帖子让 claude 做…」等。⚠️ 与 delegate_to_claude 区分：需要一个能持续追问/对话的专属帖子用本工具；只是当前频道一次性写点代码用 delegate_to_claude。普通问答/查资料/闲聊都不要调。',
    inputSchema: z.object({
      task: z
        .string()
        .min(1)
        .describe('交给这个新 Claude 会话的首个任务/目标（自然语言，尽量具体；用户没明说就用其原话）'),
      workdir: z
        .string()
        .optional()
        .describe('在哪个工作目录开（目录名或绝对路径，须在工作目录白名单内；省略 = 第一个工作目录/主工作区）'),
    }),
    execute: async ({ task, workdir }, { experimental_context }) => {
      const ctx = (experimental_context as OpenThreadExperimentalContext | undefined)?.discord;
      if (!ctx) return '错误：上下文缺失（内部错误），无法开 Claude 帖。';
      const res = await openThread(ctx, { task, workdir });
      return res.message;
    },
  });

  return { open_claude_thread };
}
