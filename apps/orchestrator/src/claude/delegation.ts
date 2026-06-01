// 委派核心：用 @anthropic-ai/claude-agent-sdk 的 query() 在工作目录内驱动一个 Claude 子进程，
// 把过程实时反映到 Discord（编辑同一条状态消息），权限/反问交给 permission-relay 中转，
// 并管理 sessionId 以支持 resume。走本机订阅鉴权（不传 API key）。

import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createPermissionHandler } from './permission-relay.js';
import { editStatus, sendStatus } from './discord-ui.js';
import type { SendableChannels } from 'discord.js';
import { recorder } from '../recorder.js';

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

/** 工具名 → 给用户看的友好状态标签。 */
function toolLabel(name: string): string {
  switch (name) {
    case 'Bash': return '🔧 执行命令';
    case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': return '✏️ 修改文件';
    case 'Read': case 'Grep': case 'Glob': case 'LS': case 'NotebookRead': return '🔎 阅读代码';
    case 'WebFetch': case 'WebSearch': return '🌐 联网查询';
    case 'AskUserQuestion': return '❓ 向你提问';
    case 'Task': return '🤖 调度子任务';
    default: return `🔧 ${name}`;
  }
}

export interface ClaudeToolUse {
  name: string;
  input: unknown;
}

export function extractAssistant(content: unknown): { text: string; toolUses: ClaudeToolUse[] } {
  const blocks = Array.isArray(content) ? content : [];
  let text = '';
  const toolUses: ClaudeToolUse[] = [];
  for (const b of blocks) {
    const blk = (b ?? {}) as { type?: string; text?: string; name?: string; input?: unknown };
    if (blk.type === 'text' && typeof blk.text === 'string') text += blk.text;
    else if (blk.type === 'tool_use' && typeof blk.name === 'string') toolUses.push({ name: blk.name, input: blk.input });
  }
  return { text, toolUses };
}

export async function runDelegation(params: {
  task: string;
  cwd: string;
  resumeSessionId?: string;
  ctx: DelegationContext;
  config: DelegationConfig;
}): Promise<DelegationOutcome> {
  const { task, cwd, resumeSessionId, ctx, config } = params;

  // 本次委派的 AbortController：上层 signal、挂钟超时任一触发都中止子进程与待处理的 Discord 交互
  const ac = new AbortController();
  const onUpstreamAbort = (): void => ac.abort();
  if (ctx.signal.aborted) ac.abort();
  else ctx.signal.addEventListener('abort', onUpstreamAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, config.timeoutMs);

  const statusMsg = await sendStatus(
    ctx.channel,
    `🤖 **${ctx.botName}** 已把任务委派给 Claude Code，正在处理…${resumeSessionId ? '（续上次会话）' : ''}`
  );

  let lastEditAt = 0;
  let stepCount = 0;
  const updateStatus = async (line: string): Promise<void> => {
    const now = Date.now();
    if (now - lastEditAt < STATUS_THROTTLE_MS) return;
    lastEditAt = now;
    await editStatus(statusMsg, `🤖 **${ctx.botName}** ▸ Claude Code 工作中（第 ${stepCount} 步）\n${line}`);
  };

  // 子进程产出的状态（在 recordEnd 闭包里引用，故先声明）
  let sessionId: string | undefined;
  let finalText = '';
  let isError = false;
  let numTurns: number | undefined;
  let costUsd: number | undefined;
  let rateLimited = false;

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

  // 收尾事件（每个 return 分支前调一次）；numTurns/costUsd/rateLimited/sessionId 取闭包内最终值。
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
    signal: ac.signal,
    permissionTimeoutMs: PERMISSION_TIMEOUT_MS,
    questionTimeoutMs: QUESTION_TIMEOUT_MS,
    observe: obsRunId ? { runId: obsRunId, sessionId: obsSessionId, botId: ctx.botId, parentEventId } : undefined,
  });

  const options: Options = {
    cwd,
    abortController: ac,
    canUseTool: handler,
    maxTurns: config.maxTurns,
    permissionMode: 'default',
    // 隔离：不加载本机 .claude 设置（避免 bot 的 Claude 继承本项目的放行规则），权限完全由 canUseTool 决定
    settingSources: [],
    stderr: (d) => process.stderr.write(`[claude:${ctx.botName}] ${d}`),
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
  };

  try {
    for await (const message of query({ prompt: task, options }) as AsyncIterable<SDKMessage>) {
      switch (message.type) {
        case 'system':
          if (message.subtype === 'init') {
            sessionId = message.session_id;
            // apiKeySource 可确认走的是 oauth（订阅）而非 api key
            console.log(`[claude:${ctx.botName}] init session=${sessionId} auth=${message.apiKeySource} model=${message.model}`);
          }
          break;
        case 'assistant': {
          const { text, toolUses } = extractAssistant(message.message?.content);
          if (text) finalText = text; // 末次文本即最终回答
          for (const tu of toolUses) {
            stepCount++;
            await updateStatus(`${toolLabel(tu.name)}…`);
            // 委派步：Claude 的每个 tool_use 都记一条，挂在 delegate_start 下（UI 默认折叠）。
            recorder.recordEvent({
              runId: obsRunId,
              sessionId: obsSessionId,
              botId: ctx.botId,
              type: 'delegate_step',
              toolName: tu.name,
              label: toolLabel(tu.name),
              status: 'ok',
              input: tu.input,
              parentEventId,
            });
          }
          break;
        }
        case 'rate_limit_event': {
          // 该事件在「用量信息变化」时就会推送，多数 status 为 allowed（仅进度更新）。
          // 只有 rejected 才是真正被挡；allowed_warning 仅预警，不算限流、不标红。
          const info = message.rate_limit_info;
          if (info?.status === 'rejected') {
            rateLimited = true;
            console.warn(
              `[claude:${ctx.botName}] 被限流 type=${info.rateLimitType} resetsAt=${info.resetsAt} overage=${info.isUsingOverage}`
            );
          } else if (info?.status === 'allowed_warning') {
            console.warn(`[claude:${ctx.botName}] 用量接近上限 type=${info.rateLimitType} util=${info.utilization}`);
          }
          break;
        }
        case 'result':
          numTurns = message.num_turns;
          costUsd = message.total_cost_usd;
          isError = message.is_error || message.subtype !== 'success';
          if (message.subtype === 'success' && typeof message.result === 'string') {
            finalText = message.result;
          }
          break;
        default:
          break;
      }
    }
  } catch (e) {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onUpstreamAbort);
    const msg = timedOut
      ? `Claude 执行超时（>${Math.round(config.timeoutMs / 60000)} 分钟），已中止。`
      : ctx.signal.aborted
        ? 'Claude 任务已被取消。'
        : `Claude 执行出错：${(e as Error).message}`;
    recordEnd(timedOut || ctx.signal.aborted ? 'aborted' : 'error', msg);
    await editStatus(statusMsg, `⚠️ ${msg}`);
    return { ok: false, summary: msg, sessionId, rateLimited };
  }

  clearTimeout(timer);
  ctx.signal.removeEventListener('abort', onUpstreamAbort);

  if (sessionId) setLastSession(sessionKey(ctx.botId, ctx.channel.id), sessionId);

  const meta = [
    numTurns != null ? `${numTurns} 轮` : null,
    costUsd != null ? `~$${costUsd.toFixed(3)}` : null,
    rateLimited ? '⚠️限流' : null,
  ].filter(Boolean).join(' · ');

  if (timedOut || ac.signal.aborted) {
    const msg = timedOut ? `Claude 执行超时已中止（${meta}）。` : 'Claude 任务已被取消。';
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
