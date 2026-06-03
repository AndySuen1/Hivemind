// Skill / 调度路由（Phase 3.5）：共享 skill 的浏览/编辑/新建/删除（文件系统）+ 调度面板聚合 + 手动触发。
// 沿用 ok/data 信封。写路由的 Origin 防护由 api.ts 的全局 onRequest hook 兜底，无需在此重复。
// skill :name 进文件系统路径，一律经 SKILL_NAME_RE 严格校验防穿越（仿 api-observ 的 BOT_ID_RE）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SKILL_NAME_RE } from '@hivemind/shared';
import type { BotScheduleEntry } from '@hivemind/shared';
import {
  listSkillSummaries,
  getSkillDetail,
  writeSkill,
  createSkill,
  removeSkill,
  skillExists,
} from './skills.js';
import { botRepo } from './repos.js';
import { botManager } from './bot-manager.js';

const skillSaveSchema = z.object({ content: z.string() });
const skillCreateSchema = z.object({ name: z.string(), content: z.string().optional() });
const triggerSchema = z.object({ prompt: z.string().min(1).max(4000) });

export function registerSkillRoutes(app: FastifyInstance): void {
  // ── 共享 skill（文件系统）────────────────────────────────

  // 列出所有 skill（name + frontmatter description）
  app.get('/api/skills', async () => ({ ok: true, data: listSkillSummaries() }));

  // 读单个 skill 的 SKILL.md 全文
  app.get('/api/skills/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!SKILL_NAME_RE.test(name)) return reply.code(400).send({ ok: false, error: '非法 skill 名' });
    const detail = getSkillDetail(name);
    if (!detail) return reply.code(404).send({ ok: false, error: 'skill 不存在' });
    return { ok: true, data: detail };
  });

  // 保存（覆盖）已存在 skill 的 SKILL.md
  app.put('/api/skills/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!SKILL_NAME_RE.test(name)) return reply.code(400).send({ ok: false, error: '非法 skill 名' });
    const { content } = skillSaveSchema.parse(req.body);
    if (!skillExists(name)) return reply.code(404).send({ ok: false, error: 'skill 不存在' });
    return { ok: true, data: writeSkill(name, content) };
  });

  // 新建 skill（建目录 + 写 SKILL.md）
  app.post('/api/skills', async (req, reply) => {
    const { name, content } = skillCreateSchema.parse(req.body);
    if (!SKILL_NAME_RE.test(name))
      return reply.code(400).send({ ok: false, error: 'skill 名只能用小写字母/数字/连字符（如 daily-status）' });
    if (skillExists(name)) return reply.code(409).send({ ok: false, error: `skill「${name}」已存在` });
    return { ok: true, data: createSkill(name, content) };
  });

  // 删除整个 skill 目录
  app.delete('/api/skills/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!SKILL_NAME_RE.test(name)) return reply.code(400).send({ ok: false, error: '非法 skill 名' });
    const removed = removeSkill(name);
    if (!removed) return reply.code(404).send({ ok: false, error: 'skill 不存在' });
    return { ok: true, data: { name } };
  });

  // ── 调度面板（schedule 随 bot 走，这里只做聚合 + 手动触发）──────────────

  // 列出所有 bot 的全部 schedule（扁平化，带归属 bot 与在线状态）
  app.get('/api/schedules', async () => {
    const out: BotScheduleEntry[] = [];
    for (const bot of botRepo.list()) {
      const online = botManager.getStatus(bot.id).status === 'online';
      bot.schedule.forEach((item, index) => {
        out.push({
          botId: bot.id,
          botName: bot.name,
          index,
          cron: item.cron,
          prompt: item.prompt,
          targetChannelId: item.targetChannelId,
          enabled: item.enabled,
          botOnline: online,
        });
      });
    }
    return { ok: true, data: out };
  });

  // 手动触发某 bot 的第 index 条 schedule（用其 prompt 立即跑一次）
  app.post('/api/bots/:id/schedules/:index/run', async (req, reply) => {
    const { id, index } = req.params as { id: string; index: string };
    const bot = botRepo.get(id);
    if (!bot) return reply.code(404).send({ ok: false, error: 'bot 不存在' });
    const i = Number(index);
    const item = Number.isInteger(i) ? bot.schedule[i] : undefined;
    if (!item) return reply.code(404).send({ ok: false, error: '该 schedule 不存在' });
    const ack = await botManager.triggerBot(id, { prompt: item.prompt, targetChannelId: item.targetChannelId });
    return { ok: true, data: ack };
  });

  // 测试运行：用任意 prompt 立即触发某 bot 跑一回合
  app.post('/api/bots/:id/trigger', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!botRepo.get(id)) return reply.code(404).send({ ok: false, error: 'bot 不存在' });
    const { prompt } = triggerSchema.parse(req.body);
    const ack = await botManager.triggerBot(id, { prompt });
    return { ok: true, data: ack };
  });
}
