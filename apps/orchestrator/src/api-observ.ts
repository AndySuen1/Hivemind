// 可观测性路由：P4 只读查询（会话/消息/回合/事件分页 + 记忆浏览 + Live 总览）
// + P7 清理（写：删会话 / 删某 bot 全部历史 / 手动按保留天数清理）。
// 沿用 ok/data 信封 + before/beforeId/limit（events 用 after）游标分页。注册到主 Fastify 实例（见 api.ts）。

import type { FastifyInstance } from 'fastify';
import type { LiveOverviewBot } from '@hivemind/shared';
import { observRepo } from './observ-repo.js';
import { deleteSession, deleteBotHistory, purgeByRetentionStrict, RETENTION_DAYS } from './observ-retention.js';
import { botRepo } from './repos.js';
import { botManager } from './bot-manager.js';

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

// 记忆端点用 :id 拼文件系统路径，必须严格校验防穿越（其余端点 :id 只进参数化 SQL，无此风险）。
const BOT_ID_RE = /^[\w-]{1,64}$/;

export function registerObservRoutes(app: FastifyInstance): void {
  // 某 bot 的会话列表（按最近活跃倒序，游标 before=last_active_at + beforeId=id）
  app.get('/api/bots/:id/sessions', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string>;
    return { ok: true, data: observRepo.listSessions(id, { before: numQ(q.before), beforeId: strQ(q.beforeId), limit: numQ(q.limit) }) };
  });

  // 某会话的聊天消息（倒序，游标 before=created_at + beforeId=id）
  app.get('/api/sessions/:sid/messages', async (req) => {
    const { sid } = req.params as { sid: string };
    const q = req.query as Record<string, string>;
    return { ok: true, data: observRepo.listMessages(sid, { before: numQ(q.before), beforeId: strQ(q.beforeId), limit: numQ(q.limit) }) };
  });

  // 某会话的回合（执行追踪单位，倒序，游标 before=started_at + beforeId=id）
  app.get('/api/sessions/:sid/runs', async (req) => {
    const { sid } = req.params as { sid: string };
    const q = req.query as Record<string, string>;
    return { ok: true, data: observRepo.listRuns(sid, { before: numQ(q.before), beforeId: strQ(q.beforeId), limit: numQ(q.limit) }) };
  });

  // 某回合的事件时间线（按 seq 升序，after=seq）
  app.get('/api/runs/:rid/events', async (req) => {
    const { rid } = req.params as { rid: string };
    const q = req.query as Record<string, string>;
    return { ok: true, data: observRepo.listEvents(rid, { after: numQ(q.after), limit: numQ(q.limit) }) };
  });

  // 记忆浏览（只读）：列表
  app.get('/api/bots/:id/memory', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!BOT_ID_RE.test(id)) return reply.code(400).send({ ok: false, error: '非法 bot id' });
    return { ok: true, data: observRepo.memoryList(id) };
  });

  // 记忆浏览（只读）：单文件内容，path = 列表里的 file（裸 .md 文件名，经 path-guard）
  app.get('/api/bots/:id/memory/file', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!BOT_ID_RE.test(id)) return reply.code(400).send({ ok: false, error: '非法 bot id' });
    const q = req.query as { path?: string };
    if (!q.path) return reply.code(400).send({ ok: false, error: '缺少 path 参数' });
    const content = observRepo.memoryFile(id, q.path);
    if (content == null) return reply.code(404).send({ ok: false, error: '记忆文件不存在或路径非法' });
    return { ok: true, data: { path: q.path, content } };
  });

  // Live 总览：运行时状态（botManager）+ DB 聚合（observRepo）合并
  app.get('/api/live/overview', async () => {
    const bots = botRepo.list();
    const statusMap = new Map(botManager.listStatuses().map((s) => [s.botId, s]));
    const agg = observRepo.liveAggregates();
    const out: LiveOverviewBot[] = bots.map((b) => {
      const st = statusMap.get(b.id);
      const a = agg.get(b.id) ?? { sessions: 0, runs: 0, runningRuns: 0, lastActiveAt: null };
      return {
        botId: b.id,
        name: b.name,
        status: st?.status ?? 'offline',
        errorMessage: st?.errorMessage,
        connectedAt: st?.connectedAt,
        sessions: a.sessions,
        runs: a.runs,
        runningRuns: a.runningRuns,
        lastActiveAt: a.lastActiveAt,
      };
    });
    return { ok: true, data: { ts: Date.now(), bots: out } };
  });

  // ============================================================
  // P7 清理（写）：删除靠 0005 的 ON DELETE CASCADE 连带清子表
  // ============================================================

  // 删除单个会话（连带其回合/消息/事件）
  app.delete('/api/sessions/:sid', async (req) => {
    const { sid } = req.params as { sid: string };
    const deleted = deleteSession(sid);
    return { ok: true, data: { id: sid, deleted } };
  });

  // 删除某 bot 的全部可观测历史（所有会话 + 连带子表）
  app.delete('/api/bots/:id/history', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!BOT_ID_RE.test(id)) return reply.code(400).send({ ok: false, error: '非法 bot id' });
    const { sessions } = deleteBotHistory(id);
    return { ok: true, data: { botId: id, sessions } };
  });

  // 手动触发按保留天数清理（可选 ?days= 覆盖配置；默认用 OBSERV_RETENTION_DAYS）。
  // 取整后传入；用 strict 版本——清理失败上抛 500（而非吞成「已清理 0 个」伪装成功）。
  app.post('/api/observ/retention/run', async (req) => {
    const q = req.query as Record<string, string>;
    const days = Math.floor(numQ(q.days) ?? RETENTION_DAYS);
    const { sessions } = purgeByRetentionStrict(days);
    return { ok: true, data: { days, sessions } };
  });
}
