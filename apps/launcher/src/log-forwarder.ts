// 日志转发：把 launcher 自身 + 它 spawn 的 orchestrator/dashboard 子进程的 stdout/stderr 行，
// 批量 POST 到 orchestrator 的 /api/logs/ingest，汇入「可视化日志系统」。
//
// 为什么由 launcher 转发（而非只靠 orchestrator 自捕获）：
//  · dashboard（next）子进程的日志只有 launcher 看得到；
//  · orchestrator **install 之前**（模块加载/编译错误）与**崩溃那一刻**（[fatal]/EADDRINUSE）的日志，
//    orchestrator 自己来不及落库 —— 只有 launcher 的 child stdout/stderr 能捕获。
//  正常运行期 orchestrator 行会与自捕获重复，由 orchestrator ingest 端按 ts+message 去重。
//
// 纪律：
//  · 用 node:http（与 control-server 同栈，零依赖；不碰 electron net / 全局 fetch）。
//  · **本模块任何代码禁用 console.\***：launcher 自身 stdout 被本模块 patch 捕获，若失败时 console.error
//    会被再次捕获 → 入队 → 转发失败 → 再 error，形成正反馈。失败一律静默丢弃。
//  · 队列有界（超界丢最旧），发送失败丢这批不重试（不做就绪探测/重放）。

import http from 'node:http';

export type ForwardSource = 'orchestrator' | 'dashboard' | 'launcher';
type StreamName = 'out' | 'err';

interface ForwardEntry {
  source: ForwardSource;
  message: string;
  ts: number;
  stream: StreamName;
}

interface Endpoint {
  host: string;
  port: number;
  token: string;
}

const QUEUE_CAP = 5000; // 队列上限（orchestrator 不可达时丢最旧，绝不无界）
const FLUSH_INTERVAL_MS = 500; // 节流批量发送间隔
const FLUSH_BATCH = 500; // 单次 POST 最多条数（ingest schema 上限 1000）
const MAX_PARTIAL = 64 * 1024; // 单行未见换行的强制 flush 阈值

export class LogForwarder {
  private readonly endpoint: () => Endpoint;
  private queue: ForwardEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly lineBuf = new Map<string, string>(); // key=`${source}:${stream}`
  private installed = false;
  private writing = false;
  private origOut: typeof process.stdout.write | null = null;
  private origErr: typeof process.stderr.write | null = null;

  constructor(endpoint: () => Endpoint) {
    this.endpoint = endpoint;
  }

  /** patch launcher 自身 stdout/stderr：原样透传 + 采集为 source='launcher'。幂等。 */
  install(): void {
    if (this.installed) return;
    this.installed = true;
    this.origOut = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;
    this.origErr = process.stderr.write.bind(process.stderr) as typeof process.stderr.write;
    process.stdout.write = this.makePatched(this.origOut, 'out');
    process.stderr.write = this.makePatched(this.origErr, 'err');
  }

  private makePatched(orig: typeof process.stdout.write, stream: StreamName): typeof process.stdout.write {
    const self = this;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return function (this: unknown, ...args: any[]): boolean {
      const ret = (orig as (...a: any[]) => boolean)(...args); // 先原样透传（dev 终端可见）
      if (!self.writing) {
        self.writing = true;
        try {
          self.push('launcher', stream, args[0]);
        } catch {
          /* 静默，绝不 console */
        } finally {
          self.writing = false;
        }
      }
      return ret;
    } as typeof process.stdout.write;
  }

  /** 直写终端（绕过 launcher 自捕获）：供 process-manager 透传子进程输出，避免被当作 launcher 源重复采集。 */
  writeOut(s: string): void {
    (this.origOut ?? process.stdout.write.bind(process.stdout))(s);
  }
  writeErr(s: string): void {
    (this.origErr ?? process.stderr.write.bind(process.stderr))(s);
  }

  /** 喂一段 chunk（按行切分入队）。source 标明来源进程，供 orchestrator 端分类/去重。 */
  push(source: ForwardSource, stream: StreamName, chunk: unknown): void {
    try {
      const key = `${source}:${stream}`;
      const text =
        (this.lineBuf.get(key) ?? '') +
        (typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      const parts = text.split(/\r?\n/);
      let partial = parts.pop() ?? '';
      if (partial.length > MAX_PARTIAL) {
        this.enqueue({ source, stream, message: partial, ts: Date.now() });
        partial = '';
      }
      this.lineBuf.set(key, partial);
      for (const line of parts) {
        if (line.length > 0) this.enqueue({ source, stream, message: line, ts: Date.now() });
      }
    } catch {
      /* 静默 */
    }
  }

  private enqueue(entry: ForwardEntry): void {
    this.queue.push(entry);
    if (this.queue.length > QUEUE_CAP) this.queue.splice(0, this.queue.length - QUEUE_CAP); // 丢最旧
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  private flush(): void {
    if (this.queue.length === 0) return;
    const ep = this.endpoint();
    if (!ep || !ep.host || !ep.port) return;
    const batch = this.queue.slice(0, FLUSH_BATCH);
    this.queue = this.queue.slice(FLUSH_BATCH);
    try {
      const body = Buffer.from(JSON.stringify({ entries: batch }), 'utf-8');
      const req = http.request(
        {
          host: ep.host,
          port: ep.port,
          path: '/api/logs/ingest',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.length,
            'x-ingest-token': ep.token,
          },
        },
        (res) => {
          res.resume(); // 丢弃响应体，避免 socket 挂起
        }
      );
      req.on('error', () => {
        /* orchestrator 未就绪/网络错：丢这批不重试，绝不 console */
      });
      req.write(body);
      req.end();
    } catch {
      /* 静默丢弃 */
    }
    // 队列里仍有剩余（>FLUSH_BATCH）→ 继续排下一次 flush。
    if (this.queue.length > 0) this.scheduleFlush();
  }
}
