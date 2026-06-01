import { randomUUID } from 'node:crypto';
import type { Bot, BotCreate, BotUpdate, Provider, ProviderCreate, ProviderUpdate } from '@discord-agent-hub/shared';
import {
  botToolsSchema,
  fsToolConfigSchema,
  bashToolConfigSchema,
  memoryToolConfigSchema,
  webSearchToolConfigSchema,
  claudeCodeToolConfigSchema,
} from '@discord-agent-hub/shared';
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
  temperature: number;
  tools: string;
  allowed_requesters: string;
  enabled: number;
  created_at: number;
  updated_at: number;
};

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
    webSearch: section(webSearchToolConfigSchema, o.webSearch),
    claudeCode: section(claudeCodeToolConfigSchema, o.claudeCode),
  };
}

const rowToBot = (r: BotRow): Bot => ({
  id: r.id,
  name: r.name,
  providerId: r.provider_id,
  systemPrompt: r.system_prompt,
  temperature: r.temperature,
  tools: parseBotTools(r.tools),
  allowedRequesters: JSON.parse(r.allowed_requesters),
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
        `INSERT INTO bots (id, name, provider_id, system_prompt, temperature, tools, allowed_requesters, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.providerId,
        input.systemPrompt ?? '你是一个友好、简洁的中文助手。',
        input.temperature ?? 1.3,
        JSON.stringify(tools),
        JSON.stringify(input.allowedRequesters ?? []),
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
          webSearch: { ...existing.tools.webSearch, ...(pt.webSearch ?? {}) },
          claudeCode: { ...existing.tools.claudeCode, ...(pt.claudeCode ?? {}) },
        }
      : existing.tools;
    const tools = botToolsSchema.parse(mergedTools);
    getDb()
      .prepare(
        `UPDATE bots
           SET name = ?, provider_id = ?, system_prompt = ?, temperature = ?, tools = ?, allowed_requesters = ?, enabled = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        updated.name,
        updated.providerId,
        updated.systemPrompt,
        updated.temperature,
        JSON.stringify(tools),
        JSON.stringify(updated.allowedRequesters),
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
};
