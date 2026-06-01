// Phase C 冒烟（L4 FTS5 检索）：migration 0007 + 触发器同步 + searchHistoryFts 命中/排除窗口/topk/删除同步 + 分词。
// 重跑：apps/orchestrator/node_modules/.bin/tsx apps/orchestrator/pC-smoke.ts
import { rmSync, existsSync } from 'node:fs';
import { initDb, getDb, closeDb } from './src/db.ts';
import { extractTerms, buildMatchExpr, searchHistoryFts, retrieve, renderRetrieved } from './src/retrieval.ts';

const DB = 'd:/tmp/pC-smoke.db';
for (const f of [DB, DB + '-wal', DB + '-shm']) if (existsSync(f)) rmSync(f);

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ''); }
}

initDb(DB);
const db = getDb();

// 表 + 触发器存在
const tbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'").get();
check('migration 0007: messages_fts 存在', !!tbl, tbl);
const trg = db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='trigger' AND name IN ('messages_ai','messages_ad','messages_au')").get() as { c: number };
check('migration 0007: 三触发器存在', trg.c === 3, trg);

// 分词
check('extractTerms: 重叠窗口含关键子串「向量数据」', extractTerms('现在向量数据库怎么样').includes('向量数据'), extractTerms('现在向量数据库怎么样'));
check('extractTerms: 拉丁词整体保留', extractTerms('用 redis 缓存').includes('redis'));
check('buildMatchExpr: 无可用词→null', buildMatchExpr('a 的 了') === null, buildMatchExpr('a 的 了'));

// 种会话 + 消息（AFTER INSERT 触发器自动建 FTS 索引）
db.prepare('INSERT INTO sessions (id,bot_id,channel_id,channel_type,channel_name,guild_id,title,created_at,last_active_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run('s1', 'botA', 'cA', 'dm', null, null, '会话', 1000, 5000);
const insMsg = db.prepare('INSERT INTO messages (id,session_id,run_id,bot_id,role,author_id,author_name,content,truncated,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
// 旧（可被检索）：99,100 含关键词；101,102 无关
insMsg.run('o0', 's1', null, 'botA', 'user',      'u', 'sun', '向量数据库太复杂了', 0, 99);
insMsg.run('o1', 's1', null, 'botA', 'assistant', null, null, '我们讨论过向量数据库选型', 0, 100);
insMsg.run('o2', 's1', null, 'botA', 'user',      'u', 'sun', '今天天气不错', 0, 101);
insMsg.run('o3', 's1', null, 'botA', 'assistant', null, null, '随便聊聊', 0, 102);
// 近期窗口（最近 4 条，应被排除）：含关键词的 r3 用于验证排除
insMsg.run('r0', 's1', null, 'botA', 'user',      'u', 'sun', '继续', 0, 103);
insMsg.run('r1', 's1', null, 'botA', 'assistant', null, null, '好', 0, 104);
insMsg.run('r2', 's1', null, 'botA', 'user',      'u', 'sun', '嗯嗯', 0, 105);
insMsg.run('r3', 's1', null, 'botA', 'assistant', null, null, '向量数据库的事我记得', 0, 106);

const q = '现在向量数据库怎么样了';
// windowSize=4 → 排除最近 4 条（103..106，含含关键词的 r3）
const hits = searchHistoryFts('s1', q, 3, 4);
const contents = hits.map((h) => h.content);
check('检索：命中旧的关键词消息', contents.includes('我们讨论过向量数据库选型') || contents.includes('向量数据库太复杂了'), contents);
check('检索：排除窗口内（不含 r3）', !contents.includes('向量数据库的事我记得'), contents);
check('检索：不召回无关消息', !contents.includes('今天天气不错') && !contents.includes('随便聊聊'), contents);
check('检索：role 映射正确', hits.every((h) => h.role === 'user' || h.role === 'assistant'), hits);

// topk 限量
check('检索 topk=1：至多 1 条', searchHistoryFts('s1', q, 1, 4).length <= 1, searchHistoryFts('s1', q, 1, 4).length);

// retrieve 包装 + 渲染
const rendered = renderRetrieved(hits);
check('renderRetrieved：含角色前缀', /^(用户|助手)：/.test(rendered), rendered.slice(0, 20));

// 删除同步：删 o1 → FTS 不再命中它（AFTER DELETE 触发器）
db.prepare('DELETE FROM messages WHERE id = ?').run('o1');
const after = searchHistoryFts('s1', q, 5, 4).map((h) => h.content);
check('删除同步：o1 已从 FTS 移除', !after.includes('我们讨论过向量数据库选型'), after);
check('删除同步：o0 仍可被检索', after.includes('向量数据库太复杂了'), after);

// 空查询安全
check('空查询→[]', retrieve('s1', '的 了 a', 3, 4).length === 0);
check('无命中→[]', retrieve('s1', '完全不相关的洗衣机话题', 3, 4).length === 0, retrieve('s1', '完全不相关的洗衣机话题', 3, 4));

closeDb();
for (const f of [DB, DB + '-wal', DB + '-shm']) if (existsSync(f)) rmSync(f);
console.log(`\nPhase C 冒烟：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
