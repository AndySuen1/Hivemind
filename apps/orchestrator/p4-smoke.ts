// P4 集成冒烟：种入受控数据（直接 SQL，便于确定性断言），用 Fastify app.inject() 打真实查询路由。
// 校验游标分页/排序、记忆浏览 + path-guard、Live 聚合。
// 重跑：BOT_MEMORY_ROOT=d:/tmp/p4-mem apps/orchestrator/node_modules/.bin/tsx apps/orchestrator/p4-smoke.ts
import { rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initDb, getDb, closeDb } from './src/db.ts';
import { buildApi } from './src/api.ts';

const DB = 'd:/tmp/p4-smoke.db';
for (const f of [DB, DB + '-wal', DB + '-shm']) if (existsSync(f)) rmSync(f);
const MEM_ROOT = process.env.BOT_MEMORY_ROOT ?? 'd:/tmp/p4-mem';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ''); }
}

initDb(DB);
const db = getDb();

// ---------- 种数据（受控时间戳） ----------
const now = 9999;
db.prepare('INSERT INTO providers (id,name,kind,base_url,default_model,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
  .run('p1', 'Prov', 'openai-compatible', 'http://x', 'deepseek-chat', now, now);
db.prepare('INSERT INTO bots (id,name,provider_id,system_prompt,temperature,tools,allowed_requesters,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
  .run('botL', 'TestBot', 'p1', 'sp', 1.3, '{}', '[]', 0, now, now);

// 2 会话：s1 更近活跃(3000) 在前，s2(1000) 在后
db.prepare('INSERT INTO sessions (id,bot_id,channel_id,channel_type,channel_name,guild_id,title,created_at,last_active_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run('s1', 'botL', 'c1', 'guild', '#a', 'g1', '问题一', 1000, 3000);
db.prepare('INSERT INTO sessions (id,bot_id,channel_id,channel_type,channel_name,guild_id,title,created_at,last_active_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run('s2', 'botL', 'c2', 'dm', null, null, '问题二', 500, 1000);

// 2 回合：r1 完成(ok, started 3000)，r2 在跑(running, started 2000)
db.prepare('INSERT INTO runs (id,session_id,bot_id,requester_id,status,user_message_id,finish_reason,tool_call_count,usage_json,error,started_at,ended_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
  .run('r1', 's1', 'botL', 'u1', 'ok', null, 'stop', 2, JSON.stringify({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }), null, 3000, 3500);
db.prepare('INSERT INTO runs (id,session_id,bot_id,requester_id,status,user_message_id,finish_reason,tool_call_count,usage_json,error,started_at,ended_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
  .run('r2', 's1', 'botL', 'u1', 'running', null, null, 0, null, null, 2000, null);

// 消息：user(3000) + assistant(3001)
db.prepare('INSERT INTO messages (id,session_id,run_id,bot_id,role,author_id,author_name,content,truncated,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
  .run('m1', 's1', 'r1', 'botL', 'user', 'u1', 'sun', '帮我看下', 0, 3000);
db.prepare('INSERT INTO messages (id,session_id,run_id,bot_id,role,author_id,author_name,content,truncated,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
  .run('m2', 's1', 'r1', 'botL', 'assistant', null, null, '好的，已看', 0, 3001);

// 事件：seq 1..3
const ev = db.prepare('INSERT INTO events (id,run_id,session_id,bot_id,seq,type,tool_name,label,status,input_json,output_json,duration_ms,parent_event_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
ev.run('e1', 'r1', 's1', 'botL', 1, 'tool_call', 'read_file', '🔎', 'ok', JSON.stringify({ path: '/a' }), JSON.stringify('内容'), 5, null, 3100);
ev.run('e2', 'r1', 's1', 'botL', 2, 'delegate_start', 'delegate_to_claude', '🤖', 'running', JSON.stringify({ task: '重构' }), null, null, null, 3200);
ev.run('e3', 'r1', 's1', 'botL', 3, 'delegate_end', 'delegate_to_claude', '🤖', 'ok', null, JSON.stringify({ summary: 'done', numTurns: 4 }), null, 'e2', 3300);

// 记忆文件（受控目录）
const memDir = join(MEM_ROOT, 'botL');
mkdirSync(memDir, { recursive: true });
writeFileSync(join(memDir, 'test-mem-abc123.md'), `---\nname: test-mem\ndescription: 一条测试记忆\nmetadata:\n  type: project\n---\n\n正文内容。`, 'utf-8');
writeFileSync(join(memDir, 'MEMORY.md'), '# MEMORY 索引\n\n- [test-mem](test-mem-abc123.md) — 一条测试记忆 (project)\n', 'utf-8');

// ---------- 起 app 并 inject ----------
const app = buildApi();
await app.ready();
const get = async (url: string): Promise<{ status: number; data: any; ok: boolean }> => {
  const res = await app.inject({ method: 'GET', url });
  const body = JSON.parse(res.payload);
  return { status: res.statusCode, data: body.data, ok: body.ok };
};

// 1) sessions：倒序 + 分页
const sess = await get('/api/bots/botL/sessions');
check('sessions: 2 条，s1 在前', sess.ok && sess.data.items.length === 2 && sess.data.items[0].id === 's1' && sess.data.items[1].id === 's2', sess.data?.items?.map((s: any) => s.id));
check('sessions: 末页 nextCursor=null', sess.data.nextCursor === null, sess.data.nextCursor);
const sessP1 = await get('/api/bots/botL/sessions?limit=1');
check('sessions limit=1: 1 条 + nextCursor=(3000,s1)', sessP1.data.items.length === 1 && sessP1.data.items[0].id === 's1' && sessP1.data.nextCursor?.ts === 3000 && sessP1.data.nextCursor?.id === 's1', sessP1.data);
const sessP2 = await get('/api/bots/botL/sessions?limit=1&before=3000&beforeId=s1');
check('sessions before=(3000,s1): 取到 s2', sessP2.data.items.length === 1 && sessP2.data.items[0].id === 's2' && sessP2.data.nextCursor === null, sessP2.data);

// 2) messages：倒序（assistant 在前）
const msgs = await get('/api/sessions/s1/messages');
check('messages: 2 条，m2(assistant,3001) 在前', msgs.data.items.length === 2 && msgs.data.items[0].id === 'm2' && msgs.data.items[1].id === 'm1', msgs.data?.items?.map((m: any) => m.id));

// 3) runs：倒序 + usage 解析
const runs = await get('/api/sessions/s1/runs');
check('runs: 2 条，r1(3000) 在前', runs.data.items.length === 2 && runs.data.items[0].id === 'r1', runs.data?.items?.map((r: any) => r.id));
check('run.usage 解析为对象（totalTokens=15）', runs.data.items[0].usage?.totalTokens === 15, runs.data.items[0].usage);

// 4) events：升序 + after 分页 + input/output 解析
const evts = await get('/api/runs/r1/events');
check('events: 3 条，seq 升序 1,2,3', evts.data.items.map((e: any) => e.seq).join(',') === '1,2,3', evts.data?.items?.map((e: any) => e.seq));
check('event[0].input 解析为对象', evts.data.items[0].input?.path === '/a', evts.data.items[0].input);
check('delegate_end.output 解析（numTurns=4）', evts.data.items[2].output?.numTurns === 4, evts.data.items[2].output);
check('delegate_end.parentEventId=e2', evts.data.items[2].parentEventId === 'e2', evts.data.items[2].parentEventId);
const evP1 = await get('/api/runs/r1/events?limit=2');
check('events limit=2: [e1,e2] + nextCursor=2', evP1.data.items.length === 2 && evP1.data.nextCursor === 2, evP1.data);
const evP2 = await get('/api/runs/r1/events?limit=2&after=2');
check('events after=2: [e3] + nextCursor=null', evP2.data.items.length === 1 && evP2.data.items[0].seq === 3 && evP2.data.nextCursor === null, evP2.data);

// 5) 记忆浏览 + path-guard
const mem = await get('/api/bots/botL/memory');
check('memory: 列出 1 条 + 索引', mem.data.memories.length === 1 && mem.data.memories[0].name === 'test-mem' && mem.data.indexText.includes('MEMORY 索引'), mem.data);
const memFile = await get(`/api/bots/botL/memory/file?path=${mem.data.memories[0].file}`);
check('memory file: 读到正文', memFile.ok && memFile.data.content.includes('正文内容'), memFile.data);
const memBad = await get('/api/bots/botL/memory/file?path=../../../etc/passwd');
check('memory file: 路径穿越被拒(404)', memBad.status === 404, memBad.status);
const memMissing = await get('/api/bots/botL/memory/file');
check('memory file: 缺 path 参数 400', memMissing.status === 400, memMissing.status);
// botId 穿越防护：含 '.' 的 botId 直达 handler 被正则拒（400）；编码穿越被路由/校验拒（>=400，不泄露）
const memDotId = await get('/api/bots/foo.bar/memory');
check('botId 含点 → 400（路径穿越防护）', memDotId.status === 400, memDotId.status);
const memTraversal = await get('/api/bots/%2e%2e/memory');
check('botId=.. 编码穿越 → 不返回数据(状态>=400)', memTraversal.status >= 400, memTraversal.status);

// 6) Live 总览
const live = await get('/api/live/overview');
const botL = live.data.bots.find((b: any) => b.botId === 'botL');
check('live: botL 存在 + name', !!botL && botL.name === 'TestBot', botL);
check('live: sessions=2 runs=2 runningRuns=1', botL.sessions === 2 && botL.runs === 2 && botL.runningRuns === 1, botL);
check('live: lastActiveAt=3000 + status offline', botL.lastActiveAt === 3000 && botL.status === 'offline', botL);

await app.close();
closeDb();
// 清理记忆测试目录
try { rmSync(MEM_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
