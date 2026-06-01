import { z } from 'zod';
import { tool, type Tool } from 'ai';
import type { ClaudeCodeToolConfig } from '@hivemind/shared';
import { assertRealpathAllowed } from './path-guard.js';
import { tryAcquireDelegationSlot } from '../claude/concurrency.js';
import { runDelegation, getLastSession, sessionKey } from '../claude/delegation.js';
import type { DelegationContext } from '../claude/delegation.js';

// 由 bot-manager 每条消息通过 generateText 的 experimental_context 注入，供 execute 取 Discord 上下文。
export interface DelegateExperimentalContext {
  discord?: DelegationContext;
}

/**
 * 构建 delegate_to_claude 工具：DeepSeek 判断要真正写代码时调它，spawn 一个 Claude Code 子进程
 * 在工作目录白名单内干活。cwd 走 path-guard 校验；并发受 concurrency 护栏限制；过程/权限/反问
 * 由 delegation + permission-relay 中转到 Discord。
 */
export function buildDelegateTool(
  botId: string,
  workspaceDirs: string[],
  config: ClaudeCodeToolConfig
): Record<string, Tool> {
  const delegate_to_claude = tool({
    description:
      '把需要真正写/改/调试代码的复杂工程任务（多文件改动、跑命令、装依赖、写测试、重构等）委派给 Claude Code，在指定工作目录内自主完成。你只需把任务目标、约束、验收标准描述清楚。Claude 遇到危险操作（删文件、推送、联网、装包）或需要澄清时会向用户确认。⚠️ 仅用于动手写代码的工程任务；查资料、对话、简单读文件不要用它。',
    inputSchema: z.object({
      task: z
        .string()
        .min(1)
        .describe('交给 Claude 的完整任务描述（自然语言，越具体越好，可含约束与验收标准）'),
      workdir: z
        .string()
        .optional()
        .describe('工作目录绝对路径，必须在工作目录白名单内；省略则用第一个白名单目录'),
      resume: z
        .boolean()
        .optional()
        .describe('是否续接本频道上一次委派的 Claude 会话（用于「在刚才基础上继续改」）'),
    }),
    execute: async ({ task, workdir, resume }, { experimental_context }) => {
      const ctx = (experimental_context as DelegateExperimentalContext | undefined)?.discord;
      if (!ctx) return '错误：委派上下文缺失（内部错误），无法执行委派。';

      // 1) cwd 必须落在工作目录白名单内（realpath 防 junction 逃逸）
      const dirs = workspaceDirs.filter((p) => p.trim());
      if (!dirs.length)
        return '错误：未配置任何工作目录白名单，无法委派 Claude（请在工具配置里填写工作目录）。';
      const target = workdir ?? dirs[0];
      if (!target) return '错误：无可用工作目录。';
      let safeCwd: string;
      try {
        safeCwd = assertRealpathAllowed(target, dirs);
      } catch (e) {
        return `错误：${(e as Error).message}`;
      }

      // 2) 抢并发槽位（单 bot 1 / 全局 5）；抢不到不排队，直接告诉 DeepSeek 忙
      const acq = tryAcquireDelegationSlot(botId);
      if (!acq.ok) {
        return acq.reason === 'bot-busy'
          ? '我手上已经有一个 Claude Code 任务在跑了，请等它结束我再处理这个。'
          : '当前系统并发的 Claude Code 任务已达上限，请稍后再试。';
      }

      try {
        const resumeSessionId = resume
          ? getLastSession(sessionKey(botId, ctx.channel.id))
          : undefined;
        const outcome = await runDelegation({
          task,
          cwd: safeCwd,
          resumeSessionId,
          ctx,
          config: { maxTurns: config.maxTurns, timeoutMs: config.timeoutMs },
        });
        const prefix = outcome.ok ? '' : '（委派未成功完成，请如实转告用户，不要谎报已完成）\n';
        return `${prefix}Claude Code 执行结果：\n${outcome.summary}`;
      } finally {
        acq.slot.release();
      }
    },
  });

  return { delegate_to_claude };
}
