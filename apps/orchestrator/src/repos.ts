import { randomUUID } from 'node:crypto';
import type {
  Bot,
  BotCreate,
  BotUpdate,
  Provider,
  ProviderCreate,
  ProviderUpdate,
  Project,
  ProjectCreate,
  ProjectUpdate,
} from '@hivemind/shared';
import {
  botToolsSchema,
  fsToolConfigSchema,
  bashToolConfigSchema,
  memoryToolConfigSchema,
  conversationMemoryConfigSchema,
  webSearchToolConfigSchema,
  claudeCodeToolConfigSchema,
  discordPushToolConfigSchema,
  scheduleItemSchema,
} from '@hivemind/shared';
import { getDb } from './db.js';
import { setSecret, getSecret, deleteSecret, secretAccount } from './secrets.js';

// ============================================================
// Provider Repo
// ============================================================

type ProviderRow = {
  id: string;
  name: string;
  kind: 'openai-compatible' | 'anthropic-direct';
  base_url: string | null;
  default_model: string;  // DB 列名保留 default_model（旧 schema），TS 字段是 model
  created_at: number;
  updated_at: number;
};

const rowToProvider = (r: ProviderRow): Provider => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  baseUrl: r.base_url ?? undefined,
  model: r.default_model,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const providerRepo = {
  list(): Provider[] {
    const rows = getDb().prepare('SELECT * FROM providers ORDER BY created_at').all() as ProviderRow[];
    return rows.map(rowToProvider);
  },

  get(id: string): Provider | null {
    const row = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow | undefined;
    return row ? rowToProvider(row) : null;
  },

  async create(input: ProviderCreate): Promise<Provider> {
    const id = randomUUID();
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO providers (id, name, kind, base_url, default_model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.name, input.kind, input.baseUrl ?? null, input.model, now, now);
    await setSecret(secretAccount.providerApiKey(id), input.apiKey);
    return this.get(id)!;
  },

  async update(id: string, patch: ProviderUpdate): Promise<Provider | null> {
    const existing = this.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: Date.now() };
    getDb()
      .prepare(
        `UPDATE providers
           SET name = ?, kind = ?, base_url = ?, default_model = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(updated.name, updated.kind, updated.baseUrl ?? null, updated.model, updated.updatedAt, id);
    if (patch.apiKey) {
      await setSecret(secretAccount.providerApiKey(id), patch.apiKey);
    }
    return this.get(id);
  },

  async delete(id: string): Promise<boolean> {
    const result = getDb().prepare('DELETE FROM providers WHERE id = ?').run(id);
    if (result.changes > 0) {
      await deleteSecret(secretAccount.providerApiKey(id)).catch(() => {});
      return true;
    }
    return false;
  },

  async getApiKey(id: string): Promise<string | null> {
    return getSecret(secretAccount.providerApiKey(id));
  },
};

// ============================================================
// Bot Repo
// ============================================================

type BotRow = {
  id: string;
  name: string;
  provider_id: string;
  system_prompt: string;
  role: string;
  temperature: number;
  tools: string;
  allowed_requesters: string;
  project_id: string | null;
  skills: string;
  schedule: string;
  enabled: number;
  created_at: number;
  updated_at: number;
};

/** 安全解析 JSON 字符串数组（坏数据/旧行 → 空数组）。供 workspace_dirs 等列用。 */
function parseStrArr(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// 解析 tools JSON；坏数据/旧行（'{}'）经 botToolsSchema 补齐默认值，不让单条坏配置拖垮整库
function parseBotTools(raw: string): Bot['tools'] {
  let obj: unknown = {};
  try {
    obj = JSON.parse(raw);
  } catch {
    obj = {};
  }
  // 兼容旧结构
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const o = obj as Record<string, any>;
    // 1) fs.allowedPaths / bash.allowedCwds 已合并为共享 workspaceDirs
    if (!Array.isArray(o.workspaceDirs)) {
      const legacy = [
        ...(Array.isArray(o.fs?.allowedPaths) ? o.fs.allowedPaths : []),
        ...(Array.isArray(o.bash?.allowedCwds) ? o.bash.allowedCwds : []),
      ];
      if (legacy.length) o.workspaceDirs = [...new Set(legacy)];
    }
    // 注：webSearch 现仅 { enabled }，旧的 provider/providers/dailyLimit 字段由 schema 自动 strip，无需迁移。
  }

  const whole = botToolsSchema.safeParse(obj);
  if (whole.success) return whole.data;

  // 整体校验失败 → 逐 section 降级，只默认坏的那段，保留其余；并记日志（不再静默清空整 bot 工具配置）
  console.warn(
    '[repos] bot tools 解析失败，逐项降级：',
    whole.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
  );
  const o = obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, any>) : {};
  const section = <T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T }; parse: (v: unknown) => T }, val: unknown): T => {
    const r = schema.safeParse(val);
    return r.success ? (r.data as T) : schema.parse({});
  };
  return {
    workspaceDirs: Array.isArray(o.workspaceDirs) ? o.workspaceDirs.filter((x: unknown) => typeof x === 'string') : [],
    fs: section(fsToolConfigSchema, o.fs),
    bash: section(bashToolConfigSchema, o.bash),
    memory: section(memoryToolConfigSchema, o.memory),
    conversationMemory: section(conversationMemoryConfigSchema, o.conversationMemory),
    webSearch: section(webSearchToolConfigSchema, o.webSearch),
    claudeCode: section(claudeCodeToolConfigSchema, o.claudeCode),
    discordPush: section(discordPushToolConfigSchema, o.discordPush),
  };
}

/** 安全解析 schedule JSON 数组（坏数据/旧行 → 空数组），逐项过 scheduleItemSchema 补默认值。 */
function parseSchedule(raw: string | null | undefined): Bot['schedule'] {
  try {
    const v = JSON.parse(raw ?? '[]');
    if (!Array.isArray(v)) return [];
    const out: Bot['schedule'] = [];
    for (const item of v) {
      const r = scheduleItemSchema.safeParse(item);
      if (r.success) out.push(r.data);
    }
    return out;
  } catch {
    return [];
  }
}

const rowToBot = (r: BotRow): Bot => ({
  id: r.id,
  name: r.name,
  providerId: r.provider_id,
  systemPrompt: r.system_prompt,
  role: r.role ?? '',
  temperature: r.temperature,
  tools: parseBotTools(r.tools),
  allowedRequesters: JSON.parse(r.allowed_requesters),
  projectId: r.project_id ?? null,
  skills: parseStrArr(r.skills),
  schedule: parseSchedule(r.schedule),
  enabled: r.enabled === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const botRepo = {
  list(): Bot[] {
    const rows = getDb().prepare('SELECT * FROM bots ORDER BY created_at').all() as BotRow[];
    return rows.map(rowToBot);
  },

  listEnabled(): Bot[] {
    const rows = getDb().prepare('SELECT * FROM bots WHERE enabled = 1').all() as BotRow[];
    return rows.map(rowToBot);
  },

  get(id: string): Bot | null {
    const row = getDb().prepare('SELECT * FROM bots WHERE id = ?').get(id) as BotRow | undefined;
    return row ? rowToBot(row) : null;
  },

  async create(input: BotCreate): Promise<Bot> {
    const id = randomUUID();
    const now = Date.now();
    // 模型由 Provider 决定，bot 不再存自己的 model（遗留列已由 0003 migration 删除）
    // tools 经 schema 补齐默认值后存 JSON
    const tools = botToolsSchema.parse(input.tools ?? {});
    getDb()
      .prepare(
        `INSERT INTO bots (id, name, provider_id, system_prompt, role, temperature, tools, allowed_requesters, project_id, skills, schedule, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.providerId,
        input.systemPrompt ?? '你是一个友好、简洁的中文助手。',
        input.role ?? '',
        input.temperature ?? 1.3,
        JSON.stringify(tools),
        JSON.stringify(input.allowedRequesters ?? []),
        input.projectId ?? null,
        JSON.stringify(input.skills ?? []),
        JSON.stringify(input.schedule ?? []),
        input.enabled ? 1 : 0,
        now,
        now
      );
    await setSecret(secretAccount.botDiscordToken(id), input.discordToken);
    return this.get(id)!;
  },

  async update(id: string, patch: BotUpdate): Promise<Bot | null> {
    const existing = this.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: Date.now() };
    // patch.tools 是深度可选：未提供的 section / 字段保留现有值，按 section 合并后再过 schema 补齐。
    // 逐 section 展开（而非整体浅合并），避免某 section 只传了一个字段就把同 section 其他字段清掉。
    const pt = patch.tools;
    const mergedTools = pt
      ? {
          workspaceDirs: pt.workspaceDirs ?? existing.tools.workspaceDirs,
          fs: { ...existing.tools.fs, ...(pt.fs ?? {}) },
          bash: { ...existing.tools.bash, ...(pt.bash ?? {}) },
          memory: { ...existing.tools.memory, ...(pt.memory ?? {}) },
          conversationMemory: { ...existing.tools.conversationMemory, ...(pt.conversationMemory ?? {}) },
          webSearch: { ...existing.tools.webSearch, ...(pt.webSearch ?? {}) },
          claudeCode: { ...existing.tools.claudeCode, ...(pt.claudeCode ?? {}) },
        }
      : existing.tools;
    const tools = botToolsSchema.parse(mergedTools);
    getDb()
      .prepare(
        `UPDATE bots
           SET name = ?, provider_id = ?, system_prompt = ?, role = ?, temperature = ?, tools = ?, allowed_requesters = ?, project_id = ?, skills = ?, schedule = ?, enabled = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        updated.name,
        updated.providerId,
        updated.systemPrompt,
        updated.role ?? '',
        updated.temperature,
        JSON.stringify(tools),
        JSON.stringify(updated.allowedRequesters),
        updated.projectId ?? null,
        JSON.stringify(updated.skills ?? []),
        JSON.stringify(updated.schedule ?? []),
        updated.enabled ? 1 : 0,
        updated.updatedAt,
        id
      );
    if (patch.discordToken) {
      await setSecret(secretAccount.botDiscordToken(id), patch.discordToken);
    }
    return this.get(id);
  },

  async delete(id: string): Promise<boolean> {
    const result = getDb().prepare('DELETE FROM bots WHERE id = ?').run(id);
    if (result.changes > 0) {
      await deleteSecret(secretAccount.botDiscordToken(id)).catch(() => {});
      return true;
    }
    return false;
  },

  async getDiscordToken(id: string): Promise<string | null> {
    return getSecret(secretAccount.botDiscordToken(id));
  },

  /** 某项目的所有成员 bot（project_id 匹配）。 */
  listByProject(projectId: string): Bot[] {
    const rows = getDb().prepare('SELECT * FROM bots WHERE project_id = ? ORDER BY created_at').all(projectId) as BotRow[];
    return rows.map(rowToBot);
  },
};

// ============================================================
// Project Repo（Inter-Agent 协作分组）
// ============================================================

type ProjectRow = {
  id: string;
  name: string;
  description: string;
  max_turns_per_task: number;
  max_cost_usd: number;
  workspace_dirs: string;
  created_at: number;
  updated_at: number;
};

const rowToProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  description: r.description,
  maxTurnsPerTask: r.max_turns_per_task,
  maxCostUsd: r.max_cost_usd,
  workspaceDirs: parseStrArr(r.workspace_dirs),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const projectRepo = {
  list(): Project[] {
    const rows = getDb().prepare('SELECT * FROM projects ORDER BY created_at').all() as ProjectRow[];
    return rows.map(rowToProject);
  },

  get(id: string): Project | null {
    const row = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return row ? rowToProject(row) : null;
  },

  create(input: ProjectCreate): Project {
    const id = randomUUID();
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO projects (id, name, description, max_turns_per_task, max_cost_usd, workspace_dirs, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.description ?? '',
        input.maxTurnsPerTask ?? 6,
        input.maxCostUsd ?? 2,
        JSON.stringify(input.workspaceDirs ?? []),
        now,
        now
      );
    if (input.memberBotIds) this.setMembers(id, input.memberBotIds);
    return this.get(id)!;
  },

  update(id: string, patch: ProjectUpdate): Project | null {
    const existing = this.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: Date.now() };
    getDb()
      .prepare(
        `UPDATE projects
           SET name = ?, description = ?, max_turns_per_task = ?, max_cost_usd = ?, workspace_dirs = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        updated.name,
        updated.description,
        updated.maxTurnsPerTask,
        updated.maxCostUsd,
        JSON.stringify(updated.workspaceDirs ?? []),
        updated.updatedAt,
        id
      );
    if (patch.memberBotIds) this.setMembers(id, patch.memberBotIds);
    return this.get(id);
  },

  /** 删项目：先把成员 bot 的 project_id 置 NULL（无硬 FK，应用层兜底，避免悬挂引用），再删项目行。 */
  delete(id: string): boolean {
    const db = getDb();
    db.prepare('UPDATE bots SET project_id = NULL WHERE project_id = ?').run(id);
    return db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
  },

  /**
   * 全量重设成员：把列出的 bot 的 project_id 设为本项目；本项目原有但未列出的成员被移出（project_id 置 NULL）。
   * 一个 bot 只属一个项目——把某 bot 加进本项目，自动把它从原属项目移出（UPDATE 覆盖 project_id）。
   * 返回「受影响的 bot id 集合」（新增/移出/换项目者本身）。
   * ⚠️ 该集合**不含**「被拉入 bot 原属项目里剩余的同伴」（它们的同伴名单也变了、同样需刷新）——
   *    调用方须自行在变更前捕获被拉入 bot 的原项目并补刷其成员（见 api.ts 项目路由的做法）。不要把本返回值
   *    直接喂给 restartBots 当作「该重启谁」的完整答案。
   */
  setMembers(id: string, memberBotIds: string[]): string[] {
    const db = getDb();
    const wanted = new Set(memberBotIds);
    const current = new Set(this.listMembers(id).map((b) => b.id));
    const affected = new Set<string>();
    // 移出：原成员里不在 wanted 的
    for (const botId of current) {
      if (!wanted.has(botId)) {
        db.prepare('UPDATE bots SET project_id = NULL, updated_at = ? WHERE id = ?').run(Date.now(), botId);
        affected.add(botId);
      }
    }
    // 加入/改属：wanted 里 project_id 不是本项目的（含原属别的项目的——会被覆盖移出原项目）
    for (const botId of wanted) {
      const bot = botRepo.get(botId);
      if (!bot) continue; // 跳过不存在的 id
      if (bot.projectId !== id) {
        if (bot.projectId) affected.add(/* 它原属项目的同伴稍后由上层一并刷新 */ botId);
        db.prepare('UPDATE bots SET project_id = ?, updated_at = ? WHERE id = ?').run(id, Date.now(), botId);
        affected.add(botId);
      }
    }
    return [...affected];
  },

  /** 项目当前成员（project_id 匹配）。 */
  listMembers(id: string): Bot[] {
    return botRepo.listByProject(id);
  },
};
