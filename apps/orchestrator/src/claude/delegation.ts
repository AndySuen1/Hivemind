// 委派核心：用 @anthropic-ai/claude-agent-sdk 的 query() 在工作目录内驱动一个 Claude 子进程，
// 把过程实时反映到 Discord（编辑同一条状态消息），权限/反问交给 permission-relay 中转，
// 并管理 sessionId 以支持 resume。走本机订阅鉴权（不传 API key）。
//
// mode-agnostic 的「组装 options / AbortController·超时 / 跑 query / 泵 SDKMessage 流」核心已抽到
// delegation-core.ts（与 Claude 帖直通共享）；本文件 = 「状态摘要渲染器(StatusEditSink)」薄封装。

import { query } from '@anthropic-ai/claude-agent-sdk';
import { createPermissionHandler } from './permission-relay.js';
import { editStatus, sendStatus } from './discord-ui.js';
import type { Message, SendableChannels } from 'discord.js';
import { recorder } from '../recorder.js';
import {
  buildClaudeOptions,
  pumpQuery,
  toolLabel,
  wireAbort,
  type ClaudeStreamSink,
  type ClaudeToolUse,
} from './delegation-core.js';

// 共享 block 解析对外仍从本文件导出（p3-smoke 等历史引用），实现已搬到 delegation-core。
export { extractAssistant } from './delegation-core.js';
export type { ClaudeToolUse } from './delegation-core.js';

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000; // 单个权限按钮 5 分钟
const QUESTION_TIMEOUT_MS = 30 * 60 * 1000; // AskUserQuestion 30 分钟
const STATUS_THROTTLE_MS = 1200; // 状态消息最小编辑间隔，防 Discord 限流

export interface DelegationContext {
  botId: string;
  botName: string;
  requesterId: string;
  channel: SendableChannels;
  /** 上层中止信号：bot 停机 / 该消息处理被放弃。 */
  signal: AbortSignal;
  /** 可观测性：本回合的 runId/sessionId（由 bot-manager 经 experimental_context 注入）。缺省则不记录委派事件。 */
  runId?: string;
  sessionId?: string;
}

export interface DelegationConfig {
  maxTurns: number;
  timeoutMs: number;
}

export interface DelegationOutcome {
  ok: boolean;
  /** 回给 DeepSeek 的摘要（Claude 的最终文本，或错误说明）。 */
  summary: string;
  sessionId?: string;
  numTurns?: number;
  costUsd?: number;
  rateLimited?: boolean;
}

// 各 (bot, 频道) 最近一次的 sessionId，供「刚才那个…再改一下」resume。仅内存，重启即清。
const sessionStore = new Map<string, string>();
export const sessionKey = (botId: string, channelId: string): string => `${botId}:${channelId}`;
export const getLastSession = (key: string): string | undefined => sessionStore.get(key);
export const setLastSession = (key: string, id: string): void => void sessionStore.set(key, id);

/** 状态摘要渲染器：把 Claude 的进度节流编辑进同一条状态消息，并把每个 tool_use 记成 delegate_step。 */
class StatusEditSink implements ClaudeStreamSink {
  private lastEditAt = 0;
  private stepCount = 0;
  constructor(
    private readonly statusMsg: Message,
    private readonly botName: string,
    private readonly obs: { runId: string; sessionId: string; botId: string; parentEventId?: string }
  ) {}

  private async updateStatus(line: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastEditAt < STATUS_THROTTLE_MS) return;
    this.lastEditAt = now;
    await editStatus(this.statusMsg, `🤖 **${this.botName}** ▸ Claude Code 工作中（第 ${this.stepCount} 步）\n${line}`);
  }

  async onAssistant(_text: string, toolUses: ClaudeToolUse[]): Promise<void> {
    for (const tu of toolUses) {
      this.stepCount++;
      await this.updateStatus(`${toolLabel(tu.name)}…`);
      // 委派步：Claude 的每个 tool_use 都记一条，挂在 delegate_start 下（UI 默认折叠）。
      recorder.recordEvent({
        runId: this.obs.runId,
        sessionId: this.obs.sessionId,
        botId: this.obs.botId,
        type: 'delegate_step',
        toolName: tu.name,
        label: toolLabel(tu.name),
        status: 'ok',
        input: tu.input,
        parentEventId: this.obs.parentEventId,
      });
    }
  }
}

export async function runDelegation(params: {
  task: string;
  cwd: string;
  resumeSessionId?: string;
  ctx: DelegationContext;
  config: DelegationConfig;
}): Promise<DelegationOutcome> {
  const { task, cwd, resumeSessionId, ctx, config } = params;

  // AbortController + 挂钟超时（上层 signal / 超时任一触发都中止）
  const abort = wireAbort(ctx.signal, config.timeoutMs);

  const statusMsg = await sendStatus(
    ctx.channel,
    `🤖 **${ctx.botName}** 已把任务委派给 Claude Code，正在处理…${resumeSessionId ? '（续上次会话）' : ''}`
  );

  // 可观测性：本回合 runId/sessionId（缺省=空串，recorder 会按外键 fail-safe 跳过，不记委派事件）。
  const obsRunId = ctx.runId ?? '';
  const obsSessionId = ctx.sessionId ?? '';
  // delegate_start：作为本次委派所有子事件的父节点，UI 默认折叠成「委派(N步,$X)」。
  const parentEventId =
    recorder.recordEvent({
      runId: obsRunId,
      sessionId: obsSessionId,
      botId: ctx.botId,
      type: 'delegate_start',
      toolName: 'delegate_to_claude',
      label: '🤖 委派 Claude Code',
      status: 'running',
      input: { task, cwd, resume: !!resumeSessionId },
    }) || undefined;

  const obs = { runId: obsRunId, sessionId: obsSessionId, botId: ctx.botId, parentEventId };

  // 收尾事件（每个 return 分支前调一次）。
  let sessionId: string | undefined;
  let numTurns: number | undefined;
  let costUsd: number | undefined;
  let rateLimited = false;
  const recordEnd = (status: string, summary: string): void => {
    recorder.recordEvent({
      runId: obsRunId,
      sessionId: obsSessionId,
      botId: ctx.botId,
      type: 'delegate_end',
      toolName: 'delegate_to_claude',
      label: '🤖 委派 Claude Code',
      status,
      output: { summary, numTurns, costUsd, rateLimited, claudeSessionId: sessionId },
      parentEventId,
    });
  };

  const handler = createPermissionHandler({
    botName: ctx.botName,
    requesterId: ctx.requesterId,
    channel: ctx.channel,
    signal: abort.ac.signal,
    permissionTimeoutMs: PERMISSION_TIMEOUT_MS,
    questionTimeoutMs: QUESTION_TIMEOUT_MS,
    observe: obsRunId ? obs : undefined,
  });

  const options = buildClaudeOptions({
    cwd,
    abortController: abort.ac,
    canUseTool: handler,
    maxTurns: config.maxTurns,
    resumeSessionId,
    logTag: ctx.botName,
  });

  const sink = new StatusEditSink(statusMsg, ctx.botName, obs);

  let finalText = '';
  let isError = false;
  try {
    const r = await pumpQuery(query({ prompt: task, options }), sink, { logTag: ctx.botName });
    sessionId = r.sessionId;
    finalText = r.finalText;
    isError = r.isError;
    numTurns = r.numTurns;
    costUsd = r.costUsd;
    rateLimited = r.rateLimited;
  } catch (e) {
    abort.dispose();
    const msg = abort.timedOut()
      ? `Claude 执行超时（>${Math.round(config.timeoutMs / 60000)} 分钟），已中止。`
      : ctx.signal.aborted
        ? 'Claude 任务已被取消。'
        : `Claude 执行出错：${(e as Error).message}`;
    recordEnd(abort.timedOut() || ctx.signal.aborted ? 'aborted' : 'error', msg);
    await editStatus(statusMsg, `⚠️ ${msg}`);
    return { ok: false, summary: msg, sessionId, rateLimited };
  }

  abort.dispose();

  if (sessionId) setLastSession(sessionKey(ctx.botId, ctx.channel.id), sessionId);

  const meta = [
    numTurns != null ? `${numTurns} 轮` : null,
    costUsd != null ? `~$${costUsd.toFixed(3)}` : null,
    rateLimited ? '⚠️限流' : null,
  ].filter(Boolean).join(' · ');

  if (abort.timedOut() || abort.ac.signal.aborted) {
    const msg = abort.timedOut() ? `Claude 执行超时已中止（${meta}）。` : 'Claude 任务已被取消。';
    recordEnd('aborted', msg);
    await editStatus(statusMsg, `⚠️ ${msg}`);
    return { ok: false, summary: msg, sessionId, numTurns, costUsd, rateLimited };
  }

  if (isError) {
    const msg = finalText || 'Claude 执行未成功完成。';
    recordEnd('error', msg);
    await editStatus(statusMsg, `⚠️ Claude 未成功完成（${meta}）`);
    return { ok: false, summary: msg, sessionId, numTurns, costUsd, rateLimited };
  }

  const successSummary = finalText || '（Claude 已完成，但没有返回文本说明。）';
  recordEnd('ok', successSummary);
  await editStatus(statusMsg, `✅ **${ctx.botName}** ▸ Claude Code 完成（${meta}）`);
  return {
    ok: true,
    summary: successSummary,
    sessionId,
    numTurns,
    costUsd,
    rateLimited,
  };
}
