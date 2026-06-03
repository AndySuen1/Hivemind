import { z } from 'zod';

// ============================================================
// Provider（LLM 模型供应商配置）
// ============================================================

export const providerKindSchema = z.enum(['openai-compatible', 'anthropic-direct']);
export type ProviderKind = z.infer<typeof providerKindSchema>;

export const providerSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(50),
  kind: providerKindSchema,
  baseUrl: z.string().url().optional(),
  model: z.string().min(1),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Provider = z.infer<typeof providerSchema>;

export const providerCreateSchema = providerSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .extend({
    apiKey: z.string().min(1, 'API key 必填'),
  });
export type ProviderCreate = z.infer<typeof providerCreateSchema>;

export const providerUpdateSchema = providerSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .partial()
  .extend({
    apiKey: z.string().min(1).optional(),
  });
export type ProviderUpdate = z.infer<typeof providerUpdateSchema>;

// ============================================================
// Tools（每个 bot 自由组合的能力，Phase 1：fs / bash / memory）
// ============================================================

// bash 默认命令黑名单（与方案安全章节对齐）。子串匹配（大小写不敏感）。
export const DEFAULT_DENY_PATTERNS: string[] = [
  'rm -rf',
  'rm -r',
  'rm -f',
  'rmdir /s',
  'del /s',
  'del /q',
  'format ',
  'mkfs',
  ':(){',          // fork bomb
  'shutdown',
  'reboot',
  'curl http',
  'curl https',
  'wget ',
  'iwr ',
  'invoke-webrequest',
];

// 文件系统工具：read/write/edit/list/grep。访问范围用 botTools 顶层共享的 workspaceDirs 白名单
export const fsToolConfigSchema = z.object({
  enabled: z.boolean().default(false),
});
export type FsToolConfig = z.infer<typeof fsToolConfigSchema>;

// bash 工具：run_command。cwd 约束也用共享的 workspaceDirs；自己只配命令黑名单 + 超时
export const bashToolConfigSchema = z.object({
  enabled: z.boolean().default(false),
  denyPatterns: z.array(z.string()).default(DEFAULT_DENY_PATTERNS),
  timeoutMs: z.number().int().positive().max(600000).default(30000),
});
export type BashToolConfig = z.infer<typeof bashToolConfigSchema>;

// 长期记忆工具：list/load/save/update_index/delete，目录 bot-memory/<botId>/
export const memoryToolConfigSchema = z.object({
  enabled: z.boolean().default(false),
});
export type MemoryToolConfig = z.infer<typeof memoryToolConfigSchema>;

// 对话记忆（喂给模型的会话连续性）：L1 近期逐字窗口 / L2 滚动摘要 / L4 历史检索。
// 注意这与上面的 memoryToolConfigSchema（长期记忆文件工具）是两回事：
//  · memory.enabled 管的是 bot 能否主动用 save_memory 等工具写跨会话 .md 文件；
//  · conversationMemory 管的是「bot 还记得多久前的对话」，对所有 bot 都适用，不受 memory.enabled 约束。
export const conversationMemoryConfigSchema = z.object({
  // 近期逐字窗口的轮数（实际消息数 = ×2）。留空 → 回退全局 env BOT_HISTORY_TURNS（默认 20）。
  windowTurns: z.number().int().positive().max(100).optional(),
  // L2 滚动摘要：把滑出窗口的旧对话压成一段摘要注入 system prompt。
  summaryEnabled: z.boolean().default(true),
  // L4 历史检索：按关键词从历史消息召回相关片段注入。
  retrievalEnabled: z.boolean().default(true),
});
export type ConversationMemoryConfig = z.infer<typeof conversationMemoryConfigSchema>;

// Web Search 工具（Phase 1.5）：provider fallback 链。
// - duckduckgo：内置抓取，无需 key、无需部署（默认免费保底）
// - tavily / brave：商业 AI 搜索 API，质量好，各有免费额度，key 是全局凭证（keytar）
// - searxng：自建开源元搜索，无 key，需配实例 URL（全局 keytar 或 env SEARXNG_URL）
// 链按顺序尝试：某个 provider 无 key/失败/额度耗尽 → 自动换下一个；dailyLimit 是 per-bot 每日总次数防滥用闸。
export const webSearchProviderSchema = z.enum(['duckduckgo', 'tavily', 'brave', 'searxng']);
export type WebSearchProviderName = z.infer<typeof webSearchProviderSchema>;

// bot 端只有一个开关：开启后自动按全局优先级用「已配置 key/URL 且当天还有余量」的搜索源，
// 链顺序与每日上限都不在 bot 级配置（见 web-search.ts 的 GLOBAL_PROVIDER_ORDER / 内置防失控上限）。
export const webSearchToolConfigSchema = z.object({
  enabled: z.boolean().default(false),
});
export type WebSearchToolConfig = z.infer<typeof webSearchToolConfigSchema>;

// 需要 key 的 provider（DDG / SearXNG 不需要）
export const WEBSEARCH_PROVIDERS_NEEDING_KEY: WebSearchProviderName[] = ['tavily', 'brave'];

// Claude Code 委派工具（Phase 2）：delegate_to_claude。用 @anthropic-ai/claude-agent-sdk
// 在工作目录（= 共享 workspaceDirs）内驱动一个 claude 子进程干真代码活，复用本机订阅鉴权
// （orchestrator 入口已 delete ANTHROPIC_API_KEY，故走 Pro/Max 订阅，不传 API key）。
// 权限策略「只对真危险操作问」：只读工具自动放行，危险 Bash 命令（git push/rm/网络/装包等）、
// AskUserQuestion 反问等中转到 Discord 等用户批准（见 orchestrator 的 permission-relay）。
export const claudeCodeToolConfigSchema = z.object({
  enabled: z.boolean().default(false),
  // 单次委派允许的最大 agent 轮数，防失控 / 刷订阅额度
  maxTurns: z.number().int().positive().max(100).default(30),
  // 单次委派的挂钟超时（ms），超时中止子进程
  timeoutMs: z.number().int().positive().max(3_600_000).default(20 * 60 * 1000),
});
export type ClaudeCodeToolConfig = z.infer<typeof claudeCodeToolConfigSchema>;

// discord_push 工具（Phase 3.5）：让 bot 主动把消息推送到指定 Discord 频道，无需等用户先问
//（常用于定时播报、任务完成通知）。channelIds 是允许推送的目标频道白名单——fail-closed：
// 空白名单 = 全部拒绝。工具内只能推到白名单内的频道（调度器「直发」走另一条平台授权入口，不经此白名单）。
export const discordPushToolConfigSchema = z.object({
  enabled: z.boolean().default(false),
  channelIds: z.array(z.string()).default([]),
});
export type DiscordPushToolConfig = z.infer<typeof discordPushToolConfigSchema>;

// 注：Phase 3「Inter-Agent 协作（mention_bot）」不再是 per-bot 工具配置——改由「项目」分组驱动：
// 同一项目（bot.projectId 相同）的 bot 自动可互相 @，转交预算挂在项目上（见 projectSchema 与 inter-agent/）。

export const botToolsSchema = z.object({
  // fs / bash / claudeCode 共用的工作目录白名单：fs 的访问边界 + bash 与 Claude 子进程的起始 cwd。只填一次。
  workspaceDirs: z.array(z.string()).default([]),
  fs: fsToolConfigSchema.default({}),
  bash: bashToolConfigSchema.default({}),
  memory: memoryToolConfigSchema.default({}),
  conversationMemory: conversationMemoryConfigSchema.default({}),
  webSearch: webSearchToolConfigSchema.default({}),
  claudeCode: claudeCodeToolConfigSchema.default({}),
  discordPush: discordPushToolConfigSchema.default({}),
});
export type BotTools = z.infer<typeof botToolsSchema>;

// PATCH 用的“深度可选”工具 schema：未提供的 section / 字段保持 undefined，
// 不会被 default 填成关闭值，从而让后端按 section 与现有配置合并（见 botRepo.update）。
export const botToolsPartialSchema = z.object({
  workspaceDirs: z.array(z.string()).optional(),
  fs: fsToolConfigSchema.partial().optional(),
  bash: bashToolConfigSchema.partial().optional(),
  memory: memoryToolConfigSchema.partial().optional(),
  conversationMemory: conversationMemoryConfigSchema.partial().optional(),
  webSearch: webSearchToolConfigSchema.partial().optional(),
  claudeCode: claudeCodeToolConfigSchema.partial().optional(),
  discordPush: discordPushToolConfigSchema.partial().optional(),
});
export type BotToolsPartial = z.infer<typeof botToolsPartialSchema>;

// ============================================================
// Skill / Schedule（Phase 3.5：技能系统 + 调度器）
// ============================================================

// skill 名校验：小写 kebab，禁 '.'/'/'/'\\'，防 join(SKILL_ROOT, name) 路径穿越（前后端共用）。
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// 一条定时任务：cron 到点把 prompt 当一回合注入 bot 触发执行。
// targetChannelId 有值 → bot 的最终回复直接发该频道（平台授权，不经 discordPush 白名单）；
// 空 → 只跑一回合，发到哪由 skill 内部调 discord_push 决定。enabled=false 的项注册时跳过。
export const scheduleItemSchema = z.object({
  cron: z.string().min(1).max(120),
  prompt: z.string().min(1).max(4000),
  targetChannelId: z.string().optional(),
  enabled: z.boolean().default(true),
});
export type ScheduleItem = z.infer<typeof scheduleItemSchema>;

// ============================================================
// Bot（一个 Discord 身份 + 模型 + 工具配置）
// ============================================================

export const botSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(50),
  // Bot 只挑 Provider，模型完全由 Provider 决定
  // 想用不同模型？新建一个 Provider（API key 可重复，model 不同）
  providerId: z.string(),
  systemPrompt: z.string().default('你是一个友好、简洁的中文助手。'),
  // 岗位 / 工种（如「程序」「策划」「项目经理」）。同项目成员会在各自 system prompt 里自动看到彼此的岗位
  // （免去在 systemPrompt 里手写团队花名册）。空 = 未设定。
  role: z.string().max(50).default(''),
  // temperature 0~2，DeepSeek 官方建议：编程/数学 0.0，数据分析 1.0，对话/翻译 1.3，创作 1.5
  temperature: z.number().min(0).max(2).default(1.3),
  tools: botToolsSchema.default({}),
  allowedRequesters: z.array(z.string()).default([]),
  // 所属项目（Inter-Agent 协作分组）。null = 不在任何项目，无法跨 bot 协作。同项目的 bot 自动可互相 @。
  projectId: z.string().nullable().default(null),
  // 启用的 skill 名列表（对应共享 SKILL_ROOT/<name>/SKILL.md）。库里只存名字，内容是文件系统事实源。
  skills: z.array(z.string()).default([]),
  // 该 bot 的定时任务。改了要重启实例（调度器在 start 时按快照注册 cron）。
  schedule: z.array(scheduleItemSchema).default([]),
  enabled: z.boolean().default(false),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Bot = z.infer<typeof botSchema>;

export const botCreateSchema = botSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .partial({ systemPrompt: true, role: true, temperature: true, tools: true, allowedRequesters: true, skills: true, schedule: true, enabled: true })
  .extend({
    discordToken: z.string().min(1, 'Discord token 必填'),
  });
export type BotCreate = z.infer<typeof botCreateSchema>;

export const botUpdateSchema = botSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .partial()
  .extend({
    discordToken: z.string().min(1).optional(),
    // 覆盖默认的 full tools：用深度可选版，支持只改某个 section 而不清空其他 section
    tools: botToolsPartialSchema.optional(),
  });
export type BotUpdate = z.infer<typeof botUpdateSchema>;

// ============================================================
// Project（Inter-Agent 协作分组：把一组员工 bot 圈在一起，同项目内自动可互相 @）
// ============================================================

export const projectSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(50),
  description: z.string().max(500).default(''),
  // 转交预算（一个项目一套，成员 bot 继承）：单条协作任务的最大转交跳数 / 累计成本上限（USD，0=不限）。
  maxTurnsPerTask: z.number().int().positive().max(20).default(6),
  maxCostUsd: z.number().nonnegative().max(100).default(2),
  // 项目级工作目录白名单：本项目**全体成员可见**。每个成员实际可访问的目录 = 项目这份 + 它自己 tools.workspaceDirs。
  // fs / bash / claudeCode 的访问边界都取这个并集。空 = 项目不提供共享目录（成员仍可各自配自己的）。
  workspaceDirs: z.array(z.string()).default([]),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Project = z.infer<typeof projectSchema>;

// memberBotIds 是「虚拟」字段：不存在 projects 表，而是把每个列出的 bot 的 project_id 设为本项目
//（全量重设——未列出的现有成员会被移出）。由 projectRepo 落到 bots.project_id。
export const projectCreateSchema = projectSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .partial({ description: true, maxTurnsPerTask: true, maxCostUsd: true, workspaceDirs: true })
  .extend({ memberBotIds: z.array(z.string()).optional() });
export type ProjectCreate = z.infer<typeof projectCreateSchema>;

export const projectUpdateSchema = projectSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .partial()
  .extend({ memberBotIds: z.array(z.string()).optional() });
export type ProjectUpdate = z.infer<typeof projectUpdateSchema>;

// ============================================================
// API 响应包装
// ============================================================

export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = { ok: false; error: string };
export type ApiResult<T> = ApiOk<T> | ApiErr;

// ============================================================
// Bot 运行时状态（不入库，BotManager 内存维护）
// ============================================================

export type BotRuntimeStatus = 'offline' | 'connecting' | 'online' | 'error';

export interface BotRuntimeInfo {
  botId: string;
  status: BotRuntimeStatus;
  errorMessage?: string;
  connectedAt?: number;
}

// ============================================================
// 可观测性（Observability）数据契约
// ------------------------------------------------------------
// orchestrator 的 recorder.ts 落库并经 EventEmitter 广播，dashboard（P6）与查询 API（P4）/
// SSE（P5）共用这组「面向前端」的 camelCase 类型。DB 行是 snake_case（见 migration 0005），
// repo/recorder 负责映射；input/output 在库里是 JSON 字符串，读出后解析为 unknown。
// ============================================================

// 统一时间线事件类型（events.type）。delegate_* 是 Claude Code 委派的开始/单步/结束；
// permission_* 是危险操作中转 Discord 的请求与裁决；ask_question 是 AskUserQuestion 反问。
export const observEventTypeSchema = z.enum([
  'tool_call',          // 本地工具调用（fs/bash/memory/web-search）
  'delegate_start',     // delegate_to_claude 开始
  'delegate_step',      // 委派过程中 Claude 的一步（tool_use），UI 默认折叠
  'delegate_end',       // 委派结束（含 numTurns/costUsd/rateLimited）
  'permission_request', // Claude 请求危险操作授权
  'permission_decision',// 用户在 Discord 的裁决（allow/deny/timeout/aborted）
  'ask_question',       // AskUserQuestion 反问及收集到的答案
  'mention',            // Inter-Agent 协作：一次跨 bot 转交（forwarded/received/paused_*/denied/not_found…）
  'schedule_trigger',   // 调度器/手动触发的一次合成回合开始（Phase 3.5）
  'error',              // 运行错误
  'rate_limit',         // 订阅限流事件
]);
export type ObservEventType = z.infer<typeof observEventTypeSchema>;

// Inter-Agent 协作任务（一条 @ 链）的状态。active 进行中；done 自然结束（链尾 bot 直接回复未再转交）；
// paused_* 触达某护栏被暂停、等发起人在 Discord 裁决「继续/终止」；terminated 被发起人终止。
// 仅在 orchestrator 内存（inter-agent/router.ts 的 taskRegistry）维护，目前不落库——
// 跨 bot 血缘靠 events 里 type='mention' 事件的 input.taskId 关联（v2 若要 dashboard 查询再建表）。
export type MentionTaskState =
  | 'active'
  | 'paused_turns'
  | 'paused_budget'
  | 'paused_loop'
  | 'paused_global'
  | 'terminated'
  | 'done';

// 一回合（run）的状态：running 进行中；ok 正常完成；error 出错；aborted 被取消/超时。
export type ObservRunStatus = 'running' | 'ok' | 'error' | 'aborted';

export type ObservMessageRole = 'user' | 'assistant';

// 一个会话 = 某 bot 在某频道的持续对话（按 botId+channelId 唯一）。
export interface ObservSession {
  id: string;
  botId: string;
  channelId: string;
  channelType?: string; // 'dm' | 'guild-text' 等，best-effort
  channelName?: string;
  guildId?: string;     // DM 无 guild
  title?: string;       // 可选摘要/首条消息预览
  createdAt: number;
  lastActiveAt: number;
}

// token 用量（AI SDK v5 totalUsage 形状，字段都可选——不同 provider/版本可能缺省）。
export interface ObservUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

// 一回合 = 一条用户消息触发的一次处理（执行追踪的基本单位）。
export interface ObservRun {
  id: string;
  sessionId: string;
  botId: string;
  requesterId?: string;     // 触发者 Discord user id
  status: ObservRunStatus;
  userMessageId?: string;   // 关联触发该回合的 user 消息行 id
  finishReason?: string;    // generateText 的 finishReason：stop/tool-calls/length…
  toolCallCount: number;
  usage?: ObservUsage;      // token 用量（AI SDK totalUsage），由 usage_json 解析
  error?: string;
  startedAt: number;
  endedAt?: number;
}

// 聊天消息（user 提问 / assistant 最终回答）。content 已脱敏 + 截断。
export interface ObservMessage {
  id: string;
  sessionId: string;
  runId?: string;
  botId: string;
  role: ObservMessageRole;
  authorId?: string;
  authorName?: string;
  content: string;
  truncated: boolean;
  createdAt: number;
}

// 时间线事件。input/output 已脱敏 + 截断（8KB）；按 (runId, seq) 排序。
export interface ObservEvent {
  id: string;
  runId: string;
  sessionId: string;
  botId: string;
  seq: number;
  type: ObservEventType;
  toolName?: string;
  label?: string;
  status?: string;        // ok/error/allow/deny/timeout/pending…（按 type 不同含义）
  input?: unknown;        // 由 input_json 解析；截断后可能为原始字符串
  output?: unknown;       // 由 output_json 解析
  durationMs?: number;
  parentEventId?: string; // delegate_step 挂在其 delegate_start 之下
  createdAt: number;
}

// recorder EventEmitter 广播载荷（P5 SSE 据此实时推送，按 kind/botId/sessionId/runId 过滤）。
export type ObservRecord =
  | { kind: 'session'; row: ObservSession }
  | { kind: 'run'; row: ObservRun }
  | { kind: 'message'; row: ObservMessage }
  | { kind: 'event'; row: ObservEvent };

// ============================================================
// 查询 API（P4）：游标分页 + 记忆浏览 + Live 总览
// ============================================================

// 复合游标（sessions/runs/messages 时间倒序翻页用）。单值时间戳游标在「同一毫秒有多条记录恰好
// 跨越翻页边界」时可能漏返回几条；改用 (时间戳, id) 复合游标 + 严格不等的元组比较，保证不重不漏。
// events 按 seq 升序翻页，seq 在回合内唯一，仍用 number 游标即可，无需复合。
export interface ObservCursor {
  ts: number; // 列表排序时间戳：sessions=lastActiveAt / runs=startedAt / messages=createdAt
  id: string; // 同毫秒去歧义的主键（与 ORDER BY ..., id DESC 对齐）
}

// 游标分页结果。C 为「下一页游标」类型（取下一页时回传给查询参数）：
//  - sessions/runs/messages：C = ObservCursor，ts→`before`、id→`beforeId`；
//  - events：C = number（末项 seq），作为下一页的 `after`。
// nextCursor 为 null 表示没有更多。
export interface ObservPage<T, C = number> {
  items: T[];
  nextCursor: C | null;
}

// 记忆浏览（只读）：一条记忆 = 一个 .md 文件（仿 Claude Code frontmatter 格式）。
export interface ObservMemoryEntry {
  file: string;        // 文件名（请求文件内容时作为 ?path= 传回）
  name: string;
  description: string;
  type: string;        // user | feedback | project | reference（坏数据兜底 project）
}

export interface ObservMemoryList {
  dir: string;         // 该 bot 的记忆目录绝对路径
  indexText: string;   // MEMORY.md 原文（不存在则空串）
  memories: ObservMemoryEntry[];
}

// Live 总览：每个 bot 的运行时状态 + 可观测性聚合计数。
export interface LiveOverviewBot {
  botId: string;
  name: string;
  status: BotRuntimeStatus;
  errorMessage?: string;
  connectedAt?: number;
  sessions: number;
  runs: number;
  runningRuns: number;       // 当前 status='running' 的回合数
  lastActiveAt: number | null;
}

export interface LiveOverview {
  ts: number;
  bots: LiveOverviewBot[];
}

// ============================================================
// Skill / Schedule API 响应（Phase 3.5）
// ============================================================

// 共享 skill 概览（列表用）：name + frontmatter 的 description。
export interface SkillSummary {
  name: string;
  description: string;
  updatedAt?: number; // SKILL.md 文件 mtime（best-effort）
}

// 单个 skill 详情：概览 + SKILL.md 全文（含 frontmatter）。
export interface SkillDetail extends SkillSummary {
  content: string;
}

// 调度面板：把所有 bot 的 schedule 扁平化，每行带归属 bot 与在线状态。
export interface BotScheduleEntry {
  botId: string;
  botName: string;
  index: number;        // 在该 bot schedule 数组中的下标（手动触发用）
  cron: string;
  prompt: string;
  targetChannelId?: string;
  enabled: boolean;
  botOnline: boolean;   // 离线时手动触发按钮禁用
}

// 手动触发/测试运行的确认（fire-and-forget：过程实时进 recorder，去监控页看结果）。
export interface ScheduleRunAck {
  botId: string;
  status: 'triggered' | 'offline' | 'error';
  message?: string;
  runId?: string;
  sessionId?: string;
}
