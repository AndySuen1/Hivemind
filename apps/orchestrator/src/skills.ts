// Skill 系统（Phase 3.5）：技能 = 「用工具组合完成某类任务的说明书」。
// 事实源 = 文件系统：共享目录 SKILL_ROOT/<name>/SKILL.md（YAML frontmatter 存 name/description）。
// bot 配置里只存「启用了哪些 skill 名」(bots.skills)，启动时把启用 skill 的 SKILL.md 拼进 system prompt。
// skill 是平台运维者放入的受信资产（信任级同 systemPrompt），直接当指令注入，不套「参考数据」外壳。
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_NAME_RE } from '@hivemind/shared';
import type { SkillSummary, SkillDetail } from '@hivemind/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 默认在仓库父目录下的 skills（src 上溯 4 层到该根目录；与 bot-memory 同级）。env SKILL_ROOT 可覆盖。
export const SKILL_ROOT =
  process.env.SKILL_ROOT ?? join(__dirname, '..', '..', '..', '..', 'skills');

const SKILL_FILE = 'SKILL.md';

export interface SkillMeta {
  name: string;
  description: string;
  dir: string;         // 该 skill 的绝对目录（注入 prompt 时告诉 bot「脚本/数据在此目录，用 fs/bash 按需读」）
  updatedAt?: number;  // SKILL.md 文件 mtime（best-effort）
}

/** 校验 skill 名（小写 kebab，防路径穿越）；非法即抛。name 会拼进 join(SKILL_ROOT, name)。 */
function assertSkillName(name: string): void {
  if (!SKILL_NAME_RE.test(name)) throw new Error(`非法 skill 名（路径穿越防护）: ${name}`);
}

function skillDir(name: string): string {
  assertSkillName(name);
  return join(SKILL_ROOT, name);
}

function skillFilePath(name: string): string {
  return join(skillDir(name), SKILL_FILE);
}

/** 描述清洗：单行 + 去掉可能截断 frontmatter 的 `---`，防注入破坏 prompt（仿 memory.ts sanitizeDesc）。 */
function sanitizeDesc(desc: string): string {
  return desc.replace(/[\r\n]+/g, ' ').replace(/-{3,}/g, '—').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** 极简 frontmatter 解析：只取 name/description（仿 memory.ts parseFrontmatter）。无 frontmatter → 空。 */
export function parseSkillFrontmatter(content: string): { name?: string; description: string } {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const block = m?.[1];
  if (block === undefined) return { description: '' };
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = sanitizeDesc(block.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '');
  return { name, description };
}

/** 列出 SKILL_ROOT 下所有合法 skill（目录含 SKILL.md）。坏目录/非法名跳过，绝不抛。 */
export function listSkills(): SkillMeta[] {
  let entries: string[];
  try {
    if (!existsSync(SKILL_ROOT)) return [];
    entries = readdirSync(SKILL_ROOT);
  } catch {
    return [];
  }
  const out: SkillMeta[] = [];
  for (const name of entries) {
    if (!SKILL_NAME_RE.test(name)) continue; // 跳过非法目录名
    const dir = join(SKILL_ROOT, name);
    const file = join(dir, SKILL_FILE);
    try {
      if (!statSync(dir).isDirectory() || !existsSync(file)) continue;
      const content = readFileSync(file, 'utf-8');
      const fm = parseSkillFrontmatter(content);
      out.push({ name, description: fm.description, dir, updatedAt: statSync(file).mtimeMs });
    } catch {
      // 跳过坏 skill
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** 列表概览（API GET /api/skills 用）：丢弃绝对路径 dir。 */
export function listSkillSummaries(): SkillSummary[] {
  return listSkills().map((s) => ({ name: s.name, description: s.description, updatedAt: s.updatedAt }));
}

/** 读取一个 skill 的 SKILL.md 原文（含 frontmatter）。非法名/不存在 → null。 */
export function loadSkillMarkdown(name: string): string | null {
  try {
    const p = skillFilePath(name);
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

/** 单个 skill 详情（API GET /api/skills/:name 用）。不存在 → null。 */
export function getSkillDetail(name: string): SkillDetail | null {
  const content = loadSkillMarkdown(name);
  if (content === null) return null;
  const fm = parseSkillFrontmatter(content);
  let updatedAt: number | undefined;
  try {
    updatedAt = statSync(skillFilePath(name)).mtimeMs;
  } catch {
    /* best-effort */
  }
  return { name, description: fm.description, content, updatedAt };
}

export function skillExists(name: string): boolean {
  try {
    return existsSync(skillFilePath(name));
  } catch {
    return false;
  }
}

/** 新建 skill：目录已存在则抛。content 缺省用模板。返回详情。 */
export function createSkill(name: string, content?: string): SkillDetail {
  const dir = skillDir(name);
  if (existsSync(dir)) throw new Error(`skill "${name}" 已存在`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SKILL_FILE), content ?? defaultSkillTemplate(name), 'utf-8');
  return getSkillDetail(name)!;
}

/** 保存（覆盖写）已存在 skill 的 SKILL.md。不存在则抛。返回概览。 */
export function writeSkill(name: string, content: string): SkillSummary {
  if (!skillExists(name)) throw new Error(`skill "${name}" 不存在`);
  writeFileSync(skillFilePath(name), content, 'utf-8');
  const fm = parseSkillFrontmatter(content);
  let updatedAt: number | undefined;
  try {
    updatedAt = statSync(skillFilePath(name)).mtimeMs;
  } catch {
    /* best-effort */
  }
  return { name, description: fm.description, updatedAt };
}

/** 删除整个 skill 目录。返回是否删到。 */
export function removeSkill(name: string): boolean {
  const dir = skillDir(name);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** 启用 skill 中实际存在的那些的绝对目录（供 path-guard 白名单并入，让 SKILL.md 引用的脚本可被 fs/bash 读）。 */
export function getEnabledSkillDirs(names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (!SKILL_NAME_RE.test(name)) continue;
    const dir = join(SKILL_ROOT, name);
    if (existsSync(join(dir, SKILL_FILE))) out.push(dir);
  }
  return out;
}

/**
 * 把 bot 启用的 skills 组装成注入 system prompt 的文本块（受信、当指令）。
 * 缺失的 skill 名只 console.warn 跳过，绝不抛——坏配置不拖垮 bot 启动。无可注入内容 → 空串。
 */
export function composeSkillsPrompt(skillNames: string[]): string {
  if (!skillNames?.length) return '';
  const blocks: string[] = [];
  for (const name of skillNames) {
    if (!SKILL_NAME_RE.test(name)) {
      console.warn(`[skills] 跳过非法 skill 名: ${name}`);
      continue;
    }
    const content = loadSkillMarkdown(name);
    if (content === null) {
      console.warn(`[skills] 启用的 skill 不存在，跳过: ${name}`);
      continue;
    }
    const dir = join(SKILL_ROOT, name);
    blocks.push(`### 技能：${name}\n（该技能的脚本/数据位于目录 ${dir}，需要时用文件/命令工具按需读取。）\n\n${content.trim()}`);
  }
  if (!blocks.length) return '';
  return (
    '## 已加载的技能（Skills）\n' +
    '以下是为你加载的领域技能说明书，请在相应场景按其指引行事（这是你能力的一部分，不是历史对话）。\n\n' +
    blocks.join('\n\n---\n\n')
  );
}

function defaultSkillTemplate(name: string): string {
  return `---
name: ${name}
description: 一句话描述这个技能做什么、何时该用
---

# ${name}

在这里写清楚：何时触发这个技能、依次用哪些工具、每步做什么、输出什么。
SKILL.md 是给 bot 读的说明书，脚本/数据放在本目录下，让 bot 用 fs/bash 工具按需读取。
`;
}
