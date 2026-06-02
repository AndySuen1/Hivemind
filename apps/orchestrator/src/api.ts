import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import {
  providerCreateSchema,
  providerUpdateSchema,
  botCreateSchema,
  botUpdateSchema,
  projectCreateSchema,
  projectUpdateSchema,
  webSearchProviderSchema,
} from '@hivemind/shared';
import { providerRepo, botRepo, projectRepo } from './repos.js';
import { botManager } from './bot-manager.js';
import { createLlmModel, generateReply } from './llm.js';
import { runTestSearch } from './tools/web-search.js';
import { setSecret, getSecret, deleteSecret, secretAccount } from './secrets.js';
import { registerObservRoutes } from './api-observ.js';
import { registerStreamRoute } from './api-stream.js';
import { allowedOrigins } from './cors-origins.js';
import { exportConfig, importConfig } from './config-io.js';

export function buildApi(): FastifyInstance {
  const app = Fastify({ logger: { level: 'info' } });

  app.register(cors, {
    origin: allowedOrigins(),
    credentials: true,
  });

  // CSRF 轻量护栏：CORS 只决定「能否读响应」，不阻止「简单请求」抵达 handler——一个无 application/json
  // body 的跨源 POST/DELETE 仍会执行副作用（如 P7 的清理/删除路由）。故对所有改动型请求在 handler 之前
  // 兜底校验 Origin：带 Origin 且不在白名单 → 403。无 Origin（本地 curl/脚本/SSR/app.inject）放行——
  // 本服务只监听 127.0.0.1。覆盖全部写路由（含既有 providers/bots/websearch 与 P7 清理）。
  const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const originWhitelist = new Set(allowedOrigins());
  app.addHook('onRequest', async (req, reply) => {
    if (!WRITE_METHODS.has(req.method)) return;
    const origin = req.headers.origin;
    if (origin && !originWhitelist.has(origin)) {
      return reply.code(403).send({ ok: false, error: '跨源写请求被拒绝' });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      reply.code(400).send({ ok: false, error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      return;
    }
    app.log.error(err);
    const msg = err instanceof Error ? err.message : String(err);
    reply.code(500).send({ ok: false, error: msg });
  });

  // ============================================================
  // Health
  // ============================================================
  app.get('/api/health', async () => ({ ok: true, data: { status: 'ok', ts: Date.now() } }));

  // 可观测性查询 API（P4）：会话/消息/回合/事件分页 + 记忆浏览 + Live 总览
  registerObservRoutes(app);
  // 可观测性实时推送（P5）：SSE /api/stream?botId&sessionId&runId
  registerStreamRoute(app);

  // ============================================================
  // 配置导出/导入（机器间迁移）
  // ============================================================
  app.get('/api/config/export', async (req) => {
    const q = req.query as { secrets?: string };
    const includeSecrets = q.secrets === 'true' || q.secrets === '1';
    return { ok: true, data: await exportConfig(includeSecrets) };
  });

  app.post('/api/config/import', async (req) => {
    const result = await importConfig(req.body);
    // 让运行中的 bot 实例与导入后的库对齐（启用的启动、停用的停止、改了的重启）
    await botManager.syncFromDb();
    return { ok: true, data: result };
  });

  // ============================================================
  // Providers
  // ============================================================
  app.get('/api/providers', async () => ({ ok: true, data: providerRepo.list() }));

  app.get('/api/providers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = providerRepo.get(id);
    if (!p) return reply.code(404).send({ ok: false, error: 'Provider 不存在' });
    return { ok: true, data: p };
  });

  app.post('/api/providers', async (req) => {
    const input = providerCreateSchema.parse(req.body);
    const created = await providerRepo.create(input);
    return { ok: true, data: created };
  });

  app.patch('/api/providers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const patch = providerUpdateSchema.parse(req.body);
    const updated = await providerRepo.update(id, patch);
    if (!updated) return reply.code(404).send({ ok: false, error: 'Provider 不存在' });
    return { ok: true, data: updated };
  });

  app.delete('/api/providers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await providerRepo.delete(id);
    if (!ok) return reply.code(404).send({ ok: false, error: 'Provider 不存在' });
    return { ok: true, data: { id } };
  });

  app.post('/api/providers/:id/test', async (req, reply) => {
    const { id } = req.params as { id: string };
    const provider = providerRepo.get(id);
    if (!provider) return reply.code(404).send({ ok: false, error: 'Provider 不存在' });
    try {
      const model = await createLlmModel(provider, provider.model);
      const { text, usage } = await generateReply(model, '你是一个测试助手', [], '请回复"OK"');
      return { ok: true, data: { reply: text, usage } };
    } catch (e) {
      return reply.code(500).send({ ok: false, error: (e as Error).message });
    }
  });

  // ============================================================
  // Bots
  // ============================================================
  app.get('/api/bots', async () => {
    const bots = botRepo.list();
    const statuses = botManager.listStatuses();
    const statusMap = new Map(statuses.map((s) => [s.botId, s]));
    return {
      ok: true,
      data: bots.map((b) => ({
        ...b,
        runtime: statusMap.get(b.id) ?? { botId: b.id, status: 'offline' },
      })),
    };
  });

  app.get('/api/bots/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = botRepo.get(id);
    if (!b) return reply.code(404).send({ ok: false, error: 'Bot 不存在' });
    return { ok: true, data: { ...b, runtime: botManager.getStatus(id) } };
  });

  app.post('/api/bots', async (req) => {
    const input = botCreateSchema.parse(req.body);
    const created = await botRepo.create(input);
    if (created.enabled) {
      botManager.start(created.id).catch((e) => app.log.error(`[bot ${created.id}] auto-start failed: ${e.message}`));
    }
    return { ok: true, data: { ...created, runtime: botManager.getStatus(created.id) } };
  });

  app.patch('/api/bots/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const patch = botUpdateSchema.parse(req.body);
    const before = botRepo.get(id);
    if (!before) return reply.code(404).send({ ok: false, error: 'Bot 不存在' });
    const updated = await botRepo.update(id, patch);
    if (!updated) return reply.code(404).send({ ok: false, error: 'Bot 不存在' });

    // 运行中的 BotInstance 在构造时捕获了 bot 快照（含 systemPrompt/temperature/tools/
    // allowedRequesters），这些字段改了必须重启实例才会生效——否则 dashboard 改了不起作用，
    // 尤其 allowedRequesters 是访问控制，不重启会留下“以为已改、实则未改”的安全空窗。
    const projectChanged = before.projectId !== updated.projectId;
    const needsRestart =
      (before.enabled !== updated.enabled) ||
      patch.discordToken !== undefined ||
      patch.providerId !== undefined ||
      patch.systemPrompt !== undefined ||
      patch.temperature !== undefined ||
      patch.tools !== undefined ||
      patch.allowedRequesters !== undefined ||
      patch.name !== undefined ||
      projectChanged;

    if (needsRestart) {
      if (updated.enabled) {
        botManager.restart(id).catch((e) => app.log.error(`[bot ${id}] restart failed: ${e.message}`));
      } else {
        botManager.stop(id).catch((e) => app.log.error(`[bot ${id}] stop failed: ${e.message}`));
      }
    }
    // 改了项目归属 / 启停 / 改名，都会变同项目同伴的「可协作名单（含名字）/ mention_bot 装配」——重启同伴刷新。
    // （同项目内成员的 mention_bot 是否装配 + 提示里的同伴名字，都在同伴实例启动时按当时的成员快照算定。）
    if (projectChanged || before.enabled !== updated.enabled || patch.name !== undefined) {
      restartProjectPeers([before.projectId, updated.projectId], id);
    }

    return { ok: true, data: { ...updated, runtime: botManager.getStatus(id) } };
  });

  app.delete('/api/bots/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await botManager.stop(id).catch(() => {});
    const ok = await botRepo.delete(id);
    if (!ok) return reply.code(404).send({ ok: false, error: 'Bot 不存在' });
    return { ok: true, data: { id } };
  });

  app.post('/api/bots/:id/start', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await botManager.start(id);
      // 上线后同项目同伴应把它纳入可协作名单 → 刷新同伴
      restartProjectPeers([botRepo.get(id)?.projectId], id);
      return { ok: true, data: botManager.getStatus(id) };
    } catch (e) {
      return reply.code(500).send({ ok: false, error: (e as Error).message });
    }
  });

  app.post('/api/bots/:id/stop', async (req) => {
    const { id } = req.params as { id: string };
    const projectId = botRepo.get(id)?.projectId;
    await botManager.stop(id);
    // 下线后同项目同伴应把它移出可协作名单 → 刷新同伴
    restartProjectPeers([projectId], id);
    return { ok: true, data: botManager.getStatus(id) };
  });

  // ============================================================
  // Project（Inter-Agent 协作分组）：同项目的 bot 自动可互相 @；预算挂项目
  // ============================================================

  // 重启一批 bot（仅启用中的）。成员/项目归属变更后用——刷新其「同伴名单 + mention_bot 工具装配」。
  const restartBots = (ids: Iterable<string>): void => {
    for (const bid of new Set(ids)) {
      const b = botRepo.get(bid);
      if (b?.enabled) botManager.restart(bid).catch((e) => app.log.error(`[bot ${bid}] restart failed: ${e.message}`));
    }
  };
  // 重启给定项目们的成员（可排除某个 bot——它通常已单独重启），用于「某 bot 改了项目归属」时刷新新旧项目同伴。
  const restartProjectPeers = (projectIds: (string | null | undefined)[], exceptId?: string): void => {
    const ids = new Set<string>();
    for (const pid of projectIds) {
      if (!pid) continue;
      for (const b of botRepo.listByProject(pid)) if (b.id !== exceptId) ids.add(b.id);
    }
    restartBots(ids);
  };

  app.get('/api/projects', async () => {
    const projects = projectRepo.list();
    // 附带成员 id，便于前端直接渲染成员勾选
    return {
      ok: true,
      data: projects.map((p) => ({ ...p, memberBotIds: botRepo.listByProject(p.id).map((b) => b.id) })),
    };
  });

  app.get('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = projectRepo.get(id);
    if (!p) return reply.code(404).send({ ok: false, error: '项目不存在' });
    return { ok: true, data: { ...p, memberBotIds: botRepo.listByProject(id).map((b) => b.id) } };
  });

  app.post('/api/projects', async (req) => {
    const input = projectCreateSchema.parse(req.body);
    // 捕获将被拉入成员的 bot 的「原项目」——它们原项目的剩余同伴也要刷新
    const wanted = input.memberBotIds ?? [];
    const oldProjects = wanted.map((bid) => botRepo.get(bid)?.projectId).filter((p): p is string => !!p);
    const created = projectRepo.create(input);
    if (wanted.length) {
      const ids = new Set<string>([...wanted, ...botRepo.listByProject(created.id).map((b) => b.id)]);
      for (const pid of oldProjects) for (const b of botRepo.listByProject(pid)) ids.add(b.id);
      restartBots(ids);
    }
    return { ok: true, data: { ...created, memberBotIds: botRepo.listByProject(created.id).map((b) => b.id) } };
  });

  app.patch('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const patch = projectUpdateSchema.parse(req.body);
    const membersChanged = patch.memberBotIds !== undefined;
    // 改成员前先记下：本项目当前成员（含将被移出的）+ 被拉入 bot 的原项目（其剩余同伴要刷新）
    const beforeMembers = membersChanged ? projectRepo.listMembers(id).map((b) => b.id) : [];
    const oldProjects = membersChanged
      ? (patch.memberBotIds ?? []).map((bid) => botRepo.get(bid)?.projectId).filter((p): p is string => !!p && p !== id)
      : [];
    const updated = projectRepo.update(id, patch);
    if (!updated) return reply.code(404).send({ ok: false, error: '项目不存在' });
    // 预算/名称改动无需重启（转交时实时读项目预算）；仅成员变更才刷新相关 bot。
    if (membersChanged) {
      const ids = new Set<string>([...beforeMembers, ...projectRepo.listMembers(id).map((b) => b.id)]);
      for (const pid of oldProjects) for (const b of botRepo.listByProject(pid)) ids.add(b.id);
      restartBots(ids);
    }
    return { ok: true, data: { ...updated, memberBotIds: projectRepo.listMembers(id).map((b) => b.id) } };
  });

  app.delete('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const members = projectRepo.listMembers(id).map((b) => b.id); // 删项目会把它们 project_id 置 NULL
    const ok = projectRepo.delete(id);
    if (!ok) return reply.code(404).send({ ok: false, error: '项目不存在' });
    restartBots(members); // 失去项目 → 失去 mention_bot 工具，需重启刷新
    return { ok: true, data: { id } };
  });

  // ============================================================
  // Web Search 全局凭证（keytar）。duckduckgo 内置无需配置；searxng 配 URL；tavily/brave 配 key
  // ============================================================
  const envKeyFor = (p: string): string | undefined =>
    p === 'tavily' ? process.env.TAVILY_API_KEY : p === 'brave' ? process.env.BRAVE_API_KEY : undefined;

  app.get('/api/websearch/:provider/status', async (req, reply) => {
    const parsed = webSearchProviderSchema.safeParse((req.params as { provider: string }).provider);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: '未知 provider' });
    const p = parsed.data;
    if (p === 'duckduckgo') return { ok: true, data: { provider: p, configured: true, builtin: true, fromEnv: false } };
    if (p === 'searxng') {
      const stored = await getSecret(secretAccount.webSearchUrl('searxng'));
      const envUrl = process.env.SEARXNG_URL;
      return { ok: true, data: { provider: p, configured: !!stored || !!envUrl, fromEnv: !stored && !!envUrl } };
    }
    const key = await getSecret(secretAccount.webSearchKey(p));
    const envFallback = !!envKeyFor(p);
    return { ok: true, data: { provider: p, configured: !!key || envFallback, fromEnv: !key && envFallback } };
  });

  app.put('/api/websearch/:provider', async (req, reply) => {
    const parsed = webSearchProviderSchema.safeParse((req.params as { provider: string }).provider);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: '未知 provider' });
    const p = parsed.data;
    const body = (req.body ?? {}) as { apiKey?: string; url?: string };
    if (p === 'duckduckgo') return reply.code(400).send({ ok: false, error: 'duckduckgo 内置，无需配置' });
    if (p === 'searxng') {
      const url = body.url?.trim();
      if (!url) return reply.code(400).send({ ok: false, error: 'url 必填' });
      if (!/^https?:\/\//i.test(url)) return reply.code(400).send({ ok: false, error: 'url 需以 http(s):// 开头' });
      await setSecret(secretAccount.webSearchUrl('searxng'), url);
      return { ok: true, data: { provider: p, configured: true } };
    }
    if (!body.apiKey || !body.apiKey.trim()) return reply.code(400).send({ ok: false, error: 'apiKey 必填' });
    await setSecret(secretAccount.webSearchKey(p), body.apiKey.trim());
    return { ok: true, data: { provider: p, configured: true } };
  });

  app.delete('/api/websearch/:provider', async (req, reply) => {
    const parsed = webSearchProviderSchema.safeParse((req.params as { provider: string }).provider);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: '未知 provider' });
    const p = parsed.data;
    if (p === 'searxng') await deleteSecret(secretAccount.webSearchUrl('searxng')).catch(() => {});
    else await deleteSecret(secretAccount.webSearchKey(p)).catch(() => {});
    return { ok: true, data: { provider: p, configured: false } };
  });

  app.post('/api/websearch/:provider/test', async (req, reply) => {
    const parsed = webSearchProviderSchema.safeParse((req.params as { provider: string }).provider);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: '未知 provider' });
    const p = parsed.data;
    let cfg: { apiKey?: string; baseUrl?: string } = {};
    if (p === 'searxng') {
      const url = (await getSecret(secretAccount.webSearchUrl('searxng'))) || process.env.SEARXNG_URL || undefined;
      if (!url) return reply.code(400).send({ ok: false, error: '尚未配置 SearXNG 实例 URL' });
      cfg = { baseUrl: url };
    } else if (p === 'tavily' || p === 'brave') {
      const key = (await getSecret(secretAccount.webSearchKey(p))) || envKeyFor(p);
      if (!key) return reply.code(400).send({ ok: false, error: '尚未配置 API key' });
      cfg = { apiKey: key };
    }
    try {
      const sample = await runTestSearch(p, cfg);
      return { ok: true, data: { sample } };
    } catch (e) {
      return reply.code(500).send({ ok: false, error: (e as Error).message });
    }
  });

  return app;
}
