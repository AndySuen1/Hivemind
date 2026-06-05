// Bot 配置表单的「无 JSX 状态模块」：表单状态类型 + 默认值 + 由 Bot 反序列化 + 序列化成 create/update 入参。
// 由新建弹窗（NewBotModal）与详情页配置区（BotConfigForm/BotConfigSection）共用，保证 create/update 契约一致。

import type { Bot, BotCreate, BotTools, BotUpdate, ScheduleItem } from '@hivemind/shared';
import { DEFAULT_DENY_PATTERNS } from '@hivemind/shared';

/** 换行串 → 去空白去空行的数组。 */
export const linesToArr = (s: string): string[] => s.split('\n').map((x) => x.trim()).filter(Boolean);

/** 逗号/空格/换行分隔串 → 去空数组（用于 allowlist）。 */
const parseAllowed = (raw: string): string[] => raw.split(/[,\s\n]+/).map((x) => x.trim()).filter(Boolean);

/** 丢掉 cron / prompt 为空的 schedule 行。 */
const cleanSchedule = (schedule: ScheduleItem[]): ScheduleItem[] =>
  schedule.filter((r) => r.cron.trim() && r.prompt.trim());

export interface BotFormState {
  name: string;
  providerId: string;
  systemPrompt: string;
  role: string;
  temperature: number;
  allowedRaw: string;
  enabled: boolean;
  discordToken: string;
  avatar: string;
  // 工具配置（扁平到顶层，提交时由 buildTools 拼回嵌套结构）
  wsDirs: string;
  fsEnabled: boolean;
  bashEnabled: boolean;
  bashDeny: string;
  bashTimeout: number;
  memEnabled: boolean;
  webEnabled: boolean;
  claudeEnabled: boolean;
  claudeMaxTurns: number;
  claudeTimeoutMin: number;
  convWindow: number;
  convSummary: boolean;
  convRetrieval: boolean;
  projectId: string;
  skills: string[];
  schedule: ScheduleItem[];
  pushEnabled: boolean;
  pushChannels: string;
}

const DEFAULT_PROMPT = '你是一个友好、简洁的中文助手。';

/** 新建用的空白默认值（provider 默认取第一个）。 */
export function emptyBotFormState(firstProviderId = ''): BotFormState {
  return {
    name: '',
    providerId: firstProviderId,
    systemPrompt: DEFAULT_PROMPT,
    role: '',
    temperature: 1.3,
    allowedRaw: '',
    enabled: true,
    discordToken: '',
    avatar: '',
    wsDirs: '',
    fsEnabled: false,
    bashEnabled: false,
    bashDeny: DEFAULT_DENY_PATTERNS.join('\n'),
    bashTimeout: 30000,
    memEnabled: false,
    webEnabled: false,
    claudeEnabled: false,
    claudeMaxTurns: 30,
    claudeTimeoutMin: 20,
    convWindow: 0,
    convSummary: true,
    convRetrieval: true,
    projectId: '',
    skills: [],
    schedule: [],
    pushEnabled: false,
    pushChannels: '',
  };
}

/** 由已存在的 Bot 反序列化成表单状态（编辑用）。discordToken 恒为空串（密钥从不回传）。 */
export function botToFormState(bot: Bot, firstProviderId = ''): BotFormState {
  const t = bot.tools;
  return {
    name: bot.name ?? '',
    providerId: bot.providerId ?? firstProviderId,
    systemPrompt: bot.systemPrompt ?? DEFAULT_PROMPT,
    role: bot.role ?? '',
    temperature: bot.temperature ?? 1.3,
    allowedRaw: (bot.allowedRequesters ?? []).join('\n'),
    enabled: bot.enabled,
    discordToken: '',
    avatar: bot.avatar ?? '',
    wsDirs: t.workspaceDirs.join('\n'),
    fsEnabled: t.fs.enabled,
    bashEnabled: t.bash.enabled,
    bashDeny: (t.bash.denyPatterns ?? DEFAULT_DENY_PATTERNS).join('\n'),
    bashTimeout: t.bash.timeoutMs ?? 30000,
    memEnabled: t.memory.enabled,
    webEnabled: t.webSearch.enabled,
    claudeEnabled: t.claudeCode.enabled,
    claudeMaxTurns: t.claudeCode.maxTurns ?? 30,
    claudeTimeoutMin: Math.round((t.claudeCode.timeoutMs ?? 1_200_000) / 60000),
    convWindow: t.conversationMemory?.windowTurns ?? 0,
    convSummary: t.conversationMemory?.summaryEnabled ?? true,
    convRetrieval: t.conversationMemory?.retrievalEnabled ?? true,
    projectId: bot.projectId ?? '',
    skills: bot.skills ?? [],
    schedule: bot.schedule ?? [],
    pushEnabled: t.discordPush?.enabled ?? false,
    pushChannels: (t.discordPush?.channelIds ?? []).join('\n'),
  };
}

/** 把扁平状态拼回嵌套 tools 结构。 */
export function buildTools(s: BotFormState): BotTools {
  return {
    workspaceDirs: linesToArr(s.wsDirs),
    fs: { enabled: s.fsEnabled },
    bash: { enabled: s.bashEnabled, denyPatterns: linesToArr(s.bashDeny), timeoutMs: s.bashTimeout },
    memory: { enabled: s.memEnabled },
    conversationMemory: {
      summaryEnabled: s.convSummary,
      retrievalEnabled: s.convRetrieval,
      ...(s.convWindow > 0 ? { windowTurns: s.convWindow } : {}),
    },
    webSearch: { enabled: s.webEnabled },
    claudeCode: {
      enabled: s.claudeEnabled,
      maxTurns: s.claudeMaxTurns,
      timeoutMs: Math.max(1, s.claudeTimeoutMin) * 60000,
    },
    discordPush: { enabled: s.pushEnabled, channelIds: linesToArr(s.pushChannels) },
  };
}

/** 序列化成创建入参（含 token，token 缺失即抛）。 */
export function buildBotCreate(s: BotFormState): BotCreate {
  if (!s.discordToken) throw new Error('新建时 Discord Token 必填');
  return {
    name: s.name,
    providerId: s.providerId,
    systemPrompt: s.systemPrompt,
    role: s.role,
    temperature: s.temperature,
    tools: buildTools(s),
    projectId: s.projectId || null,
    allowedRequesters: parseAllowed(s.allowedRaw),
    skills: s.skills,
    schedule: cleanSchedule(s.schedule),
    avatar: s.avatar,
    enabled: s.enabled,
    discordToken: s.discordToken,
  };
}

/**
 * 序列化成「完整更新补丁」——含所有可编辑字段、**不含 discordToken**（密钥只写不回显，单独处理）。
 * 也不含 enabled（启停由详情页 header 的电源开关单独管）。
 * 字段构造顺序固定 → 可直接用 JSON.stringify 做相等/差异比较（见 diffBotUpdate）。
 */
export function buildBotUpdateFull(s: BotFormState): BotUpdate {
  return {
    name: s.name,
    providerId: s.providerId,
    systemPrompt: s.systemPrompt,
    role: s.role,
    temperature: s.temperature,
    tools: buildTools(s),
    allowedRequesters: parseAllowed(s.allowedRaw),
    projectId: s.projectId || null,
    skills: s.skills,
    schedule: cleanSchedule(s.schedule),
    avatar: s.avatar,
  };
}

/** 完整补丁 + token（token 仅在非空时附带，留空 = 保持原值）。 */
export function buildBotUpdate(s: BotFormState): BotUpdate {
  const patch = buildBotUpdateFull(s);
  if (s.discordToken) patch.discordToken = s.discordToken;
  return patch;
}

// —— 自动保存 / 重启分类 ——————————————————————————————————————————————
//
// orchestrator api.ts 的 needsRestart：除 avatar 外，所有可编辑字段改了都要重启本 bot 实例
// 才能生效（systemPrompt/role/temperature/tools/allowedRequesters/providerId/name/skills/
// schedule/projectId/discordToken）。故唯一「免重启、可即时生效」的字段是 avatar。
// ⚠️ 改了 orchestrator 的 needsRestart 列表，这里要同步。
const RESTART_EXEMPT_FIELDS = new Set<keyof BotUpdate>(['avatar']);

/** keyof BotUpdate 是否改了「无需重启实例」即可生效。 */
export const isRestartExemptField = (k: keyof BotUpdate): boolean => RESTART_EXEMPT_FIELDS.has(k);

const jsonEq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface BotUpdateDiff {
  /** 仅含发生变化的字段（不含 token）；可直接当 PATCH body。 */
  patch: BotUpdate;
  /** 变化字段的 keys（不含 token）。 */
  changedKeys: (keyof BotUpdate)[];
  /** 有「免重启」字段变化（目前仅 avatar）。 */
  exemptChanged: boolean;
  /** 有「需重启」字段变化。 */
  restartChanged: boolean;
}

/**
 * 算出把 `base` 改成 `curr` 需要的最小补丁（不含 token），并按是否需重启分类。
 * 对每个字段用 JSON 相等比较：tools 整体作为一个嵌套对象比较（全有或全无），数组按顺序逐项比较。
 */
export function diffBotUpdate(curr: BotFormState, base: BotFormState): BotUpdateDiff {
  const a = buildBotUpdateFull(curr);
  const b = buildBotUpdateFull(base);
  const patch: BotUpdate = {};
  const changedKeys: (keyof BotUpdate)[] = [];
  let exemptChanged = false;
  let restartChanged = false;
  for (const k of Object.keys(a) as (keyof BotUpdate)[]) {
    if (jsonEq(a[k], b[k])) continue;
    (patch as Record<string, unknown>)[k] = a[k];
    changedKeys.push(k);
    if (RESTART_EXEMPT_FIELDS.has(k)) exemptChanged = true;
    else restartChanged = true;
  }
  return { patch, changedKeys, exemptChanged, restartChanged };
}
