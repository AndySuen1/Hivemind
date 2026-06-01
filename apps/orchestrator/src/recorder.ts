// 可观测性唯一写入入口：脱敏 → 截断 8KB → 事务写库 → EventEmitter 广播。
//
// 设计契约（见 [[observability-feature]] 方案）：
//  · 所有埋点（bot-manager / llm.onStepFinish / delegation / permission-relay）只经此模块写库，
//    不直接碰 SQL —— 集中保证脱敏、截断、事务、广播一致。
//  · **绝不阻断主流程**：每个公开方法整体 try/catch，出错只 console.error 并返回兜底值
//    （空串 id / void）。失败的写入会让下游 id 为空，后续写因外键约束自然 fail-safe 丢弃。
//  · better-sqlite3 是同步 API，跑在 Discord 消息热路径上 —— 故用预编译语句缓存，避免每次 prepare。
//  · 广播供 P5 SSE 实时订阅；监听器异常被隔离，不影响写库。

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  ObservSession,
  ObservRun,
  ObservMessage,
  ObservEvent,
  ObservEventType,
  ObservRecord,
  ObservRunStatus,
  ObservMessageRole,
  ObservUsage,
} from '@discord-agent-hub/shared';
import { getDb } from './db.js';
import { redactText } from './redact.js';

// 单字段最大入库字节数（工具入参/出参、聊天内容）。Bash 命令通常远小于此，实际即“记全文”。
export const MAX_FIELD_BYTES = 8 * 1024;
// fs 写入内容只留预览（埋点处用 previewFsWrite 预裁，避免把整文件灌进库）。
export const FS_WRITE_PREVIEW_BYTES = 2 * 1024;
// 会话标题（取自用户首条消息）入库上限：是展示性短串，同样要脱敏（与 messages 正文一致）。
const MAX_TITLE_BYTES = 256;
// 脱敏前的硬封顶：超大字符串先粗裁到此，避免对几 MB 文本跑正则导致热路径卡顿。
const REDACT_PRECAP_BYTES = 256 * 1024;
const TRUNC_MARK = '…[截断]';

// ============================================================
// 截断 / 脱敏工具
// ============================================================

/** 按 UTF-8 字节截断，回退到不切断多字节字符的边界。 */
function byteTruncate(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return { text: s, truncated: false };
  let end = maxBytes;
  // UTF-8 续字节为 0b10xxxxxx（0x80–0xBF）；回退到前导字节边界，避免产生半个字符。
  while (end > 0) {
    const b = buf[end];
    if (b === undefined || (b & 0xc0) !== 0x80) break;
    end--;
  }
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

/** 文本字段：粗裁 → 脱敏 → 截断。 */
function redactTruncateText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const precap = byteTruncate(text, REDACT_PRECAP_BYTES);
  const redacted = redactText(precap.text);
  const fin = byteTruncate(redacted, maxBytes);
  const truncated = precap.truncated || fin.truncated;
  return { text: truncated ? fin.text + TRUNC_MARK : fin.text, truncated };
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * JSON 字段（工具入参/出参，可能是对象或字符串）序列化为入库字符串 + 广播用值。
 * 截断后的 JSON 多半不再是合法 JSON，故广播 emit 用「能解析则解析、否则原字符串」。
 */
function serializeField(
  value: unknown,
  maxBytes: number
): { json: string | null; emit: unknown } {
  if (value === undefined || value === null) return { json: null, emit: undefined };
  let raw: string;
  if (typeof value === 'string') raw = value;
  else {
    try {
      raw = JSON.stringify(value) ?? String(value);
    } catch {
      raw = String(value);
    }
  }
  const { text } = redactTruncateText(raw, maxBytes);
  return { json: text, emit: tryParse(text) };
}

/** 埋点处用：把 fs 写入内容裁成 ~2KB 预览（脱敏 + 截断）。 */
export function previewFsWrite(content: string): { text: string; truncated: boolean } {
  return redactTruncateText(content, FS_WRITE_PREVIEW_BYTES);
}

// ============================================================
// 调用方传入的参数形状（recorder 内部契约，非跨包类型）
// ============================================================

export interface EnsureSessionInput {
  botId: string;
  channelId: string;
  channelType?: string;
  channelName?: string;
  guildId?: string;
  title?: string;
}

export interface StartRunInput {
  sessionId: string;
  botId: string;
  requesterId?: string;
  userMessageId?: string;
}

export interface EndRunPatch {
  status: ObservRunStatus;
  finishReason?: string;
  toolCallCount?: number;
  usage?: unknown;
  error?: string;
}

export interface RecordMessageInput {
  sessionId: string;
  runId?: string;
  botId: string;
  role: ObservMessageRole;
  content: string;
  authorId?: string;
  authorName?: string;
}

export interface RecordEventInput {
  runId: string;
  sessionId: string;
  botId: string;
  type: ObservEventType;
  toolName?: string;
  label?: string;
  status?: string;
  input?: unknown;
  output?: unknown;
  durationMs?: number;
  parentEventId?: string;
}

// ============================================================
// DB 行 → 广播类型 的映射（仅 runs 需要回读，其余在写入时即有全字段）
// ============================================================

interface RunRow {
  id: string;
  session_id: string;
  bot_id: string;
  requester_id: string | null;
  status: string;
  user_message_id: string | null;
  finish_reason: string | null;
  tool_call_count: number;
  usage_json: string | null;
  error: string | null;
  started_at: number;
  ended_at: number | null;
}

function rowToRun(r: RunRow): ObservRun {
  return {
    id: r.id,
    sessionId: r.session_id,
    botId: r.bot_id,
    requesterId: r.requester_id ?? undefined,
    status: r.status as ObservRunStatus,
    userMessageId: r.user_message_id ?? undefined,
    finishReason: r.finish_reason ?? undefined,
    toolCallCount: r.tool_call_count,
    usage: r.usage_json ? (tryParse(r.usage_json) as ObservUsage | undefined) : undefined,
    error: r.error ?? undefined,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? undefined,
  };
}

// ============================================================
// 预编译语句缓存（initDb 之后惰性构建；tsx watch 重启会整进程重置，不存在绑到已关闭 DB 的问题）
// ============================================================

function buildStmts(db: ReturnType<typeof getDb>) {
  return {
    getSession: db.prepare('SELECT id FROM sessions WHERE bot_id = ? AND channel_id = ?'),
    insertSession: db.prepare(
      `INSERT INTO sessions (id, bot_id, channel_id, channel_type, channel_name, guild_id, title, created_at, last_active_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    touchSession: db.prepare(
      `UPDATE sessions
          SET last_active_at = ?,
              channel_name = COALESCE(?, channel_name),
              channel_type = COALESCE(?, channel_type),
              guild_id     = COALESCE(?, guild_id)
        WHERE id = ?`
    ),
    insertRun: db.prepare(
      `INSERT INTO runs (id, session_id, bot_id, requester_id, status, user_message_id, finish_reason, tool_call_count, usage_json, error, started_at, ended_at)
       VALUES (?, ?, ?, ?, 'running', ?, NULL, 0, NULL, NULL, ?, NULL)`
    ),
    endRun: db.prepare(
      `UPDATE runs
          SET status = ?,
              finish_reason   = COALESCE(?, finish_reason),
              tool_call_count = COALESCE(?, tool_call_count),
              usage_json      = COALESCE(?, usage_json),
              error           = COALESCE(?, error),
              ended_at        = ?
        WHERE id = ?`
    ),
    getRun: db.prepare('SELECT * FROM runs WHERE id = ?'),
    insertMessage: db.prepare(
      `INSERT INTO messages (id, session_id, run_id, bot_id, role, author_id, author_name, content, truncated, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    maxSeq: db.prepare('SELECT MAX(seq) AS m FROM events WHERE run_id = ?'),
    insertEvent: db.prepare(
      `INSERT INTO events (id, run_id, session_id, bot_id, seq, type, tool_name, label, status, input_json, output_json, duration_ms, parent_event_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
  };
}

// ============================================================
// Recorder
// ============================================================

class Recorder {
  /** 广播总线：emit('record', ObservRecord)。P5 SSE 订阅后按 kind/botId/sessionId/runId 过滤。 */
  readonly bus = new EventEmitter();

  private _stmts: ReturnType<typeof buildStmts> | null = null;
  // 每个 run 的 seq 计数器（单线程同步写，无竞态）；run 结束即清除，避免无界增长。
  private seqCounters = new Map<string, number>();

  constructor() {
    // SSE 客户端可能很多，关掉「监听器过多」告警。
    this.bus.setMaxListeners(0);
  }

  private stmts(): ReturnType<typeof buildStmts> {
    if (!this._stmts) this._stmts = buildStmts(getDb());
    return this._stmts;
  }

  /** 包裹所有公开写入：异常只记录、不外抛，返回兜底值。 */
  private safe<T>(label: string, fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (e) {
      console.error(`[recorder] ${label} 失败（已忽略，不影响主流程）:`, e);
      return fallback;
    }
  }

  private broadcast(record: ObservRecord): void {
    try {
      this.bus.emit('record', record);
    } catch (e) {
      console.error('[recorder] 广播监听器异常（已隔离）:', e);
    }
  }

  // 计算下一个 seq 但**不**提交计数器——写库成功后才由 recordEvent 调 seqCounters.set。
  // 否则写库失败（被 safe 吞掉）却已推进计数器，下一条事件会跳号、在时间线里留下空洞。
  private peekSeq(runId: string): number {
    let cur = this.seqCounters.get(runId);
    if (cur === undefined) {
      const row = this.stmts().maxSeq.get(runId) as { m: number | null } | undefined;
      cur = row?.m ?? 0;
    }
    return cur + 1;
  }

  /** upsert 会话（按 bot_id+channel_id 唯一）。返回 sessionId；失败返回空串。 */
  ensureSession(input: EnsureSessionInput): string {
    const now = Date.now();
    return this.safe(
      'ensureSession',
      () => {
        const s = this.stmts();
        const existing = s.getSession.get(input.botId, input.channelId) as { id: string } | undefined;
        if (existing) {
          s.touchSession.run(
            now,
            input.channelName ?? null,
            input.channelType ?? null,
            input.guildId ?? null,
            existing.id
          );
          // 仅更新 last_active_at，刻意不广播——否则每条消息都推一次 session 行很吵。
          // P5 SSE 若需「按活跃排序」，由 run/message/event 流驱动，或届时另设节流的 session 推送。
          return existing.id;
        }
        const id = randomUUID();
        // title 源自用户首条消息，可能含密钥 → 与 messages 正文一样脱敏截断，避免明文落库/经 SSE 外泄。
        const title = input.title ? redactTruncateText(input.title, MAX_TITLE_BYTES).text : null;
        s.insertSession.run(
          id,
          input.botId,
          input.channelId,
          input.channelType ?? null,
          input.channelName ?? null,
          input.guildId ?? null,
          title,
          now,
          now
        );
        const row: ObservSession = {
          id,
          botId: input.botId,
          channelId: input.channelId,
          channelType: input.channelType,
          channelName: input.channelName,
          guildId: input.guildId,
          title: title ?? undefined,
          createdAt: now,
          lastActiveAt: now,
        };
        this.broadcast({ kind: 'session', row });
        return id;
      },
      ''
    );
  }

  /** 开一回合（status=running）。返回 runId；失败返回空串。 */
  startRun(input: StartRunInput): string {
    if (!input.sessionId) return ''; // 上游 ensureSession 已失败：runs.session_id 有外键，插必失败
    const now = Date.now();
    return this.safe(
      'startRun',
      () => {
        const id = randomUUID();
        this.stmts().insertRun.run(
          id,
          input.sessionId,
          input.botId,
          input.requesterId ?? null,
          input.userMessageId ?? null,
          now
        );
        const row: ObservRun = {
          id,
          sessionId: input.sessionId,
          botId: input.botId,
          requesterId: input.requesterId,
          status: 'running',
          userMessageId: input.userMessageId,
          toolCallCount: 0,
          startedAt: now,
        };
        this.broadcast({ kind: 'run', row });
        return id;
      },
      ''
    );
  }

  /** 收尾一回合，并广播更新后的整行。 */
  endRun(runId: string, patch: EndRunPatch): void {
    if (!runId) return;
    this.safe(
      'endRun',
      () => {
        const s = this.stmts();
        s.endRun.run(
          patch.status,
          patch.finishReason ?? null,
          patch.toolCallCount ?? null,
          patch.usage !== undefined ? serializeField(patch.usage, MAX_FIELD_BYTES).json : null,
          patch.error ?? null,
          Date.now(),
          runId
        );
        const row = s.getRun.get(runId) as RunRow | undefined;
        if (row) this.broadcast({ kind: 'run', row: rowToRun(row) });
      },
      undefined
    );
    // 不论成败都清计数器：回合结束后不应再有事件。
    this.seqCounters.delete(runId);
  }

  /** 记一条聊天消息（user/assistant）。返回消息 id；失败返回空串。 */
  recordMessage(input: RecordMessageInput): string {
    if (!input.sessionId) return ''; // messages.session_id 有外键，sessionId 为空插必失败
    const now = Date.now();
    return this.safe(
      'recordMessage',
      () => {
        const { text, truncated } = redactTruncateText(input.content, MAX_FIELD_BYTES);
        const id = randomUUID();
        this.stmts().insertMessage.run(
          id,
          input.sessionId,
          input.runId ?? null,
          input.botId,
          input.role,
          input.authorId ?? null,
          input.authorName ?? null,
          text,
          truncated ? 1 : 0,
          now
        );
        const row: ObservMessage = {
          id,
          sessionId: input.sessionId,
          runId: input.runId,
          botId: input.botId,
          role: input.role,
          authorId: input.authorId,
          authorName: input.authorName,
          content: text,
          truncated,
          createdAt: now,
        };
        this.broadcast({ kind: 'message', row });
        return id;
      },
      ''
    );
  }

  /** 记一条时间线事件（seq 在回合内自增）。返回事件 id；失败返回空串。 */
  recordEvent(input: RecordEventInput): string {
    // runId 为空（上游 startRun 已失败）直接放弃：events.run_id 有外键，插必失败被吞；
    // 早返回顺带避免把空串塞进 seqCounters，免去无谓日志与残留 key。
    if (!input.runId) return '';
    const now = Date.now();
    return this.safe(
      'recordEvent',
      () => {
        const seq = this.peekSeq(input.runId);
        const inputField = serializeField(input.input, MAX_FIELD_BYTES);
        const outputField = serializeField(input.output, MAX_FIELD_BYTES);
        const id = randomUUID();
        this.stmts().insertEvent.run(
          id,
          input.runId,
          input.sessionId,
          input.botId,
          seq,
          input.type,
          input.toolName ?? null,
          input.label ?? null,
          input.status ?? null,
          inputField.json,
          outputField.json,
          input.durationMs ?? null,
          input.parentEventId ?? null,
          now
        );
        // 写库成功后才提交计数器（见 peekSeq 注释）。
        this.seqCounters.set(input.runId, seq);
        const row: ObservEvent = {
          id,
          runId: input.runId,
          sessionId: input.sessionId,
          botId: input.botId,
          seq,
          type: input.type,
          toolName: input.toolName,
          label: input.label,
          status: input.status,
          input: inputField.emit,
          output: outputField.emit,
          durationMs: input.durationMs,
          parentEventId: input.parentEventId,
          createdAt: now,
        };
        this.broadcast({ kind: 'event', row });
        return id;
      },
      ''
    );
  }

  /** 订阅广播，返回取消订阅函数（P5 SSE 用）。 */
  onRecord(listener: (record: ObservRecord) => void): () => void {
    this.bus.on('record', listener);
    return () => this.bus.off('record', listener);
  }
}

export const recorder = new Recorder();
