// L4 历史检索：从持久化的 messages 里按相关性召回「窗口/摘要之外」的旧片段，注入 system prompt。
//
// 当前实现：SQLite FTS5（trigram 分词，见 migration 0007），关键词/子串召回，零外部依赖、零 token 成本。
// 预留：语义向量层（RETRIEVAL_SEMANTIC + EMBEDDING_* + sqlite-vec），见文末注释；本期不实现，FTS 始终可用。
//
// 全部 best-effort：构造 MATCH 失败 / DB 故障 → 返回 []，绝不抛进 Discord 回复热路径。

import { getDb } from './db.js';

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

/** L4 主开关（全局）。per-bot 还有 conversationMemory.retrievalEnabled，两者皆 true 才生效。 */
export const RETRIEVAL_ENABLED = boolEnv('RETRIEVAL_ENABLED', true);
/** 注入的片段条数上限。 */
export const RETRIEVAL_TOPK = intEnv('RETRIEVAL_TOPK', 3);
/** 语义向量层开关（占位）：本期未实现，置 true 暂仍走 FTS（见文末）。 */
export const RETRIEVAL_SEMANTIC = boolEnv('RETRIEVAL_SEMANTIC', false);

const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
const TOKEN_RE = new RegExp(`[${CJK}]+|[A-Za-z0-9]+`, 'gu');
const CJK_TEST = new RegExp(`[${CJK}]`, 'u');

export interface RetrievedSnippet {
  role: 'user' | 'assistant';
  content: string;
}

const CJK_WINDOW = 4; // 中文滑窗大小（≥3 以满足 trigram）

/**
 * 把用户文本拆成 FTS 检索词：拉丁/数字词整体保留；中文片段用「4 字滑动窗口（步长 1，重叠）」切词。
 * 重叠是关键——只要查询与历史消息有 ≥4 字的共同子串，必有一个窗口对齐命中，避免「关键词被切分边界劈开而漏召回」。
 * trigram 子串匹配 + bm25 rank 兜住重叠带来的噪声。去重、限量（控查询长度）。无可用词 → []。
 */
export function extractTerms(text: string): string[] {
  const tokens = text.match(TOKEN_RE) ?? [];
  const out: string[] = [];
  for (const tok of tokens) {
    if (CJK_TEST.test(tok)) {
      if (tok.length <= CJK_WINDOW) {
        if (tok.length >= 3) out.push(tok);
      } else {
        for (let i = 0; i + CJK_WINDOW <= tok.length; i++) {
          out.push(tok.slice(i, i + CJK_WINDOW));
        }
      }
    } else if (tok.length >= 3) {
      out.push(tok);
    }
  }
  return [...new Set(out)].slice(0, 24);
}

/** 把检索词构造成 FTS5 MATCH 表达式：每词作字面量（双引号转义）OR 连接。无词 → null。 */
export function buildMatchExpr(text: string): string | null {
  const terms = extractTerms(text);
  if (!terms.length) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/**
 * FTS 关键词检索：同会话内，按相关性（bm25 rank）取 top-k，排除最近 windowSize 条（已在 L1 逐字窗口里，避免重复）。
 * windowSize = 该 bot 的窗口轮数 ×2（消息数）。失败/无命中 → []。
 */
export function searchHistoryFts(
  sessionId: string,
  queryText: string,
  k: number,
  windowSize: number
): RetrievedSnippet[] {
  const match = buildMatchExpr(queryText);
  if (!match) return [];
  try {
    const rows = getDb()
      .prepare(
        `SELECT m.role AS role, m.content AS content
           FROM messages_fts
           JOIN messages m ON m.rowid = messages_fts.rowid
          WHERE messages_fts MATCH ?
            AND m.session_id = ?
            AND m.rowid NOT IN (
              SELECT rowid FROM messages WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
            )
          ORDER BY rank
          LIMIT ?`
      )
      .all(match, sessionId, sessionId, Math.max(0, windowSize), Math.max(1, k)) as {
      role: string;
      content: string;
    }[];
    return rows.map((r) => ({ role: r.role === 'assistant' ? 'assistant' : 'user', content: r.content }));
  } catch (e) {
    console.error('[retrieval] FTS 检索失败（已忽略，返回空）', e);
    return [];
  }
}

/**
 * 检索入口（best-effort）。当前总走 FTS；RETRIEVAL_SEMANTIC 为后续语义向量层预留（见文末）。
 */
export function retrieve(
  sessionId: string,
  queryText: string,
  k: number,
  windowSize: number
): RetrievedSnippet[] {
  // 预留：RETRIEVAL_SEMANTIC=true 时未来在此调用 retrieveSemantic()（sqlite-vec + embedding），
  // 失败再回退 FTS。本期未实现，恒走 FTS。
  return searchHistoryFts(sessionId, queryText, k, windowSize);
}

const SNIPPET_MAX_CHARS = 300;

/** 把检索到的片段渲染为注入文本（每条截断，避免注入膨胀）。 */
export function renderRetrieved(snippets: RetrievedSnippet[]): string {
  return snippets
    .map((s) => {
      const who = s.role === 'assistant' ? '助手' : '用户';
      const body = s.content.length > SNIPPET_MAX_CHARS ? s.content.slice(0, SNIPPET_MAX_CHARS) + '…' : s.content;
      return `${who}：${body}`;
    })
    .join('\n\n');
}

// ── 语义向量层（预留，本期不实现）─────────────────────────────────────────────
// 计划：messages 写入时（或后台批处理）用 embedding 模型把 content 向量化，存进 sqlite-vec 虚拟表；
// retrieve() 在 RETRIEVAL_SEMANTIC=true 时改为「query 向量 → 近邻检索 top-k」，FTS 作为回退。
// 需要的新依赖/配置（届时启用）：
//   · sqlite-vec（better-sqlite3 loadable extension）
//   · EMBEDDING_BASE_URL / EMBEDDING_MODEL / EMBEDDING_API_KEY（远程），或本地 embedding 模型
// 之所以现在抽出 retrieve() 这层间接，就是为了那时只改这一个函数、不动 bot-manager 调用点。
