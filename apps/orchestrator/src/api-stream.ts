// SSE 实时推送（P5）：把 recorder.bus 广播的 ObservRecord 按 botId/sessionId/runId 过滤后
// 以 text/event-stream 推给 Dashboard。
//
// 关键手法（方案）：reply.hijack() 接管响应 → 裸写 reply.raw（绕过 Fastify 正常响应生命周期）；
// 因 hijack 绕过了 @fastify/cors 的响应钩子，需**手动补 CORS 头**；心跳保活；断开时清理订阅与定时器。

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ObservRecord } from '@discord-agent-hub/shared';
import { recorder } from './recorder.js';
import { allowedOrigins } from './cors-origins.js';

const HEARTBEAT_MS = 25_000; // 心跳间隔：保活 + 探测死连接（< 常见 30s 代理空闲超时）
// 与 api.ts 共用同一 env 派生逻辑（见 cors-origins.ts），改端口必须两处同步放开。
const ALLOWED_ORIGINS = allowedOrigins();
// 背压上限：客户端不读取（弱网/后台标签/TCP 半开死连接）导致积压超此值 → 主动断开，
// 杜绝 Node 写缓冲无界增长（OOM）与监听器泄漏。正常 dashboard 远不会触及。
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
// TCP keepalive 初始空闲：让 OS 更快探出半开死连接（默认 ~2h），把泄漏窗口缩到秒级。
const KEEPALIVE_DELAY_MS = 30_000;

interface StreamFilter {
  botId?: string;
  sessionId?: string;
  runId?: string;
}

/** 一条广播是否匹配过滤器：所有给定过滤项都需命中；过滤项对该记录种类不适用则视为不命中。 */
function recordMatches(rec: ObservRecord, f: StreamFilter): boolean {
  if (f.botId && rec.row.botId !== f.botId) return false;

  if (f.sessionId) {
    const sid = rec.kind === 'session' ? rec.row.id : rec.row.sessionId;
    if (sid !== f.sessionId) return false;
  }

  if (f.runId) {
    let rid: string | undefined;
    if (rec.kind === 'run') rid = rec.row.id;
    else if (rec.kind === 'event' || rec.kind === 'message') rid = rec.row.runId;
    else rid = undefined; // session 不隶属某个 run
    if (rid !== f.runId) return false;
  }

  return true;
}

/** 选回声 Origin（在白名单内）或默认首项，供手动 CORS 用。 */
function pickOrigin(req: FastifyRequest): string {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && ALLOWED_ORIGINS.includes(origin)) return origin;
  return ALLOWED_ORIGINS[0]!;
}

export function registerStreamRoute(app: FastifyInstance): void {
  app.get('/api/stream', (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const filter: StreamFilter = { botId: q.botId, sessionId: q.sessionId, runId: q.runId };

    // 接管响应，之后只裸写 reply.raw（Fastify 不再插手）。
    reply.hijack();
    const raw = reply.raw;

    // 开 TCP keepalive：半开死连接（peer 崩溃/网络硬断，不发 FIN）下 'close'/'error' 不会触发，
    // 靠 OS keepalive 探活后才会冒 error → cleanup，避免监听器与缓冲长期泄漏。
    req.raw.socket?.setKeepAlive(true, KEEPALIVE_DELAY_MS);

    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // 禁止反代缓冲，保证实时
      'Access-Control-Allow-Origin': pickOrigin(req),
      'Access-Control-Allow-Credentials': 'true',
    });

    let closed = false;
    // 写入封装：连接已结束或写出错都安全吞掉（避免死连接影响 recorder 广播）。
    const safeWrite = (chunk: string): void => {
      if (closed || raw.writableEnded) return;
      // 背压保护：积压超阈值说明客户端没在读（含半开死连接）→ 主动断开，绝不无界缓冲。
      if (raw.writableLength > MAX_BUFFER_BYTES) {
        cleanup();
        return;
      }
      try {
        raw.write(chunk);
      } catch {
        cleanup();
      }
    };

    // 建议前端断线重连间隔 + 初始注释帧（让客户端确认已连上）。
    safeWrite('retry: 5000\n: connected\n\n');

    const unsubscribe = recorder.onRecord((rec) => {
      if (recordMatches(rec, filter)) safeWrite(`data: ${JSON.stringify(rec)}\n\n`);
    });

    const heartbeat = setInterval(() => safeWrite(': ping\n\n'), HEARTBEAT_MS);
    // 别让心跳定时器拖住进程退出（生产进程本就常驻；测试/优雅退出更干净）。
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    function cleanup(): void {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      try {
        // destroy（而非 end）：背压/半开断开时需立刻释放写缓冲；正常断开时 socket 已关，等价无副作用。
        raw.destroy();
      } catch {
        /* 已结束/已销毁，忽略 */
      }
    }

    // 客户端断开（关闭 EventSource / 导航离开）→ 清理订阅与心跳，杜绝泄漏。
    req.raw.on('close', cleanup);
    raw.on('error', cleanup);
  });
}
