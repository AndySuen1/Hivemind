import { z } from 'zod';
import { tool, type Tool } from 'ai';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

const INDEX_FILE = 'MEMORY.md';

export interface MemoryMeta {
  name: string;
  description: string;
  type: MemoryType;
}

/** 注入到启用 memory 的 bot 的 system prompt：告诉它何时存、存什么、怎么存。改写自 Claude Code memory 规则。 */
export const MEMORY_SYSTEM_GUIDE = `
## 长期记忆（跨会话）

你有一套基于文件的长期记忆工具。每条记忆是一个文件，含一句话描述，分四类：
- **user**：用户是谁（角色、专长、偏好）
- **feedback**：用户对你工作方式的指导（纠正或确认的做法），写明原因
- **project**：进行中的工作、目标、约束（把相对日期转成绝对日期）
- **reference**：外部资源指针（URL、文档、工单）

**何时存**：用户透露了稳定、跨会话有用的事实时（"记住我是…"、"以后都按…"、长期偏好/项目背景）。
**不要存**：仅本次对话相关的临时信息、能从代码/历史直接得到的内容、你自己推断的琐事。
**存之前**：先用 list_memories 看是否已有相近记忆——有就用 save_memory 覆盖更新（同名即覆盖），不要造重复。
**引用之前**：记忆反映的是写入时的情况，可能过时；涉及具体文件/配置时先核实再依赖。
**回忆**：需要时先 list_memories 看索引描述，再 load_memory 读具体内容，不要凭空猜。

保存记忆用 save_memory；它会自动维护索引 MEMORY.md。name 用小写连字符（kebab-case）短标识。
`.trim();

/** 规范化记忆名为单行、可作为 frontmatter 值与文件名比较的“规范名”，同时杜绝路径穿越 */
function sanitizeName(name: string): string {
  return name.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'memory';
}

/** 描述清洗：单行 + 去掉可能截断 frontmatter 的 `---`，防止注入破坏文件/索引/system prompt */
function sanitizeDesc(desc: string): string {
  return desc.replace(/[\r\n]+/g, ' ').replace(/-{3,}/g, '—').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** 文件名 slug：NFKC 归一 + 保留拉丁/数字/中日韩文字，其余折叠为连字符，杜绝 `/` `\` `.` 穿越 */
function slugify(name: string): string {
  const s = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'mem';
}

function hash6(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 6);
}

/**
 * 文件名 = slug + 规范名短哈希。这样：同一规范名 → 同一文件（保留“同名即覆盖”语义），
 * 不同规范名几乎不碰撞（哈希区分），且非拉丁名也不再全部坍缩到同一个文件。
 * 由规范名确定，故 load/delete 用相同规范名即可定位同一文件。
 */
function fileBase(canonicalName: string): string {
  return `${slugify(canonicalName)}-${hash6(canonicalName)}`;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function memFilePath(dir: string, name: string): string {
  return join(dir, `${fileBase(sanitizeName(name))}.md`);
}

/** 极简 frontmatter 解析：只取 name/description/metadata.type */
function parseFrontmatter(content: string): MemoryMeta | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const block = m?.[1];
  if (block === undefined) return null;
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const typeRaw = block.match(/^\s*type:\s*(.+)$/m)?.[1]?.trim();
  const type = (MEMORY_TYPES as readonly string[]).includes(typeRaw ?? '')
    ? (typeRaw as MemoryType)
    : 'project';
  if (!name) return null;
  return { name, description, type };
}

function buildFileContent(meta: MemoryMeta, body: string): string {
  return `---
name: ${meta.name}
description: ${meta.description}
metadata:
  type: ${meta.type}
---

${body.trim()}
`;
}

export function listMemoryMetas(dir: string): MemoryMeta[] {
  ensureDir(dir);
  const out: MemoryMeta[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md') || f === INDEX_FILE) continue;
    try {
      const meta = parseFrontmatter(readFileSync(join(dir, f), 'utf-8'));
      if (meta) out.push(meta);
    } catch {
      // 跳过坏文件
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function rebuildIndex(dir: string): number {
  const metas = listMemoryMetas(dir);
  const lines = metas.map((m) => `- [${m.name}](${fileBase(m.name)}.md) — ${m.description} (${m.type})`);
  const content = `# MEMORY 索引\n\n${lines.join('\n')}\n`;
  writeFileSync(join(dir, INDEX_FILE), content, 'utf-8');
  return metas.length;
}

/** 列出某 bot 全部记忆条目（文件名 + frontmatter 元信息），供可观测性记忆浏览只读展示。坏文件跳过。 */
export function listMemoryEntries(dir: string): { file: string; name: string; description: string; type: MemoryType }[] {
  if (!existsSync(dir)) return [];
  const out: { file: string; name: string; description: string; type: MemoryType }[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md') || f === INDEX_FILE) continue;
    try {
      const meta = parseFrontmatter(readFileSync(join(dir, f), 'utf-8'));
      if (meta) out.push({ file: f, name: meta.name, description: meta.description, type: meta.type });
    } catch {
      // 跳过坏文件
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** 读取 MEMORY.md 内容供注入 system prompt；不存在则返回空串 */
export function loadMemoryIndexText(dir: string): string {
  try {
    const p = join(dir, INDEX_FILE);
    if (!existsSync(p)) return '';
    return readFileSync(p, 'utf-8').trim();
  } catch {
    return '';
  }
}

// ── 可编程写入入口（供 L3 自动整理 memory-consolidation.ts 使用）────────────────────────────
// 复用与 save_memory 工具完全一致的 sanitize/slug/frontmatter/索引逻辑，继承全部注入与路径防护；
// 自动整理绝不绕过这些直接写文件。

export interface MemoryUpsert {
  name: string;
  description: string;
  type: MemoryType;
  content: string;
}

/** 写入（或按规范名覆盖）一条记忆并重建索引。等价于 save_memory 工具的写入路径。 */
export function upsertMemory(dir: string, m: MemoryUpsert): void {
  ensureDir(dir);
  const canonical = sanitizeName(m.name);
  const meta: MemoryMeta = { name: canonical, description: sanitizeDesc(m.description), type: m.type };
  writeFileSync(memFilePath(dir, canonical), buildFileContent(meta, m.content), 'utf-8');
  rebuildIndex(dir);
}

/** 按 name 删除一条记忆并重建索引。返回是否删到。 */
export function deleteMemoryByName(dir: string, name: string): boolean {
  const p = memFilePath(dir, name);
  if (!existsSync(p)) return false;
  rmSync(p);
  rebuildIndex(dir);
  return true;
}

/** 读取一条记忆的完整内容（含 frontmatter）。不存在/失败→null。 */
export function loadMemoryBody(dir: string, name: string): string | null {
  try {
    const p = memFilePath(dir, name);
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 总量封顶：记忆条数超过 maxFacts 时，按文件 mtime 删最旧的若干条（LRU 淘汰），重建索引。
 * upsert 会刷新 mtime，故近期更新/写入的记忆优先保留。返回被淘汰的 name 列表。maxFacts<=0 不淘汰。
 */
export function pruneMemoriesToCap(dir: string, maxFacts: number): string[] {
  if (maxFacts <= 0) return [];
  const entries = listMemoryEntries(dir);
  if (entries.length <= maxFacts) return [];
  const withMtime = entries.map((e) => {
    let mtime = 0;
    try {
      mtime = statSync(join(dir, e.file)).mtimeMs;
    } catch {
      // 取不到时间视为最旧，优先淘汰
    }
    return { name: e.name, file: e.file, mtime };
  });
  withMtime.sort((a, b) => a.mtime - b.mtime); // 最旧在前
  const toRemove = withMtime.slice(0, withMtime.length - maxFacts);
  const removed: string[] = [];
  for (const e of toRemove) {
    try {
      rmSync(join(dir, e.file));
      removed.push(e.name);
    } catch {
      // 跳过删不掉的
    }
  }
  if (removed.length) rebuildIndex(dir);
  return removed;
}

/** 构建 5 个 memory 工具，全部作用于单个 bot 的 memoryDir */
export function buildMemoryTools(dir: string): Record<string, Tool> {
  const list_memories = tool({
    description: '列出当前所有长期记忆的 name / description / type，用于判断是否已有相关记忆或决定读哪条。',
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const metas = listMemoryMetas(dir);
        if (metas.length === 0) return '（暂无长期记忆）';
        return metas.map((m) => `- ${m.name} [${m.type}]：${m.description}`).join('\n');
      } catch (e) {
        return `错误：${(e as Error).message}`;
      }
    },
  });

  const load_memory = tool({
    description: '按 name 读取一条长期记忆的完整内容。',
    inputSchema: z.object({ name: z.string().describe('记忆的 name（kebab-case）') }),
    execute: async ({ name }) => {
      try {
        const p = memFilePath(dir, name);
        if (!existsSync(p)) return `错误：未找到记忆 "${name}"`;
        return readFileSync(p, 'utf-8');
      } catch (e) {
        return `错误：${(e as Error).message}`;
      }
    },
  });

  const save_memory = tool({
    description:
      '保存（或按 name 覆盖更新）一条长期记忆，并自动重建索引。仅在信息稳定、跨会话有用时调用。',
    inputSchema: z.object({
      name: z.string().describe('kebab-case 短标识，同名即覆盖'),
      description: z.string().describe('一句话描述（决定未来相关性判断）'),
      type: z.enum(MEMORY_TYPES).describe('user | feedback | project | reference'),
      content: z.string().describe('记忆正文'),
    }),
    execute: async ({ name, description, type, content }) => {
      try {
        ensureDir(dir);
        const canonical = sanitizeName(name);
        const meta: MemoryMeta = { name: canonical, description: sanitizeDesc(description), type };
        writeFileSync(memFilePath(dir, canonical), buildFileContent(meta, content), 'utf-8');
        const count = rebuildIndex(dir);
        return `已保存记忆 "${canonical}"（${type}），当前共 ${count} 条`;
      } catch (e) {
        return `错误：${(e as Error).message}`;
      }
    },
  });

  const update_memory_index = tool({
    description: '根据当前所有记忆文件重建索引 MEMORY.md。一般无需手动调用（save/delete 会自动重建）。',
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const count = rebuildIndex(dir);
        return `索引已重建，共 ${count} 条记忆`;
      } catch (e) {
        return `错误：${(e as Error).message}`;
      }
    },
  });

  const delete_memory = tool({
    description: '删除一条长期记忆（确认其已过时或错误时），并重建索引。',
    inputSchema: z.object({ name: z.string().describe('要删除的记忆 name') }),
    execute: async ({ name }) => {
      try {
        const p = memFilePath(dir, name);
        if (!existsSync(p)) return `错误：未找到记忆 "${name}"`;
        rmSync(p);
        const count = rebuildIndex(dir);
        return `已删除记忆 "${sanitizeName(name)}"，当前剩 ${count} 条`;
      } catch (e) {
        return `错误：${(e as Error).message}`;
      }
    },
  });

  return { list_memories, load_memory, save_memory, update_memory_index, delete_memory };
}
