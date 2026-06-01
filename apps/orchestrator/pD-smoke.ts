// Phase D 冒烟（L3 触发式整理）：migration consolidated_at + conversation-repo 空闲判定 + memory.ts 写入/淘汰
// + memory-consolidation 防御式解析/应用/封顶。不调真 LLM。
// 重跑：apps/orchestrator/node_modules/.bin/tsx apps/orchestrator/pD-smoke.ts
import { rmSync, existsSync, mkdirSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { initDb, getDb, closeDb } from './src/db.ts';
import { conversationRepo } from './src/conversation-repo.ts';
import { upsertMemory, deleteMemoryByName, loadMemoryBody, listMemoryMetas, pruneMemoriesToCap } from './src/tools/memory.ts';
import { parseConsolidationOps, applyConsolidationOps } from './src/memory-consolidation.ts';

const DB = 'd:/tmp/pD-smoke.db';
const MEM = 'd:/tmp/pD-mem';
for (const f of [DB, DB + '-wal', DB + '-shm']) if (existsSync(f)) rmSync(f);
if (existsSync(MEM)) rmSync(MEM, { recursive: true });
mkdirSync(MEM, { recursive: true });

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ''); }
}

initDb(DB);
const db = getDb();

// migration：consolidated_at 列
const cols = (db.prepare("PRAGMA table_info('conversation_state')").all() as { name: string }[]).map((c) => c.name);
check('migration 0006: 含 consolidated_at 列', cols.includes('consolidated_at'), cols);

// ---------- conversation-repo 空闲判定 ----------
const mkSession = (id: string, lastActive: number) =>
  db.prepare('INSERT INTO sessions (id,bot_id,channel_id,channel_type,channel_name,guild_id,title,created_at,last_active_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, 'botA', 'c-' + id, 'dm', null, null, 't', 100, lastActive);
mkSession('idle', 1000);
mkSession('recent', 9000);
mkSession('empty', 1000);
conversationRepo.upsertSummary('idle', 'botA', '一段摘要');
conversationRepo.upsertSummary('recent', 'botA', '一段摘要');
conversationRepo.upsertSummary('empty', 'botA', ''); // 空摘要

const idleBefore = 2000;
let cands = conversationRepo.listIdleForConsolidation('botA', idleBefore).map((c) => c.sessionId);
check('idle 查询：仅 idle（空闲+有摘要+有新内容）', cands.length === 1 && cands[0] === 'idle', cands);

conversationRepo.markConsolidated('idle', 5000); // consolidated_at=5000 > last_active(1000)
cands = conversationRepo.listIdleForConsolidation('botA', idleBefore).map((c) => c.sessionId);
check('idle 查询：整理后不再返回（无新活动）', cands.length === 0, cands);

// 模拟新活动：last_active 推到 6000（> consolidated_at 5000，但仍 <= idleBefore? 用更大 idleBefore）
db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(6000, 'idle');
cands = conversationRepo.listIdleForConsolidation('botA', 7000).map((c) => c.sessionId);
check('idle 查询：有新活动后重新可整理', cands.includes('idle'), cands);

// ---------- memory.ts 写入/读取/删除 ----------
upsertMemory(MEM, { name: 'user-pref', description: '用户偏好', type: 'user', content: '喜欢简洁' });
const metas = listMemoryMetas(MEM);
check('upsertMemory：写入 1 条', metas.length === 1 && metas[0]?.name === 'user-pref', metas);
const body = loadMemoryBody(MEM, 'user-pref') ?? '';
check('loadMemoryBody：含正文 + frontmatter', body.includes('喜欢简洁') && body.includes('name: user-pref'), body.slice(0, 40));
upsertMemory(MEM, { name: 'user-pref', description: '用户偏好(改)', type: 'user', content: '喜欢极简' }); // 同名覆盖
check('upsertMemory：同名覆盖不新增', listMemoryMetas(MEM).length === 1 && (loadMemoryBody(MEM, 'user-pref') ?? '').includes('喜欢极简'));
check('deleteMemoryByName：删除', deleteMemoryByName(MEM, 'user-pref') && listMemoryMetas(MEM).length === 0);
check('deleteMemoryByName：删不存在→false', deleteMemoryByName(MEM, 'nope') === false);

// ---------- pruneMemoriesToCap：LRU 淘汰到上限 ----------
// 建 5 条，按创建序设递增 mtime（最旧 mtime 最小）
for (let i = 1; i <= 5; i++) {
  const before = readdirSync(MEM).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  upsertMemory(MEM, { name: `fact-${i}`, description: `d${i}`, type: 'project', content: `c${i}` });
  const after = readdirSync(MEM).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  const newFile = after.find((f) => !before.includes(f));
  if (newFile) utimesSync(join(MEM, newFile), i * 1000, i * 1000); // mtime = i 秒
}
const evicted = pruneMemoriesToCap(MEM, 3);
const remain = listMemoryMetas(MEM).map((m) => m.name).sort();
check('prune：淘汰 2 条最旧', evicted.length === 2 && evicted.includes('fact-1') && evicted.includes('fact-2'), evicted);
check('prune：保留 3 条最新', remain.length === 3 && remain.join(',') === 'fact-3,fact-4,fact-5', remain);
check('prune：未超上限不淘汰', pruneMemoriesToCap(MEM, 10).length === 0);

// ---------- parseConsolidationOps：防御式解析 ----------
check('parse：纯 JSON 数组',
  parseConsolidationOps('[{"action":"upsert","name":"a","description":"d","type":"user","content":"x"}]').length === 1);
check('parse：```json 围栏',
  parseConsolidationOps('```json\n[{"action":"delete","name":"old"}]\n```').length === 1);
check('parse：散文包裹也能截取',
  parseConsolidationOps('好的，操作如下：[{"action":"delete","name":"z"}] 完成').length === 1);
check('parse：非法 type 归一为 project', (() => {
  const ops = parseConsolidationOps('[{"action":"upsert","name":"a","description":"d","type":"weird","content":"x"}]');
  return ops[0]?.action === 'upsert' && ops[0].type === 'project';
})());
check('parse：upsert 缺 content 跳过',
  parseConsolidationOps('[{"action":"upsert","name":"a","description":"d","type":"user"}]').length === 0);
check('parse：垃圾→[]', parseConsolidationOps('not json at all').length === 0);
check('parse：非数组→[]', parseConsolidationOps('{"action":"delete","name":"a"}').length === 0);

// ---------- applyConsolidationOps：合并/删除 + 封顶 ----------
if (existsSync(MEM)) rmSync(MEM, { recursive: true });
mkdirSync(MEM, { recursive: true });
upsertMemory(MEM, { name: 'keep', description: '保留', type: 'project', content: 'old' });
upsertMemory(MEM, { name: 'gone', description: '将删', type: 'project', content: 'x' });
const res = applyConsolidationOps(MEM, [
  { action: 'upsert', name: 'keep', description: '保留(更新)', type: 'project', content: 'new' },
  { action: 'upsert', name: 'fresh', description: '新', type: 'user', content: 'y' },
  { action: 'delete', name: 'gone' },
], 50);
const names = listMemoryMetas(MEM).map((m) => m.name).sort();
check('apply：+2 upsert / -1 delete', res.upserted === 2 && res.deleted === 1, res);
check('apply：结果集 = keep+fresh', names.join(',') === 'fresh,keep', names);
check('apply：keep 内容已更新', (loadMemoryBody(MEM, 'keep') ?? '').includes('new'));

closeDb();
for (const f of [DB, DB + '-wal', DB + '-shm']) if (existsSync(f)) rmSync(f);
if (existsSync(MEM)) rmSync(MEM, { recursive: true });
console.log(`\nPhase D 冒烟：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
