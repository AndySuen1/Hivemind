// 可观测性查询仓（P4，只读）：会话/回合/消息/事件的游标分页 + 记忆浏览 + Live 聚合。
// 写入仍只经 recorder.ts；这里只读。沿用 repos.ts 的「行类型 + rowToX 映射 + 仓对象」范式。

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ObservSession,
  ObservRun,
  ObservMessage,
  ObservEvent,
  ObservEventType,
  ObservRunStatus,
  ObservMessageRole,
  ObservUsage,
  ObservPage,
  ObservCursor,
  ObservMemoryEntry,
  ObservMemoryList,
} from '@discord-agent-hub/shared';
import { getDb } from './db.js';
import { getBotMemoryDir } from './tools/index.js';
import { listMemoryEntries, loadMemoryIndexText } from './tools/memory.js';
import { assertRealpathAllowed } from './tools/path-guard.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(n: number | undefined, def = DEFAULT_LIMIT): number {
  if (n == null || !Number.isFinite(n)) return def;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}

function tryParse(s: string | null): unknown {
  if (s == null) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// sessions/runs/messages 用 (时间戳, id) 复合游标 + 严格不等的元组比较（见各 list 函数），
// 杜绝「同一毫秒多条记录跨翻页边界漏返回」。events 用 seq（回合内唯一）单值游标即可。
/** 多取一条判断是否还有下一页：超出则截断并以末项游标作为 nextCursor。 */
function paginate<T, C>(rows: T[], limit: number, cursorOf: (t: T) => C): ObservPage<T, C> {
  if (rows.length > limit) {
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { items, nextCursor: last !== undefined ? cursorOf(last) : null };
  }
  return { items: rows, nextCursor: null };
}

// ============================================================
// 行映射
// ============================================================

interface SessionRow {
  id: string; bot_id: string; channel_id: string; channel_type: string | null;
  channel_name: string | null; guild_id: string | null; title: string | null;
  created_at: number; last_active_at: number;
}
const rowToSession = (r: SessionRow): ObservSession => ({
  id: r.id, botId: r.bot_id, channelId: r.channel_id,
  channelType: r.channel_type ?? undefined, channelName: r.channel_name ?? undefined,
  guildId: r.guild_id ?? undefined, title: r.title ?? undefined,
  createdAt: r.created_at, lastActiveAt: r.last_active_at,
});

interface RunRow {
  id: string; session_id: string; bot_id: string; requester_id: string | null;
  status: string; user_message_id: string | null; finish_reason: string | null;
  tool_call_count: number; usage_json: string | null; error: string | null;
  started_at: number; ended_at: number | null;
}
const rowToRun = (r: RunRow): ObservRun => ({
  id: r.id, sessionId: r.session_id, botId: r.bot_id, requesterId: r.requester_id ?? undefined,
  status: r.status as ObservRunStatus, userMessageId: r.user_message_id ?? undefined,
  finishReason: r.finish_reason ?? undefined, toolCallCount: r.tool_call_count,
  usage: r.usage_json ? (tryParse(r.usage_json) as ObservUsage | undefined) : undefined,
  error: r.error ?? undefined, startedAt: r.started_at, endedAt: r.ended_at ?? undefined,
});

interface MessageRow {
  id: string; session_id: string; run_id: string | null; bot_id: string;
  role: string; author_id: string | null; author_name: string | null;
  content: string; truncated: number; created_at: number;
}
const rowToMessage = (r: MessageRow): ObservMessage => ({
  id: r.id, sessionId: r.session_id, runId: r.run_id ?? undefined, botId: r.bot_id,
  role: r.role as ObservMessageRole, authorId: r.author_id ?? undefined,
  authorName: r.author_name ?? undefined, content: r.content,
  truncated: r.truncated === 1, createdAt: r.created_at,
});

interface EventRow {
  id: string; run_id: string; session_id: string; bot_id: string; seq: number;
  type: string; tool_name: string | null; label: string | null; status: string | null;
  input_json: string | null; output_json: string | null; duration_ms: number | null;
  parent_event_id: string | null; created_at: number;
}
const rowToEvent = (r: EventRow): ObservEvent => ({
  id: r.id, runId: r.run_id, sessionId: r.session_id, botId: r.bot_id, seq: r.seq,
  type: r.type as ObservEventType, toolName: r.tool_name ?? undefined, label: r.label ?? undefined,
  status: r.status ?? undefined, input: tryParse(r.input_json), output: tryParse(r.output_json),
  durationMs: r.duration_ms ?? undefined, parentEventId: r.parent_event_id ?? undefined,
  createdAt: r.created_at,
});

// ============================================================
// 查询仓
// ============================================================

export const observRepo = {
  /** 某 bot 的会话列表，按最近活跃倒序；游标 = (last_active_at, id)（before/beforeId）。 */
  listSessions(botId: string, opts: { before?: number; beforeId?: string; limit?: number } = {}): ObservPage<ObservSession, ObservCursor> {
    const limit = clampLimit(opts.limit);
    const db = getDb();
    const rows = (
      opts.before == null
        ? db.prepare('SELECT * FROM sessions WHERE bot_id = ? ORDER BY last_active_at DESC, id DESC LIMIT ?').all(botId, limit + 1)
        : db.prepare('SELECT * FROM sessions WHERE bot_id = ? AND (last_active_at < ? OR (last_active_at = ? AND id < ?)) ORDER BY last_active_at DESC, id DESC LIMIT ?').all(botId, opts.before, opts.before, opts.beforeId ?? '', limit + 1)
    ) as SessionRow[];
    return paginate(rows.map(rowToSession), limit, (s) => ({ ts: s.lastActiveAt, id: s.id }));
  },

  /** 某会话的回合列表，按开始时间倒序；游标 = (started_at, id)（before/beforeId）。 */
  listRuns(sessionId: string, opts: { before?: number; beforeId?: string; limit?: number } = {}): ObservPage<ObservRun, ObservCursor> {
    const limit = clampLimit(opts.limit);
    const db = getDb();
    const rows = (
      opts.before == null
        ? db.prepare('SELECT * FROM runs WHERE session_id = ? ORDER BY started_at DESC, id DESC LIMIT ?').all(sessionId, limit + 1)
        : db.prepare('SELECT * FROM runs WHERE session_id = ? AND (started_at < ? OR (started_at = ? AND id < ?)) ORDER BY started_at DESC, id DESC LIMIT ?').all(sessionId, opts.before, opts.before, opts.beforeId ?? '', limit + 1)
    ) as RunRow[];
    return paginate(rows.map(rowToRun), limit, (r) => ({ ts: r.startedAt, id: r.id }));
  },

  /** 某会话的消息列表，按创建时间倒序；游标 = (created_at, id)（before/beforeId）。 */
  listMessages(sessionId: string, opts: { before?: number; beforeId?: string; limit?: number } = {}): ObservPage<ObservMessage, ObservCursor> {
    const limit = clampLimit(opts.limit);
    const db = getDb();
    const rows = (
      opts.before == null
        ? db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(sessionId, limit + 1)
        : db.prepare('SELECT * FROM messages WHERE session_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?').all(sessionId, opts.before, opts.before, opts.beforeId ?? '', limit + 1)
    ) as MessageRow[];
    return paginate(rows.map(rowToMessage), limit, (m) => ({ ts: m.createdAt, id: m.id }));
  },

  /** 某回合的事件时间线，按 seq 升序（时间顺序）；after = seq 游标。 */
  listEvents(runId: string, opts: { after?: number; limit?: number } = {}): ObservPage<ObservEvent> {
    const limit = clampLimit(opts.limit, MAX_LIMIT);
    const db = getDb();
    const rows = (
      opts.after == null
        ? db.prepare('SELECT * FROM events WHERE run_id = ? ORDER BY seq ASC LIMIT ?').all(runId, limit + 1)
        : db.prepare('SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?').all(runId, opts.after, limit + 1)
    ) as EventRow[];
    return paginate(rows.map(rowToEvent), limit, (e) => e.seq);
  },

  /** 记忆浏览（只读）：列出某 bot 的记忆条目 + MEMORY.md 索引原文。 */
  memoryList(botId: string): ObservMemoryList {
    const dir = getBotMemoryDir(botId);
    const memories: ObservMemoryEntry[] = listMemoryEntries(dir);
    return { dir, indexText: loadMemoryIndexText(dir), memories };
  },

  /**
   * 读取某 bot 的单个记忆文件内容。fileName 必须是该目录下的裸 .md 文件名（无路径分隔/..），
   * 再经 path-guard 的 realpath 校验（防 junction 逃逸）。不合法/不存在返回 null。
   */
  memoryFile(botId: string, fileName: string): string | null {
    if (!/^[^/\\]+\.md$/.test(fileName) || fileName.includes('..')) return null;
    const dir = getBotMemoryDir(botId);
    const abs = join(dir, fileName);
    if (!existsSync(abs)) return null;
    try {
      assertRealpathAllowed(abs, [dir]);
    } catch {
      return null;
    }
    return readFileSync(abs, 'utf-8');
  },

  /** Live 总览的 DB 聚合：每个 bot 的会话数/回合数/在跑回合数/最近活跃。运行时状态由调用方合并。 */
  liveAggregates(): Map<string, { sessions: number; runs: number; runningRuns: number; lastActiveAt: number | null }> {
    const db = getDb();
    const out = new Map<string, { sessions: number; runs: number; runningRuns: number; lastActiveAt: number | null }>();
    const get = (botId: string) => {
      let v = out.get(botId);
      if (!v) {
        v = { sessions: 0, runs: 0, runningRuns: 0, lastActiveAt: null };
        out.set(botId, v);
      }
      return v;
    };
    const sessRows = db.prepare('SELECT bot_id, COUNT(*) AS c, MAX(last_active_at) AS la FROM sessions GROUP BY bot_id').all() as { bot_id: string; c: number; la: number | null }[];
    for (const r of sessRows) {
      const v = get(r.bot_id);
      v.sessions = r.c;
      v.lastActiveAt = r.la;
    }
    const runRows = db.prepare("SELECT bot_id, COUNT(*) AS c, SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running FROM runs GROUP BY bot_id").all() as { bot_id: string; c: number; running: number }[];
    for (const r of runRows) {
      const v = get(r.bot_id);
      v.runs = r.c;
      v.runningRuns = r.running;
    }
    return out;
  },
};
