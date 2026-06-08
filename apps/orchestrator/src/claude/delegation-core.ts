// 委派/直通的共享引擎：mode-agnostic 的「组装 options + 跑 query 的 AbortController/超时 + 把
// SDKMessage 流泵给可插拔渲染器(Sink)」核心。两个渲染器都插在这里——
//   · delegation.ts 的 StatusEditSink（编辑单条状态消息，现有委派行为）
//   · thread-stream-sink.ts 的 ThreadStreamSink（逐步贴帖，Claude 帖直通）
// 不碰 Discord、不碰 recorder（那是各 Sink 自己的事），只负责协议解析与生命周期。

import type { CanUseTool, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// ============================================================
// SDKMessage block 解析（两渲染器共享）
// ============================================================

export interface ClaudeToolUse {
  name: string;
  input: unknown;
  /** tool_use 块的 id，供把后续 tool_result 映射回工具名（逐字贴帖渲染器用）。 */
  id?: string;
}

/** 从 assistant 消息的 content 抽出拼接文本 + 全部 tool_use（命令/工具入参原文）。 */
export function extractAssistant(content: unknown): { text: string; toolUses: ClaudeToolUse[] } {
  const blocks = Array.isArray(content) ? content : [];
  let text = '';
  const toolUses: ClaudeToolUse[] = [];
  for (const b of blocks) {
    const blk = (b ?? {}) as { type?: string; text?: string; name?: string; input?: unknown; id?: string };
    if (blk.type === 'text' && typeof blk.text === 'string') text += blk.text;
    else if (blk.type === 'tool_use' && typeof blk.name === 'string') toolUses.push({ name: blk.name, input: blk.input, id: blk.id });
  }
  return { text, toolUses };
}

export interface ClaudeToolResult {
  toolUseId?: string;
  /** tool_result 的 content（可能是字符串或块数组，由渲染器决定怎么展示）。 */
  content: unknown;
  isError: boolean;
}

/**
 * 从 SDK 的 `type:'user'` 消息抽出 tool_result 块——这是工具结果/文件 diff 回传的通道
 * （现有委派完全没消费它；逐字贴帖渲染器靠它贴出真实命令输出）。
 */
export function extractToolResults(content: unknown): ClaudeToolResult[] {
  const blocks = Array.isArray(content) ? content : [];
  const out: ClaudeToolResult[] = [];
  for (const b of blocks) {
    const blk = (b ?? {}) as { type?: string; content?: unknown; is_error?: boolean; tool_use_id?: string };
    if (blk.type === 'tool_result') {
      out.push({ toolUseId: blk.tool_use_id, content: blk.content, isError: blk.is_error === true });
    }
  }
  return out;
}

/** 工具名 → 给用户看的友好状态标签（状态摘要 + 逐字贴帖共用）。 */
export function toolLabel(name: string): string {
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

// ============================================================
// AbortController + 挂钟超时（从 delegation.ts 原样抽出）
// ============================================================

export interface AbortWiring {
  ac: AbortController;
  /** 是否因挂钟超时而中止（区分「超时」与「上层取消」的收尾文案）。 */
  timedOut: () => boolean;
  /** 清理 timer + 移除上层 abort 监听器（每个 return 分支前调一次）。 */
  dispose: () => void;
}

/** 本次运行的 AbortController：上层 signal、挂钟超时任一触发都中止子进程与待处理的 Discord 交互。 */
export function wireAbort(upstream: AbortSignal, timeoutMs: number): AbortWiring {
  const ac = new AbortController();
  const onUpstreamAbort = (): void => ac.abort();
  if (upstream.aborted) ac.abort();
  else upstream.addEventListener('abort', onUpstreamAbort, { once: true });

  let timedOutFlag = false;
  const timer = setTimeout(() => {
    timedOutFlag = true;
    ac.abort();
  }, timeoutMs);

  return {
    ac,
    timedOut: () => timedOutFlag,
    dispose: () => {
      clearTimeout(timer);
      upstream.removeEventListener('abort', onUpstreamAbort);
    },
  };
}

// ============================================================
// query() options 组装（mode-agnostic）
// ============================================================

export interface BuildOptionsParams {
  cwd: string;
  abortController: AbortController;
  canUseTool: CanUseTool;
  maxTurns: number;
  /** 续接已存在的 Claude session（resume）；缺省=新会话。 */
  resumeSessionId?: string;
  /** stderr 前缀里的标识（bot 名等）。 */
  logTag: string;
}

/**
 * 组装 query() 的 Options。隔离 `settingSources:[]`（不继承本机 .claude 放行规则，权限完全由
 * canUseTool 决定）。⚠️ 绝不在此设 ANTHROPIC_API_KEY——直通/委派都走本机订阅（index.ts 首行已 delete）。
 */
export function buildClaudeOptions(p: BuildOptionsParams): Options {
  return {
    cwd: p.cwd,
    abortController: p.abortController,
    canUseTool: p.canUseTool,
    maxTurns: p.maxTurns,
    permissionMode: 'default',
    settingSources: [],
    stderr: (d) => process.stderr.write(`[claude:${p.logTag}] ${d}`),
    ...(p.resumeSessionId ? { resume: p.resumeSessionId } : {}),
  };
}

// ============================================================
// SDKMessage 流 → Sink（可插拔渲染器）
// ============================================================

export interface RateLimitInfo {
  status?: string;
  rateLimitType?: string;
  resetsAt?: number;
  isUsingOverage?: boolean;
  utilization?: number;
}

/** 渲染器接缝：所有回调都可异步、都可选；pumpQuery 按 SDKMessage 类型逐一回调。 */
export interface ClaudeStreamSink {
  /** system/init：拿到 sessionId。 */
  onInit?(sessionId: string): void | Promise<void>;
  /** 一条 assistant 消息：拼接文本 + 该消息的全部 tool_use（命令/入参原文）。 */
  onAssistant?(text: string, toolUses: ClaudeToolUse[]): void | Promise<void>;
  /** 一批 tool_result（来自 SDK 的 user 消息）：工具结果/文件 diff。 */
  onToolResult?(results: ClaudeToolResult[]): void | Promise<void>;
  /** 限流事件（rejected=真正被挡）。 */
  onRateLimit?(info: RateLimitInfo, rejected: boolean): void | Promise<void>;
  /** result：本次运行收尾（轮数/成本/是否出错/最终文本）。 */
  onResult?(meta: { numTurns?: number; costUsd?: number; isError: boolean; finalText: string }): void | Promise<void>;
}

export interface ClaudeRunResult {
  sessionId?: string;
  finalText: string;
  isError: boolean;
  numTurns?: number;
  costUsd?: number;
  rateLimited: boolean;
}

/**
 * 消费 query() 的 SDKMessage 异步流，按类型分发给 sink，返回收尾态。
 * 不吞异常——AbortController/超时由调用方经 try/catch 处理（见 runDelegation / handleThreadTurn）。
 */
export async function pumpQuery(
  messages: AsyncIterable<SDKMessage>,
  sink: ClaudeStreamSink,
  opts?: { logTag?: string }
): Promise<ClaudeRunResult> {
  const logTag = opts?.logTag ?? '?';
  let sessionId: string | undefined;
  let finalText = '';
  let isError = false;
  let numTurns: number | undefined;
  let costUsd: number | undefined;
  let rateLimited = false;

  for await (const message of messages) {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          sessionId = message.session_id;
          // apiKeySource 可确认走的是 oauth（订阅）而非 api key
          console.log(`[claude:${logTag}] init session=${sessionId} auth=${message.apiKeySource} model=${message.model}`);
          await sink.onInit?.(sessionId);
        }
        break;
      case 'assistant': {
        const { text, toolUses } = extractAssistant(message.message?.content);
        if (text) finalText = text; // 末次文本即最终回答
        await sink.onAssistant?.(text, toolUses);
        break;
      }
      case 'user': {
        const results = extractToolResults(message.message?.content);
        if (results.length) await sink.onToolResult?.(results);
        break;
      }
      case 'rate_limit_event': {
        // 该事件在「用量信息变化」时就会推送，多数 status 为 allowed（仅进度更新）。
        // 只有 rejected 才是真正被挡；allowed_warning 仅预警，不算限流。
        const info = message.rate_limit_info as RateLimitInfo | undefined;
        const rejected = info?.status === 'rejected';
        if (rejected) {
          rateLimited = true;
          console.warn(`[claude:${logTag}] 被限流 type=${info?.rateLimitType} resetsAt=${info?.resetsAt} overage=${info?.isUsingOverage}`);
        } else if (info?.status === 'allowed_warning') {
          console.warn(`[claude:${logTag}] 用量接近上限 type=${info?.rateLimitType} util=${info?.utilization}`);
        }
        await sink.onRateLimit?.(info ?? {}, rejected);
        break;
      }
      case 'result':
        numTurns = message.num_turns;
        costUsd = message.total_cost_usd;
        isError = message.is_error || message.subtype !== 'success';
        if (message.subtype === 'success' && typeof message.result === 'string') {
          finalText = message.result;
        }
        await sink.onResult?.({ numTurns, costUsd, isError, finalText });
        break;
      default:
        break;
    }
  }

  return { sessionId, finalText, isError, numTurns, costUsd, rateLimited };
}
