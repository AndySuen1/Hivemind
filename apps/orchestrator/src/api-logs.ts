// 日志系统路由：原始运行日志的查询（游标分页 + level/source/关键词过滤）、SSE 实时流、
// launcher 转发入口（ingest）、清空。沿用 ok/data 信封 + before/beforeId/limit 游标分页。
//
// 与可观测性（api-observ/api-stream）正交：那边是结构化业务事件（挂 run/session），这边是按行的原始日志。

import type { FastifyInstance } from 'fastify';
import type { LogEntry, LogLevel, LogSource } from '@hivemind/shared';
import { logLevelSchema, logSourceSchema, logIngestPayloadSchema } from '@hivemind/shared';
import { logCollector } from './log-collector.js';
import { startSse } from './sse.js';

/** 解析数值型查询参数；空/非法 → undefined。 */
function numQ(v: unknown): number | undefined {
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 解析字符串型查询参数；空 → undefined。 */
function strQ(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function levelQ(v: unknown): LogLevel | undefined {
  const p = logLevelSchema.safeParse(v);
  return p.success ? p.data : undefined;
}

function sourceQ(v: unknown): LogSource | undefined {
  const p = logSourceSchema.safeParse(v);
  return p.success ? p.data : undefined;
}

interface LogStreamFilter {
  level?: LogLevel;
  source?: LogSource;
  q?: string;
}

function logMatches(e: LogEntry, f: LogStreamFilter): boolean {
  if (f.level && e.level !== f.level) return false;
  if (f.source && e.source !== f.source) return false;
  if (f.q) {
    const hay = (e.message + ' ' + (e.tag ?? '')).toLowerCase();
    if (!hay.includes(f.q.toLowerCase())) return false;
  }
  return true;
}

export function registerLogRoutes(app: FastifyInstance): void {
  // 历史查询（倒序，游标 before=ts + beforeId=id；可选 level/source/q 过滤）
  app.get('/api/logs', async (req) => {
    const q = req.query as Record<string, string>;
    return {
      ok: true,
      data: logCollector.list({
        before: numQ(q.before),
        beforeId: strQ(q.beforeId),
        limit: numQ(q.limit),
        level: levelQ(q.level),
        source: sourceQ(q.source),
        q: strQ(q.q),
      }),
    };
  });

  // 实时流：SSE 推 LogEntry，按 level/source/q 过滤（日志流量大于业务流，背压阈值调高到 8MB）。
  app.get('/api/logs/stream', (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const filter: LogStreamFilter = { level: levelQ(q.level), source: sourceQ(q.source), q: strQ(q.q) };
    const sse = startSse(req, reply, { maxBufferBytes: 8 * 1024 * 1024 });
    const unsubscribe = logCollector.onLog((entry) => {
      if (logMatches(entry, filter)) sse.write(`data: ${JSON.stringify(entry)}\n\n`);
    });
    sse.onClose(unsubscribe);
  });

  // launcher 转发入口：env LOG_INGEST_TOKEN 鉴权（dev 无 token 时靠 api.ts 的 onRequest Origin 钩子兜底——
  // 无 Origin 的本地 node:http 放行，跨源浏览器 POST 带 Origin 会被 403）。
  app.post('/api/logs/ingest', async (req, reply) => {
    const required = process.env.LOG_INGEST_TOKEN;
    if (required) {
      const got = req.headers['x-ingest-token'];
      if (got !== required) return reply.code(401).send({ ok: false, error: 'ingest 鉴权失败' });
    }
    const payload = logIngestPayloadSchema.parse(req.body);
    const accepted = logCollector.ingest(payload);
    return { ok: true, data: { accepted } };
  });

  // 清空全部日志（写路由受 api.ts 的 Origin 白名单保护）。
  app.delete('/api/logs', async () => {
    logCollector.clear();
    return { ok: true, data: { cleared: true } };
  });
}
