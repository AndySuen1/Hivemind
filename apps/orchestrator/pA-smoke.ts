// Phase A 冒烟（L1 对话复原）：直接种入受控 messages，断言 observRepo.recentHistory 的顺序/限量/空会话/跨 bot 隔离。
// 重跑：apps/orchestrator/node_modules/.bin/tsx apps/orchestrator/pA-smoke.ts
import { rmSync, existsSync } from 'node:fs';
import { initDb, getDb, closeDb } from './src/db.ts';
import { observRepo } from './src/observ-repo.ts';

const DB = 'd:/tmp/pA-smoke.db';
for (const f of [DB, DB + '-wal', DB + '-shm']) if (existsSync(f)) rmSync(f);

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ''); }
}

initDb(DB);
const db = getDb();

// 两个会话：botA 在频道 cA（s1），botB 在频道 cB（s2，验证跨 bot/跨频道隔离）
db.prepare('INSERT INTO sessions (id,bot_id,channel_id,channel_type,channel_name,guild_id,title,created_at,last_active_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run('s1', 'botA', 'cA', 'dm', null, null, '会话A', 1000, 5000);
db.prepare('INSERT INTO sessions (id,bot_id,channel_id,channel_type,channel_name,guild_id,title,created_at,last_active_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run('s2', 'botB', 'cB', 'dm', null, null, '会话B', 1000, 5000);

const insMsg = db.prepare('INSERT INTO messages (id,session_id,run_id,bot_id,role,author_id,author_name,content,truncated,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
// s1：6 条消息（3 轮），created_at 递增 100..105，含一对同毫秒（103）验证 (ts,id) 复合排序稳定
insMsg.run('a1', 's1', null, 'botA', 'user',      'u', 'sun', 'U1', 0, 100);
insMsg.run('a2', 's1', null, 'botA', 'assistant', null, null, 'A1', 0, 101);
insMsg.run('a3', 's1', null, 'botA', 'user',      'u', 'sun', 'U2', 0, 102);
insMsg.run('a4', 's1', null, 'botA', 'assistant', null, null, 'A2', 0, 103); // 同毫秒
insMsg.run('a5', 's1', null, 'botA', 'user',      'u', 'sun', 'U3', 0, 103); // 同毫秒
insMsg.run('a6', 's1', null, 'botA', 'assistant', null, null, 'A3', 0, 104);
// s2：1 条（隔离用）
insMsg.run('b1', 's2', null, 'botB', 'user', 'u', 'sun', 'OTHER', 0, 200);

// 1) 全量复原：时间正序 + role/content 正确映射
const all = observRepo.recentHistory('botA', 'cA', 100);
check('recentHistory: 取到 6 条', all.length === 6, all.length);
check('recentHistory: 时间正序 U1..A3', all.map((m) => m.content).join(',') === 'U1,A1,U2,A2,U3,A3', all.map((m) => m.content));
check('recentHistory: role 映射正确（首 user，次 assistant）', all[0]?.role === 'user' && all[1]?.role === 'assistant', all.slice(0, 2));

// 2) 限量：limit=4 取「最近 4 条」并仍按时间正序（A2,U3,A3 + 其前一条 U2）
const last4 = observRepo.recentHistory('botA', 'cA', 4);
check('recentHistory limit=4: 取最近 4 条且正序', last4.map((m) => m.content).join(',') === 'U2,A2,U3,A3', last4.map((m) => m.content));

// 3) 跨 bot/跨频道隔离：botA 不应看到 botB 的消息；用 botB 的频道查 botA 应为空
check('隔离: botA/cA 不含 OTHER', all.every((m) => m.content !== 'OTHER'), all.map((m) => m.content));
const wrongBot = observRepo.recentHistory('botA', 'cB', 100);
check('隔离: botA 查 cB（非其会话）→ 空', wrongBot.length === 0, wrongBot.length);

// 4) 不存在的会话 → 空（= 今天首条消息行为，无回归）
const none = observRepo.recentHistory('botA', 'no-such-channel', 100);
check('空会话 → []', none.length === 0, none.length);

closeDb();
for (const f of [DB, DB + '-wal', DB + '-shm']) if (existsSync(f)) rmSync(f);
console.log(`\nPhase A 冒烟：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
