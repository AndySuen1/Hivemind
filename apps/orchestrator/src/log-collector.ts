// 可视化日志系统的采集核心（与 recorder.ts 的结构化业务事件正交：这里采「原始运行日志」）。
//
// 设计契约：
//  · **唯一采集入口 = patch process.stdout/stderr.write**（字节流层拦一次即覆盖所有 console.* /
//    第三方库 / delegation 对 claude 子进程的 process.stderr.write 直写）。不 patch console.*，
//    避免与底层 stream.write 双记。注：Fastify 的 pino 默认经 SonicBoom 直写 fd（绕过 process.stdout），
//    故 HTTP 请求日志一般不入此通道——这正好少了噪音；业务全靠 console.*（必经 stream.write）。
//  · **环形缓冲是同步事实源，DB 是异步批量旁路**：record() 只做脱敏+截断→push 环形→广播→入 pending；
//    落盘走 db.transaction() 批量（满 FLUSH_BATCH 或 FLUSH_INTERVAL_MS 节流），失败丢这批不重试。
//    **绝不在 Discord 热路径（任何 console.log 的调用栈）上同步 INSERT**。
//  · **铁律：本模块任何代码禁用 console.\***（否则被自己的 patch 捕获 → 又广播 → 无限递归放大）。
//    内部错误只写 _lastError（经 stats() / api-logs 自检），三重防护：禁 console + writing 再入 guard +
//    patch 里「先 orig 透传后 feed」。
//  · 脱敏（redactText）+ 截断在 record() 入口做一次，环形/DB/SSE 拿同一份已处理 entry（绝不广播原文）。

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type DatabaseType from 'better-sqlite3';
import type { LogEntry, LogLevel, LogSource, LogPage, LogIngestPayload, LogCursor } from '@hivemind/shared';
import type { DB } from './db.js';
import { redactText } from './redact.js';

const RING_CAP = 2000; // 内存环形缓冲容量（最近 N 条，供快速 list + 去重窗口 + DB ready 前暂存）
const PENDING_CAP = 5000; // 待落盘队列上限（DB 未就绪或落盘卡住时丢最旧，绝不无界增长 → OOM）
const FLUSH_BATCH = 200; // 满此条数立即落盘
const FLUSH_INTERVAL_MS = 250; // 否则节流批量落盘
const MAX_MSG_CHARS = 8192; // 单条消息字符上限（与 recorder 的 8KB 约束量级一致）
const MAX_PARTIAL = 64 * 1024; // 单行未见换行的强制 flush 阈值，防无界行缓冲
const DEDUP_WINDOW_MS = 15_000; // ingest 去重时间窗
const DEDUP_SCAN = 1000; // ingest 去重最多回扫的环形条数

type StreamName = 'out' | 'err';

// ============================================================
// 行解析：从一行文本推断 level / tag / 友好 message（自捕获与 ingest 共用，保证去重一致）
// ============================================================
function parseLine(rawLine: string, stream: StreamName): { level: LogLevel; tag?: string; message: string } {
  const trimmed = rawLine.trimStart();
  // pino JSON 行（万一有 pino 输出经由 stdout）：抽 level + msg，避免一坨 JSON 噪音。
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      if (o && typeof o.level === 'number') {
        const lv = o.level as number;
        const level: LogLevel = lv >= 50 ? 'error' : lv >= 40 ? 'warn' : lv >= 20 ? 'info' : 'debug';
        let msg = typeof o.msg === 'string' ? o.msg : rawLine;
        const req = o.req as { method?: string; url?: string } | undefined;
        const res = o.res as { statusCode?: number } | undefined;
        if (req && typeof req === 'object') msg = `${req.method ?? ''} ${req.url ?? ''} ${msg}`.trim();
        else if (res && typeof res === 'object') msg = `${msg} ${res.statusCode ?? ''}`.trim();
        return { level, tag: 'http', message: msg };
      }
    } catch {
      /* 非 pino JSON，按普通行处理 */
    }
  }
  // 行首 `[bot:Name]` / `[boot]` / `[pm]` / `[recorder]` 等前缀 → tag。
  let tag: string | undefined;
  const m = /^\[([^\]]{1,40})\]/.exec(rawLine);
  if (m) tag = m[1];
  let level: LogLevel;
  // 关键词命中（含本仓库中文错误措辞：console.error 多打印「未捕获异常」「失败」等而非 "error"）。
  if (/(\berror\b|\bfatal\b|\bfail(?:ed|ure)?\b|exception|unhandledrejection|错误|异常|崩溃|失败|✗)/i.test(rawLine)) level = 'error';
  else if (/(\bwarn(?:ing)?\b|警告|⚠)/i.test(rawLine)) level = 'warn';
  else level = stream === 'err' ? 'warn' : 'info'; // stderr 默认 warn（pino/dotenv 也走 stderr 但非错误）
  return { level, tag, message: rawLine };
}

interface LogRow {
  id: string;
  seq: number;
  ts: number;
  source: string;
  level: string;
  tag: string | null;
  message: string;
}

function rowToEntry(r: LogRow): LogEntry {
  return {
    id: r.id,
    seq: r.seq,
    ts: r.ts,
    source: r.source as LogSource,
    level: r.level as LogLevel,
    tag: r.tag ?? undefined,
    message: r.message,
  };
}

export interface LogListOptions {
  before?: number;
  beforeId?: string;
  limit?: number;
  level?: LogLevel;
  source?: LogSource;
  q?: string;
}

// ============================================================
// LogCollector
// ============================================================
class LogCollector {
  /** 广播总线：emit('log', LogEntry)。/api/logs/stream 订阅后按 level/source/q 过滤。 */
  readonly bus = new EventEmitter();

  private installed = false;
  private writing = false; // 再入 guard：feed 期间任何 stream 写都不再二次记录
  private readonly orig: Partial<Record<StreamName, NodeJS.WriteStream['write']>> = {};
  private readonly lineBuf: Record<StreamName, string> = { out: '', err: '' };

  private ring: LogEntry[] = [];
  private pending: LogEntry[] = [];
  private seq = 0;

  private db: DB | null = null;
  private insertStmt: DatabaseType.Statement | null = null;
  private flushTimer: NodeJS.Timeout | null = null;

  // 自检计数（绝不 console，经 stats() 暴露）
  private persisted = 0;
  private dropped = 0;
  private _lastError: string | undefined;

  constructor() {
    this.bus.setMaxListeners(0); // SSE 客户端可能很多
  }

  // ---------- 安装：patch 字节流（幂等） ----------
  install(): void {
    if (this.installed) return;
    this.installed = true;
    this.patch(process.stdout as NodeJS.WriteStream, 'out');
    this.patch(process.stderr as NodeJS.WriteStream, 'err');
  }

  private patch(stream: NodeJS.WriteStream, name: StreamName): void {
    const orig = stream.write.bind(stream) as NodeJS.WriteStream['write'];
    this.orig[name] = orig;
    const self = this;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stream.write = function (this: unknown, ...args: any[]): boolean {
      // ① 始终先原样透传（launcher 透传 + 终端不断流），保留 write 返回值语义（背压）。
      const ret = (orig as (...a: any[]) => boolean)(...args);
      // ② 再入 guard + 整体吞错：记录路径绝不抛、绝不 console。
      if (!self.writing) {
        self.writing = true;
        try {
          self.feed(name, args[0]);
        } catch (e) {
          self._lastError = String(e);
        } finally {
          self.writing = false;
        }
      }
      return ret;
    } as NodeJS.WriteStream['write'];
  }

  // ---------- 行缓冲 + 按行记录 ----------
  private feed(name: StreamName, chunk: unknown): void {
    const text = this.lineBuf[name] + (typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    const parts = text.split(/\r?\n/);
    this.lineBuf[name] = parts.pop() ?? '';
    // 超长未完成行强制 flush，防无界缓冲。
    if (this.lineBuf[name].length > MAX_PARTIAL) {
      this.recordLine(this.lineBuf[name], name);
      this.lineBuf[name] = '';
    }
    for (const line of parts) {
      if (line.length > 0) this.recordLine(line, name);
    }
  }

  private recordLine(line: string, stream: StreamName): void {
    const { level, tag, message } = parseLine(line, stream);
    this.record('orchestrator', level, tag, message, Date.now());
  }

  // ---------- 记录一条（脱敏+截断 → 环形 → 广播 → pending） ----------
  private record(source: LogSource, level: LogLevel, tag: string | undefined, message: string, ts: number): LogEntry | null {
    try {
      const clean = this.clip(redactText(message));
      const entry: LogEntry = { id: randomUUID(), seq: ++this.seq, ts, source, level, message: clean };
      if (tag) entry.tag = tag;

      this.ring.push(entry);
      if (this.ring.length > RING_CAP) this.ring.splice(0, this.ring.length - RING_CAP);

      this.broadcast(entry);

      this.pending.push(entry);
      if (this.pending.length > PENDING_CAP) {
        const over = this.pending.length - PENDING_CAP;
        this.pending.splice(0, over); // 丢最旧，绝不无界
        this.dropped += over;
      }
      if (this.db) {
        if (this.pending.length >= FLUSH_BATCH) this.flush();
        else this.scheduleFlush();
      }
      return entry;
    } catch (e) {
      this._lastError = String(e);
      this.dropped++;
      return null;
    }
  }

  private clip(s: string): string {
    return s.length <= MAX_MSG_CHARS ? s : s.slice(0, MAX_MSG_CHARS) + '…[截断]';
  }

  private broadcast(entry: LogEntry): void {
    try {
      this.bus.emit('log', entry);
    } catch (e) {
      this._lastError = String(e); // 监听器异常隔离，绝不 console
    }
  }

  // ---------- DB 就绪：建预编译语句 + flush 早期 boot 日志 ----------
  initStore(db: DB): void {
    try {
      this.db = db;
      this.insertStmt = db.prepare(
        'INSERT INTO logs (id, seq, ts, source, level, tag, message) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      this.flush(); // 落 DB ready 前积累的 pending（install→initDb 窗口的早期日志）
    } catch (e) {
      this._lastError = String(e);
    }
  }

  flush(): void {
    if (!this.db || !this.insertStmt || this.pending.length === 0) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const batch = this.pending;
    this.pending = [];
    try {
      const stmt = this.insertStmt;
      this.db.transaction(() => {
        for (const e of batch) stmt.run(e.id, e.seq, e.ts, e.source, e.level, e.tag ?? null, e.message);
      })();
      this.persisted += batch.length;
    } catch (e) {
      this._lastError = String(e);
      this.dropped += batch.length; // 丢这批不重试（日志可丢，绝不堆积成 OOM）
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
  }

  // ---------- launcher 转发入口（再脱敏 + 重分配本地 seq + orchestrator 行去重） ----------
  ingest(payload: LogIngestPayload): number {
    let accepted = 0;
    for (const e of payload.entries) {
      try {
        const parsed = parseLine(e.message, e.stream === 'err' ? 'err' : 'out');
        const clean = this.clip(redactText(parsed.message));
        // orchestrator 自捕获的行 launcher 也会转发一份 → 近窗口去重（仅 source='orchestrator'）。
        // dashboard/launcher 来源 orchestrator 不自捕获，不去重。
        if (e.source === 'orchestrator' && this.recentlySeen('orchestrator', clean, e.ts)) continue;
        // record 内部会再 redactText（幂等）+ clip（幂等），得到与 clean 一致的入库文本。
        this.record(e.source, parsed.level, parsed.tag, parsed.message, e.ts);
        accepted++;
      } catch (err) {
        this._lastError = String(err);
      }
    }
    return accepted;
  }

  private recentlySeen(source: LogSource, cleanMsg: string, ts: number): boolean {
    const start = Math.max(0, this.ring.length - DEDUP_SCAN);
    for (let i = this.ring.length - 1; i >= start; i--) {
      const e = this.ring[i]!;
      if (e.source === source && e.message === cleanMsg && Math.abs(ts - e.ts) <= DEDUP_WINDOW_MS) return true;
    }
    return false;
  }

  // ---------- 查询（游标分页 + level/source/q 过滤） ----------
  list(opts: LogListOptions = {}): LogPage {
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 100), 1), 500);
    if (!this.db) return this.listFromRing(opts, limit);
    try {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.level) {
        where.push('level = ?');
        params.push(opts.level);
      }
      if (opts.source) {
        where.push('source = ?');
        params.push(opts.source);
      }
      if (opts.q) {
        where.push("instr(lower(message || ' ' || COALESCE(tag, '')), lower(?)) > 0");
        params.push(opts.q);
      }
      if (opts.before != null && opts.beforeId) {
        where.push('(ts < ? OR (ts = ? AND id < ?))');
        params.push(opts.before, opts.before, opts.beforeId);
      }
      const sql = `SELECT id, seq, ts, source, level, tag, message FROM logs ${
        where.length ? 'WHERE ' + where.join(' AND ') : ''
      } ORDER BY ts DESC, id DESC LIMIT ?`;
      params.push(limit);
      const rows = this.db.prepare(sql).all(...params) as LogRow[];
      const items = rows.map(rowToEntry);
      const nextCursor: LogCursor | null =
        items.length === limit ? { ts: items[items.length - 1]!.ts, id: items[items.length - 1]!.id } : null;
      return { items, nextCursor };
    } catch (e) {
      this._lastError = String(e);
      return { items: [], nextCursor: null };
    }
  }

  /** DB 未就绪时的兜底：从环形缓冲过滤（仅服务首屏，实际 API 启动时 DB 必已就绪）。 */
  private listFromRing(opts: LogListOptions, limit: number): LogPage {
    const qLower = opts.q?.toLowerCase();
    let arr = this.ring.filter((e) => {
      if (opts.level && e.level !== opts.level) return false;
      if (opts.source && e.source !== opts.source) return false;
      if (qLower && !(e.message + ' ' + (e.tag ?? '')).toLowerCase().includes(qLower)) return false;
      if (opts.before != null && opts.beforeId) {
        if (!(e.ts < opts.before || (e.ts === opts.before && e.id < opts.beforeId))) return false;
      }
      return true;
    });
    arr = arr.sort((a, b) => (b.ts - a.ts) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).slice(0, limit);
    const nextCursor: LogCursor | null =
      arr.length === limit ? { ts: arr[arr.length - 1]!.ts, id: arr[arr.length - 1]!.id } : null;
    return { items: arr, nextCursor };
  }

  /** 清空全部日志（DB + 环形 + pending）。 */
  clear(): void {
    this.ring = [];
    this.pending = [];
    try {
      this.db?.prepare('DELETE FROM logs').run();
    } catch (e) {
      this._lastError = String(e);
    }
  }

  /** 订阅广播，返回取消订阅函数（/api/logs/stream 用）。 */
  onLog(listener: (entry: LogEntry) => void): () => void {
    this.bus.on('log', listener);
    return () => this.bus.off('log', listener);
  }

  /** 自检（经 /api/health 附带或排障用），绝不 console。 */
  stats(): {
    installed: boolean;
    ring: number;
    pending: number;
    persisted: number;
    dropped: number;
    dbReady: boolean;
    lastError?: string;
  } {
    return {
      installed: this.installed,
      ring: this.ring.length,
      pending: this.pending.length,
      persisted: this.persisted,
      dropped: this.dropped,
      dbReady: !!this.db,
      lastError: this._lastError,
    };
  }
}

export const logCollector = new LogCollector();
