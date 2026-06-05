// SSE 连接骨架（从 api-stream.ts 提取，供 P5 业务流 /api/stream 与日志流 /api/logs/stream 复用）。
//
// 关键手法：reply.hijack() 接管响应 → 裸写 reply.raw（绕过 Fastify 正常响应生命周期）；
// 因 hijack 绕过了 @fastify/cors 的响应钩子，需**手动补 CORS 头**；心跳保活；背压保护；
// 断开时清理订阅（onClose 回调）与定时器。调用方只负责「订阅数据源 + onClose 注销」。

import type { FastifyReply, FastifyRequest } from 'fastify';
import { allowedOrigins } from './cors-origins.js';

const HEARTBEAT_MS = 25_000; // 心跳间隔：保活 + 探测死连接（< 常见 30s 代理空闲超时）
// 背压上限：客户端不读取（弱网/后台标签/TCP 半开死连接）导致积压超此值 → 主动断开，
// 杜绝 Node 写缓冲无界增长（OOM）与监听器泄漏。
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
// TCP keepalive 初始空闲：让 OS 更快探出半开死连接（默认 ~2h），把泄漏窗口缩到秒级。
const KEEPALIVE_DELAY_MS = 30_000;
// 与 api.ts 共用同一 env 派生逻辑（见 cors-origins.ts），改端口必须两处同步放开。
const ALLOWED_ORIGINS = allowedOrigins();

/** 选回声 Origin（在白名单内）或默认首项，供手动 CORS 用。 */
function pickOrigin(req: FastifyRequest): string {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && ALLOWED_ORIGINS.includes(origin)) return origin;
  return ALLOWED_ORIGINS[0]!;
}

export interface SseConn {
  /** 写一帧（已做背压/断开保护，安全幂等吞错）。 */
  write(chunk: string): void;
  /** 注册断开清理（调用方在此注销对数据源的订阅）。可多次注册。 */
  onClose(cb: () => void): void;
  /** 主动关闭连接（触发清理）。 */
  close(): void;
}

export interface SseOptions {
  /** 心跳间隔 ms。日志流量大于业务流时无需调整；默认 25s。 */
  heartbeatMs?: number;
  /** 背压上限字节。日志流可调高（默认 4MB）。 */
  maxBufferBytes?: number;
}

/**
 * 接管响应为 SSE 连接。返回 { write, onClose, close }。
 * 调用方典型用法：const sse = startSse(req, reply); const off = source.subscribe(d => sse.write(...)); sse.onClose(off);
 */
export function startSse(req: FastifyRequest, reply: FastifyReply, opts: SseOptions = {}): SseConn {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const maxBufferBytes = opts.maxBufferBytes ?? MAX_BUFFER_BYTES;

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
  const closeCbs: Array<() => void> = [];

  // 写入封装：连接已结束或写出错都安全吞掉（避免死连接影响数据源广播）。
  const write = (chunk: string): void => {
    if (closed || raw.writableEnded) return;
    // 背压保护：积压超阈值说明客户端没在读（含半开死连接）→ 主动断开，绝不无界缓冲。
    if (raw.writableLength > maxBufferBytes) {
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
  write('retry: 5000\n: connected\n\n');

  const heartbeat = setInterval(() => write(': ping\n\n'), heartbeatMs);
  // 别让心跳定时器拖住进程退出（生产进程本就常驻；测试/优雅退出更干净）。
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  function cleanup(): void {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const cb of closeCbs) {
      try {
        cb();
      } catch {
        /* 注销回调异常隔离，不影响后续清理 */
      }
    }
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

  return {
    write,
    onClose: (cb) => closeCbs.push(cb),
    close: cleanup,
  };
}
