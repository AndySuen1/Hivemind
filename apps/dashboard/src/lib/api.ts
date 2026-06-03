import type {
  Bot,
  BotCreate,
  BotRuntimeInfo,
  BotUpdate,
  Project,
  ProjectCreate,
  ProjectUpdate,
  Provider,
  ProviderCreate,
  ProviderUpdate,
  ObservSession,
  ObservRun,
  ObservMessage,
  ObservEvent,
  ObservPage,
  ObservCursor,
  ObservMemoryList,
  LiveOverview,
  SkillSummary,
  SkillDetail,
  BotScheduleEntry,
  ScheduleRunAck,
} from '@hivemind/shared';

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://127.0.0.1:3001';

type ApiOk<T> = { ok: true; data: T };
type ApiErr = { ok: false; error: string };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  // 只在确实有 body 时才加 Content-Type，否则 Fastify 5 会拒绝空 JSON body
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (init?.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });
  const body = (await res.json()) as ApiOk<T> | ApiErr;
  if (!body.ok) throw new Error(body.error);
  return body.data;
}

// ============================================================
// Providers
// ============================================================
export const providersApi = {
  list: () => call<Provider[]>('/api/providers'),
  get: (id: string) => call<Provider>(`/api/providers/${id}`),
  create: (input: ProviderCreate) =>
    call<Provider>('/api/providers', { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string, patch: ProviderUpdate) =>
    call<Provider>(`/api/providers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  delete: (id: string) => call<{ id: string }>(`/api/providers/${id}`, { method: 'DELETE' }),
  test: (id: string) => call<{ reply: string; usage: unknown }>(`/api/providers/${id}/test`, { method: 'POST' }),
};

// ============================================================
// Bots
// ============================================================
export type BotWithRuntime = Bot & { runtime: BotRuntimeInfo };

export const botsApi = {
  list: () => call<BotWithRuntime[]>('/api/bots'),
  get: (id: string) => call<BotWithRuntime>(`/api/bots/${id}`),
  create: (input: BotCreate) =>
    call<BotWithRuntime>('/api/bots', { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string, patch: BotUpdate) =>
    call<BotWithRuntime>(`/api/bots/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  delete: (id: string) => call<{ id: string }>(`/api/bots/${id}`, { method: 'DELETE' }),
  start: (id: string) => call<BotRuntimeInfo>(`/api/bots/${id}/start`, { method: 'POST' }),
  stop: (id: string) => call<BotRuntimeInfo>(`/api/bots/${id}/stop`, { method: 'POST' }),
};

// ============================================================
// Projects（Inter-Agent 协作分组）
// ============================================================
export type ProjectWithMembers = Project & { memberBotIds: string[] };

export const projectsApi = {
  list: () => call<ProjectWithMembers[]>('/api/projects'),
  get: (id: string) => call<ProjectWithMembers>(`/api/projects/${id}`),
  create: (input: ProjectCreate) =>
    call<ProjectWithMembers>('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string, patch: ProjectUpdate) =>
    call<ProjectWithMembers>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  delete: (id: string) => call<{ id: string }>(`/api/projects/${id}`, { method: 'DELETE' }),
};

// ============================================================
// Skills + 调度（Phase 3.5）
// ============================================================
export const skillsApi = {
  list: () => call<SkillSummary[]>('/api/skills'),
  get: (name: string) => call<SkillDetail>(`/api/skills/${encodeURIComponent(name)}`),
  create: (input: { name: string; content?: string }) =>
    call<SkillDetail>('/api/skills', { method: 'POST', body: JSON.stringify(input) }),
  save: (name: string, content: string) =>
    call<SkillSummary>(`/api/skills/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ content }) }),
  delete: (name: string) => call<{ name: string }>(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }),
};

export const schedulesApi = {
  list: () => call<BotScheduleEntry[]>('/api/schedules'),
  run: (botId: string, index: number) =>
    call<ScheduleRunAck>(`/api/bots/${botId}/schedules/${index}/run`, { method: 'POST' }),
  triggerBot: (botId: string, prompt: string) =>
    call<ScheduleRunAck>(`/api/bots/${botId}/trigger`, { method: 'POST', body: JSON.stringify({ prompt }) }),
};

// ============================================================
// 可观测性查询（P4 路由）
// ============================================================
function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const observApi = {
  sessions: (botId: string, opts: { before?: number; beforeId?: string; limit?: number } = {}) =>
    call<ObservPage<ObservSession, ObservCursor>>(`/api/bots/${botId}/sessions${qs(opts)}`),
  messages: (sessionId: string, opts: { before?: number; beforeId?: string; limit?: number } = {}) =>
    call<ObservPage<ObservMessage, ObservCursor>>(`/api/sessions/${sessionId}/messages${qs(opts)}`),
  runs: (sessionId: string, opts: { before?: number; beforeId?: string; limit?: number } = {}) =>
    call<ObservPage<ObservRun, ObservCursor>>(`/api/sessions/${sessionId}/runs${qs(opts)}`),
  events: (runId: string, opts: { after?: number; limit?: number } = {}) =>
    call<ObservPage<ObservEvent>>(`/api/runs/${runId}/events${qs(opts)}`),
  memory: (botId: string) => call<ObservMemoryList>(`/api/bots/${botId}/memory`),
  memoryFile: (botId: string, path: string) =>
    call<{ path: string; content: string }>(`/api/bots/${botId}/memory/file?path=${encodeURIComponent(path)}`),
  liveOverview: () => call<LiveOverview>('/api/live/overview'),

  // P7 清理（写）
  deleteSession: (sessionId: string) =>
    call<{ id: string; deleted: boolean }>(`/api/sessions/${sessionId}`, { method: 'DELETE' }),
  deleteBotHistory: (botId: string) =>
    call<{ botId: string; sessions: number }>(`/api/bots/${botId}/history`, { method: 'DELETE' }),
  runRetention: () =>
    call<{ days: number; sessions: number }>(`/api/observ/retention/run`, { method: 'POST' }),
};

// ============================================================
// Web Search 全局凭证
// ============================================================
export const webSearchApi = {
  status: (provider: string) =>
    call<{ provider: string; configured: boolean; fromEnv: boolean; builtin?: boolean }>(
      `/api/websearch/${provider}/status`
    ),
  save: (provider: string, body: { apiKey?: string; url?: string }) =>
    call<{ provider: string; configured: boolean }>(`/api/websearch/${provider}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  remove: (provider: string) =>
    call<{ provider: string; configured: boolean }>(`/api/websearch/${provider}`, { method: 'DELETE' }),
  test: (provider: string) =>
    call<{ sample: string }>(`/api/websearch/${provider}/test`, { method: 'POST' }),
};

// ============================================================
// 配置导出/导入（机器间迁移）
// ============================================================
export interface ConfigBundle {
  version: number;
  exportedAt: number;
  includesSecrets: boolean;
  providers: unknown[];
  projects?: unknown[];
  bots: unknown[];
  webSearch?: unknown[];
}
export interface ImportResult {
  providers: number;
  projects: number;
  bots: number;
  secrets: number;
  errors: string[];
}

export const configApi = {
  export: (secrets: boolean) =>
    call<ConfigBundle>(`/api/config/export${secrets ? '?secrets=true' : ''}`),
  import: (bundle: unknown) =>
    call<ImportResult>('/api/config/import', { method: 'POST', body: JSON.stringify(bundle) }),
};
