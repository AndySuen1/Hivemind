// SSE 实时推送（P5）：把 recorder.bus 广播的 ObservRecord 按 botId/sessionId/runId 过滤后
// 以 text/event-stream 推给 Dashboard。
//
// SSE 连接骨架（hijack / 手动 CORS / 心跳 / 背压 / keepalive / 断开清理）已抽到 sse.ts，
// 与日志流 /api/logs/stream 共用；本文件只剩「订阅 recorder + 过滤」业务逻辑。

import type { FastifyInstance } from 'fastify';
import type { ObservRecord } from '@hivemind/shared';
import { recorder } from './recorder.js';
import { startSse } from './sse.js';

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

export function registerStreamRoute(app: FastifyInstance): void {
  app.get('/api/stream', (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const filter: StreamFilter = { botId: q.botId, sessionId: q.sessionId, runId: q.runId };

    const sse = startSse(req, reply);
    const unsubscribe = recorder.onRecord((rec) => {
      if (recordMatches(rec, filter)) sse.write(`data: ${JSON.stringify(rec)}\n\n`);
    });
    sse.onClose(unsubscribe);
  });
}
