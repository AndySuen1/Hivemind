// 配置导出/导入：用于在机器间迁移 providers/bots（及可选密钥）。
// providers/bots 存 SQLite、密钥存 keytar，这里统一打包成一个 JSON。
// 关键：保留 id —— 既维持 bot.providerId 引用，也让密钥账户（按 id 命名）在导入后正确对应。
import type { Bot, Project, Provider } from '@hivemind/shared';
import { botToolsSchema } from '@hivemind/shared';
import { getDb } from './db.js';
import { providerRepo, botRepo, projectRepo } from './repos.js';
import { getSecret, setSecret, secretAccount } from './secrets.js';

const WEB_KEY_PROVIDERS = ['tavily', 'brave'];
const WEB_URL_PROVIDERS = ['searxng'];

export interface ProviderExport extends Provider {
  apiKey?: string;
}
export interface BotExport extends Bot {
  discordToken?: string;
}
export interface WebSearchExport {
  provider: string;
  key?: string;
  url?: string;
}

export interface ConfigBundle {
  version: 1;
  exportedAt: number;
  includesSecrets: boolean;
  providers: ProviderExport[];
  // 项目（Inter-Agent 协作分组）：含预算；导入时先于 bots upsert，使 bot.projectId 能解析到项目行。
  projects?: Project[];
  bots: BotExport[];
  webSearch?: WebSearchExport[];
}

/** 导出全部 providers/bots；includeSecrets=true 时附带 keytar 里的 API key / Discord token / web search 凭证。 */
export async function exportConfig(includeSecrets: boolean): Promise<ConfigBundle> {
  const bundle: ConfigBundle = {
    version: 1,
    exportedAt: Date.now(),
    includesSecrets: includeSecrets,
    providers: [],
    projects: projectRepo.list(),
    bots: [],
  };

  for (const p of providerRepo.list()) {
    const entry: ProviderExport = { ...p };
    if (includeSecrets) {
      const key = await providerRepo.getApiKey(p.id);
      if (key) entry.apiKey = key;
    }
    bundle.providers.push(entry);
  }

  for (const b of botRepo.list()) {
    const entry: BotExport = { ...b };
    if (includeSecrets) {
      const tok = await botRepo.getDiscordToken(b.id);
      if (tok) entry.discordToken = tok;
    }
    bundle.bots.push(entry);
  }

  if (includeSecrets) {
    const ws: WebSearchExport[] = [];
    for (const prov of WEB_KEY_PROVIDERS) {
      const k = await getSecret(secretAccount.webSearchKey(prov));
      if (k) ws.push({ provider: prov, key: k });
    }
    for (const prov of WEB_URL_PROVIDERS) {
      const u = await getSecret(secretAccount.webSearchUrl(prov));
      if (u) ws.push({ provider: prov, url: u });
    }
    if (ws.length) bundle.webSearch = ws;
  }

  return bundle;
}

export interface ImportResult {
  providers: number;
  projects: number;
  bots: number;
  secrets: number;
  errors: string[];
}

/** 导入配置：按 id upsert providers/bots（保留引用），并把携带的密钥写回 keytar。逐条容错，返回计数与错误。
 *  注意：调用方应在成功后再 botManager.syncFromDb() 让运行实例与新库对齐。 */
export async function importConfig(raw: unknown): Promise<ImportResult> {
  const data = raw as Partial<ConfigBundle> | null;
  if (!data || typeof data !== 'object' || !Array.isArray(data.providers) || !Array.isArray(data.bots)) {
    throw new Error('配置文件格式不正确（缺少 providers/bots 数组）');
  }

  const db = getDb();
  const result: ImportResult = { providers: 0, projects: 0, bots: 0, secrets: 0, errors: [] };
  const now = Date.now();

  // providers 必须先于 bots（外键 bots.provider_id → providers.id）
  const upsertProvider = db.prepare(`
    INSERT INTO providers (id, name, kind, base_url, default_model, created_at, updated_at)
    VALUES (@id, @name, @kind, @base_url, @model, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, kind = excluded.kind, base_url = excluded.base_url,
      default_model = excluded.default_model, updated_at = excluded.updated_at
  `);
  for (const p of data.providers as ProviderExport[]) {
    try {
      if (!p.id || !p.name || !p.kind || !p.model) throw new Error('字段缺失（id/name/kind/model）');
      upsertProvider.run({
        id: p.id,
        name: p.name,
        kind: p.kind,
        base_url: p.baseUrl ?? null,
        model: p.model,
        created_at: p.createdAt ?? now,
        updated_at: now,
      });
      result.providers++;
      if (p.apiKey) {
        await setSecret(secretAccount.providerApiKey(p.id), p.apiKey);
        result.secrets++;
      }
    } catch (e) {
      result.errors.push(`provider「${p.name ?? p.id}」：${(e as Error).message}`);
    }
  }

  // projects 必须先于 bots（bots.project_id 引用项目；先 upsert 项目行，bot 的 projectId 才能解析、不悬挂）
  const upsertProject = db.prepare(`
    INSERT INTO projects (id, name, description, max_turns_per_task, max_cost_usd, workspace_dirs, created_at, updated_at)
    VALUES (@id, @name, @description, @max_turns_per_task, @max_cost_usd, @workspace_dirs, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, description = excluded.description,
      max_turns_per_task = excluded.max_turns_per_task, max_cost_usd = excluded.max_cost_usd,
      workspace_dirs = excluded.workspace_dirs, updated_at = excluded.updated_at
  `);
  if (Array.isArray(data.projects)) {
    for (const pj of data.projects as Project[]) {
      try {
        if (!pj.id || !pj.name) throw new Error('字段缺失（id/name）');
        upsertProject.run({
          id: pj.id,
          name: pj.name,
          description: pj.description ?? '',
          max_turns_per_task: pj.maxTurnsPerTask ?? 6,
          max_cost_usd: pj.maxCostUsd ?? 2,
          workspace_dirs: JSON.stringify(Array.isArray(pj.workspaceDirs) ? pj.workspaceDirs : []),
          created_at: pj.createdAt ?? now,
          updated_at: now,
        });
        result.projects++;
      } catch (e) {
        result.errors.push(`project「${pj.name ?? pj.id}」：${(e as Error).message}`);
      }
    }
  }
  const projectExists = db.prepare('SELECT 1 FROM projects WHERE id = ?');

  const upsertBot = db.prepare(`
    INSERT INTO bots (id, name, provider_id, system_prompt, role, temperature, tools, allowed_requesters, project_id, skills, schedule, avatar, enabled, created_at, updated_at)
    VALUES (@id, @name, @provider_id, @system_prompt, @role, @temperature, @tools, @allowed_requesters, @project_id, @skills, @schedule, @avatar, @enabled, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, provider_id = excluded.provider_id, system_prompt = excluded.system_prompt,
      role = excluded.role, temperature = excluded.temperature, tools = excluded.tools,
      allowed_requesters = excluded.allowed_requesters,
      project_id = excluded.project_id, skills = excluded.skills, schedule = excluded.schedule,
      avatar = excluded.avatar,
      enabled = excluded.enabled, updated_at = excluded.updated_at
  `);
  for (const b of data.bots as BotExport[]) {
    try {
      if (!b.id || !b.name || !b.providerId) throw new Error('字段缺失（id/name/providerId）');
      const tools = botToolsSchema.parse(b.tools ?? {});
      // 项目不存在则置 NULL，避免把悬挂引用搬到新机器（同项目判定靠 project_id 相等，悬挂会误判同伴）
      const projectId = b.projectId && projectExists.get(b.projectId) ? b.projectId : null;
      upsertBot.run({
        id: b.id,
        name: b.name,
        provider_id: b.providerId,
        system_prompt: b.systemPrompt ?? '你是一个友好、简洁的中文助手。',
        role: b.role ?? '',
        temperature: b.temperature ?? 1.3,
        tools: JSON.stringify(tools),
        allowed_requesters: JSON.stringify(b.allowedRequesters ?? []),
        project_id: projectId,
        skills: JSON.stringify(Array.isArray(b.skills) ? b.skills : []),
        schedule: JSON.stringify(Array.isArray(b.schedule) ? b.schedule : []),
        avatar: typeof b.avatar === 'string' ? b.avatar : '',
        enabled: b.enabled ? 1 : 0,
        created_at: b.createdAt ?? now,
        updated_at: now,
      });
      result.bots++;
      if (b.discordToken) {
        await setSecret(secretAccount.botDiscordToken(b.id), b.discordToken);
        result.secrets++;
      }
    } catch (e) {
      result.errors.push(`bot「${b.name ?? b.id}」：${(e as Error).message}`);
    }
  }

  if (Array.isArray(data.webSearch)) {
    for (const ws of data.webSearch as WebSearchExport[]) {
      try {
        if (ws.key) {
          await setSecret(secretAccount.webSearchKey(ws.provider), ws.key);
          result.secrets++;
        }
        if (ws.url) {
          await setSecret(secretAccount.webSearchUrl(ws.provider), ws.url);
          result.secrets++;
        }
      } catch (e) {
        result.errors.push(`websearch「${ws.provider}」：${(e as Error).message}`);
      }
    }
  }

  return result;
}
