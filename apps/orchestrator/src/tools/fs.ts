import { z } from 'zod';
import { tool, type Tool } from 'ai';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  realpathSync,
  type Dirent,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

const IS_WIN = process.platform === 'win32';
const samePath = (a: string, b: string): boolean => (IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b);
import { assertRealpathAllowed, assertWriteTargetAllowed } from './path-guard.js';

const MAX_READ_BYTES = 256 * 1024; // 单文件读取上限，防 token 爆炸
const MAX_GREP_FILES = 2000;
const MAX_GREP_MATCHES = 200;
const MAX_GREP_LINE_LEN = 2000; // 每行测试前截断，限制 ReDoS 最坏回溯规模
const MAX_GREP_PATTERN_LEN = 500;

/** 统一错误返回：让 LLM 看到工具结果而非中断整个 step 循环 */
function fail(msg: string): string {
  return `错误：${msg}`;
}

/**
 * 构建一组文件系统工具（read/write/edit/list/grep），全部强制 allowed 白名单（= 共享 workspaceDirs）。
 * allowed 为空时这些工具仍注册，但任一调用都会因白名单为空而被拒绝（fail-closed）。
 */
export function buildFsTools(allowed: string[]): Record<string, Tool> {

  const read_file = tool({
    description:
      '读取文本文件内容。path 必须落在已配置的白名单目录内。返回文件文本（超过 256KB 会截断）。',
    inputSchema: z.object({
      path: z.string().describe('要读取的文件绝对路径'),
    }),
    execute: async ({ path }) => {
      try {
        const abs = assertRealpathAllowed(path, allowed);
        const st = statSync(abs);
        if (st.isDirectory()) return fail(`${abs} 是目录，请用 list_dir`);
        const buf = readFileSync(abs);
        if (buf.length > MAX_READ_BYTES) {
          return buf.subarray(0, MAX_READ_BYTES).toString('utf-8') + `\n…（已截断，文件共 ${buf.length} 字节）`;
        }
        return buf.toString('utf-8');
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  });

  const write_file = tool({
    description:
      '把内容写入文件（覆盖已有内容，自动创建父目录）。path 必须落在白名单目录内。',
    inputSchema: z.object({
      path: z.string().describe('目标文件绝对路径'),
      content: z.string().describe('要写入的完整内容'),
    }),
    execute: async ({ path, content }) => {
      try {
        // 写入用 assertWriteTargetAllowed：校验最近已存在祖先目录的 realpath，
        // 防止穿过白名单内 junction 把新文件落到白名单外
        const abs = assertWriteTargetAllowed(path, allowed);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, 'utf-8');
        return `已写入 ${abs}（${Buffer.byteLength(content, 'utf-8')} 字节）`;
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  });

  const edit_file = tool({
    description:
      '在文件中把 old 文本替换为 new 文本。old 必须在文件中唯一出现，否则报错。用于精确小改动。',
    inputSchema: z.object({
      path: z.string().describe('目标文件绝对路径'),
      old: z.string().describe('要被替换的原文本（需在文件中唯一）'),
      new: z.string().describe('替换后的新文本'),
    }),
    execute: async ({ path, old, new: replacement }) => {
      try {
        const abs = assertRealpathAllowed(path, allowed);
        const orig = readFileSync(abs, 'utf-8');
        if (old === replacement) return fail('old 与 new 相同，无需替换');
        const idx = orig.indexOf(old);
        if (idx === -1) return fail('未在文件中找到 old 文本');
        if (orig.indexOf(old, idx + old.length) !== -1) return fail('old 文本在文件中出现多次，无法唯一定位，请提供更长的上下文');
        const updated = orig.slice(0, idx) + replacement + orig.slice(idx + old.length);
        writeFileSync(abs, updated, 'utf-8');
        return `已编辑 ${abs}`;
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  });

  const list_dir = tool({
    description: '列出目录下的文件和子目录。path 必须落在白名单目录内。',
    inputSchema: z.object({
      path: z.string().describe('目录绝对路径'),
    }),
    execute: async ({ path }) => {
      try {
        const abs = assertRealpathAllowed(path, allowed);
        const entries = readdirSync(abs, { withFileTypes: true });
        if (entries.length === 0) return '（空目录）';
        return entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .join('\n');
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  });

  const grep = tool({
    description:
      '在某个目录（递归）或单个文件内按正则搜索文本，返回 `相对路径:行号: 匹配行`。path 必须落在白名单目录内。',
    inputSchema: z.object({
      pattern: z.string().describe('JavaScript 正则表达式（不含斜杠）'),
      path: z.string().describe('搜索根目录或文件绝对路径'),
      ignoreCase: z.boolean().optional().describe('是否忽略大小写，默认 false'),
    }),
    execute: async ({ pattern, path, ignoreCase }) => {
      try {
        if (pattern.length > MAX_GREP_PATTERN_LEN) return fail('正则过长，已拒绝（防 ReDoS）');
        const abs = assertRealpathAllowed(path, allowed);
        let re: RegExp;
        try {
          re = new RegExp(pattern, ignoreCase ? 'i' : '');
        } catch (e) {
          return fail(`正则无效：${(e as Error).message}`);
        }
        const files: string[] = [];
        const skipped = { dirs: 0 };
        const root = statSync(abs);
        if (root.isDirectory()) collectFiles(abs, files, skipped);
        else files.push(abs);

        const out: string[] = [];
        let skippedFiles = 0; // 过大/读失败被跳过的文件数，避免静默
        for (const f of files) {
          let text: string;
          try {
            const buf = readFileSync(f);
            if (buf.length > MAX_READ_BYTES) {
              skippedFiles++;
              continue; // 跳过超大文件
            }
            text = buf.toString('utf-8');
          } catch {
            skippedFiles++;
            continue; // 二进制/无权限文件跳过
          }
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            // 测试前截断行长，约束 ReDoS 最坏情况（灾难性回溯随输入长度爆炸）
            const line = (lines[i] ?? '').slice(0, MAX_GREP_LINE_LEN);
            if (re.test(line)) {
              out.push(`${relative(abs, f) || f}:${i + 1}: ${line.slice(0, 300)}`);
              if (out.length >= MAX_GREP_MATCHES) {
                return out.join('\n') + `\n…（命中过多，已截断到 ${MAX_GREP_MATCHES} 条）`;
              }
            }
          }
        }
        const notes: string[] = [];
        if (skippedFiles) notes.push(`${skippedFiles} 个文件因过大/无法读取被跳过`);
        if (skipped.dirs) notes.push(`${skipped.dirs} 个子目录无法读取`);
        const suffix = notes.length ? `\n（注意：${notes.join('；')}，结果可能不完整）` : '';
        return (out.length ? out.join('\n') : '（无匹配）') + suffix;
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  });

  return { read_file, write_file, edit_file, list_dir, grep };
}

function collectFiles(dir: string, acc: string[], skipped: { dirs: number }): void {
  if (acc.length >= MAX_GREP_FILES) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    skipped.dirs++; // 不静默吞掉无法读取的子目录
    return;
  }
  for (const e of entries) {
    if (acc.length >= MAX_GREP_FILES) return;
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      // 不跟随 symlink/junction 子目录（realpath 与词法路径不同即视为 reparse 点），
      // 防止 grep 经由白名单内的 junction 递归读取白名单外文件
      try {
        if (e.isSymbolicLink() || !samePath(realpathSync(full), full)) {
          skipped.dirs++;
          continue;
        }
      } catch {
        skipped.dirs++;
        continue;
      }
      collectFiles(full, acc, skipped);
    } else if (e.isFile()) {
      acc.push(full);
    }
  }
}
