// L3 触发式记忆整理（固化）：在「特定时机」（会话轮数达上限 / 会话空闲）把 L2 摘要里的稳定事实
// 合并进长期记忆文件（bot-memory/<botId>/），并去重 + 总量封顶，避免长期记忆无限膨胀。
//
// 设计要点：
//  · 不每回合跑：只在里程碑触发（见 bot-manager 的轮数触发 + consolidation loop 的空闲触发）。
//  · 一次 LLM 调用产出「结构化操作」（upsert/delete 列表），防御式解析；写入复用 memory.ts 的 upsertMemory
//    /deleteMemoryByName（继承 sanitize/slug/frontmatter/索引），绝不绕过防护直写文件。
//  · 合并去重 + 上限：指令要求合并相近条目、删除过时；applyConsolidationOps 末尾再按 mtime LRU 淘汰到 ≤ maxFacts，硬封顶。
//  · 整体 best-effort：任何失败只 console.error，绝不抛进 Discord 回复热路径。

import type { LanguageModel } from 'ai';
import { generateReply } from './llm.js';
import {
  listMemoryMetas,
  loadMemoryBody,
  upsertMemory,
  deleteMemoryByName,
  pruneMemoriesToCap,
  MEMORY_TYPES,
  type MemoryType,
} from './tools/memory.js';

function intEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}
function boolEnv(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return def;
  return !/^(0|false|no|off)$/i.test(raw.trim());
}

/** L3 整理主开关（全局）。还需 bot 的 memory.enabled（长期记忆文件工具）才会跑。 */
export const CONSOLIDATE_ENABLED = boolEnv('CONV_CONSOLIDATE_ENABLED', true);
/** 轮数触发阈值：某会话累计回合每跨过这个数，触发一次整理。 */
export const CONSOLIDATE_EVERY_TURNS = intEnv('CONV_CONSOLIDATE_EVERY_TURNS', 50);
/** 空闲触发阈值（小时）：会话空闲超过这个时长且有新内容，后台 loop 整理一次。 */
export const CONSOLIDATE_IDLE_HOURS = intEnv('CONV_CONSOLIDATE_IDLE_HOURS', 12);
/** 长期记忆条数硬上限（防膨胀）。整理末尾按 LRU 淘汰到此数。 */
export const MEMORY_MAX_FACTS = intEnv('MEMORY_MAX_FACTS', 50);
/** 单次空闲整理 sweep 每个 bot 最多处理多少会话——防止重启/积压后一次扫描齐发几十个整理 LLM 调用。剩下的下个 sweep 续跑。 */
export const CONSOLIDATE_MAX_PER_SWEEP = intEnv('CONV_CONSOLIDATE_MAX_PER_SWEEP', 5);

export type ConsolidationOp =
  | { action: 'upsert'; name: string; description: string; type: MemoryType; content: string }
  | { action: 'delete'; name: string };

export interface ConsolidationResult {
  upserted: number;
  deleted: number;
  evicted: string[];
}

const CONSOLIDATE_SYSTEM = `你是长期记忆整理器。读取【已有长期记忆】与【本会话摘要】，输出一组「记忆操作」，把其中稳定、跨会话有用的事实固化下来，并保持记忆库精简不膨胀。

记忆分四类：user（用户是谁：角色/专长/偏好）、feedback（用户对协作方式的指导，写明原因）、project（进行中的工作/目标/约束，相对日期转绝对）、reference（外部资源指针）。

规则：
- 只固化稳定、跨会话有用的事实；忽略仅本次相关的临时信息、寒暄、能从代码/历史直接得到的内容。
- 合并去重：与已有记忆相近的，用「相同 name」覆盖更新（不要造近义重复条目）。
- 删除过时：明显被新信息推翻/作废的旧记忆，用 delete。
- 控制总量：整理后长期记忆总数应不超过 ${MEMORY_MAX_FACTS} 条；接近上限时优先合并而非新增。
- 不要编造摘要中没有的事实。

只输出一个 JSON 数组，每个元素是一个操作，不要任何额外文字或代码围栏：
[
  {"action":"upsert","name":"kebab-case-名","description":"一句话描述","type":"user|feedback|project|reference","content":"记忆正文"},
  {"action":"delete","name":"要删除的名"}
]
若无需任何改动，输出 []。`;

/** 渲染「已有长期记忆」段（name + type + description，正文较长时仅截断片段，控 token）。 */
function renderExisting(dir: string): string {
  const metas = listMemoryMetas(dir);
  if (!metas.length) return '（暂无长期记忆）';
  return metas
    .map((m) => {
      const body = (loadMemoryBody(dir, m.name) ?? '').replace(/^---[\s\S]*?---\s*/, '').trim();
      const brief = body.length > 200 ? body.slice(0, 200) + '…' : body;
      return `- name: ${m.name} [${m.type}]\n  描述: ${m.description}\n  正文: ${brief}`;
    })
    .join('\n');
}

/** 构造整理用的 system + user 文本。 */
export function buildConsolidationPrompt(dir: string, summary: string): { system: string; user: string } {
  const user = `【已有长期记忆】\n${renderExisting(dir)}\n\n【本会话摘要（从中提炼可固化的稳定事实）】\n${summary || '（空）'}`;
  return { system: CONSOLIDATE_SYSTEM, user };
}

/** 防御式解析 LLM 输出为操作列表：剥代码围栏、截取 JSON 数组、逐项按类型校验，坏项跳过。失败→[]。 */
export function parseConsolidationOps(text: string): ConsolidationOp[] {
  let s = String(text ?? '').trim();
  // 剥 ```json ... ``` 或 ``` ... ``` 围栏
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
  // 截取首个 [ 到末个 ]，容忍前后散文
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(s.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: ConsolidationOp[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    if (o.action === 'delete') {
      if (typeof o.name === 'string' && o.name.trim()) out.push({ action: 'delete', name: o.name });
    } else if (o.action === 'upsert') {
      const name = typeof o.name === 'string' ? o.name.trim() : '';
      const description = typeof o.description === 'string' ? o.description : '';
      const content = typeof o.content === 'string' ? o.content : '';
      const type = (MEMORY_TYPES as readonly string[]).includes(o.type as string)
        ? (o.type as MemoryType)
        : 'project';
      if (name && content.trim()) out.push({ action: 'upsert', name, description, type, content });
    }
  }
  return out;
}

/** 应用操作：逐条 upsert/delete（走 memory.ts 防护写入），末尾按 LRU 淘汰到 ≤ maxFacts。永不抛。 */
export function applyConsolidationOps(
  dir: string,
  ops: ConsolidationOp[],
  maxFacts: number = MEMORY_MAX_FACTS
): ConsolidationResult {
  let upserted = 0;
  let deleted = 0;
  for (const op of ops) {
    try {
      if (op.action === 'upsert') {
        upsertMemory(dir, { name: op.name, description: op.description, type: op.type, content: op.content });
        upserted++;
      } else {
        if (deleteMemoryByName(dir, op.name)) deleted++;
      }
    } catch (e) {
      console.error('[consolidation] 应用操作失败（跳过该条）', op, e);
    }
  }
  let evicted: string[] = [];
  try {
    evicted = pruneMemoriesToCap(dir, maxFacts);
  } catch (e) {
    console.error('[consolidation] 上限淘汰失败（已忽略）', e);
  }
  return { upserted, deleted, evicted };
}

/**
 * 跑一次整理：读已有记忆 + 摘要 → LLM 出操作 → 应用 + 封顶。best-effort，整体 try/catch。
 * 返回 null 表示跳过/失败（空摘要、LLM 失败等）。
 */
export async function consolidate(opts: {
  model: LanguageModel;
  dir: string;
  summary: string;
  maxFacts?: number;
}): Promise<ConsolidationResult | null> {
  const summary = opts.summary?.trim();
  if (!summary) return null; // 无摘要可固化
  try {
    const { system, user } = buildConsolidationPrompt(opts.dir, summary);
    const { text } = await generateReply(opts.model, system, [], user);
    const ops = parseConsolidationOps(String(text ?? ''));
    if (!ops.length) {
      // 仍跑一次封顶（即便模型没给操作，也保证不超上限）
      const evicted = pruneMemoriesToCap(opts.dir, opts.maxFacts ?? MEMORY_MAX_FACTS);
      return { upserted: 0, deleted: 0, evicted };
    }
    return applyConsolidationOps(opts.dir, ops, opts.maxFacts ?? MEMORY_MAX_FACTS);
  } catch (e) {
    console.error('[consolidation] consolidate 失败（已忽略）', e);
    return null;
  }
}
