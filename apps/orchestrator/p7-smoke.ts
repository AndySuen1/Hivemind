// P7 集成冒烟：孤儿 running 回合恢复、按保留天数清理（含 running 守护 + CASCADE）、
// 手动删会话 / 删某 bot 全部历史、复合 (时间戳,id) 游标分页（同毫秒不重不漏）、清理写 API 路由。
// 直接 SQL 种受控数据 + 直调 observ-retention/observ-repo + Fastify app.inject 打真实路由。
// 重跑：apps/orchestrator/node_modules/.bin/tsx apps/orchestrator/p7-smoke.ts
import { rmSync, existsSync } from 'node:fs';
import { initDb, getDb, closeDb } from './src/db.ts';
import { buildApi } from './src/api.ts';
import { allowedOrigins } from './src/cors-origins.ts';
import { observRepo } from './src/observ-repo.ts';
import {
  recoverInterruptedRuns,
  purgeByRetention,
  deleteSession,
  deleteBotHistory,
} from './src/observ-retention.ts';

const DB = 'd:/tmp/p7-smoke.db';
for (const f of [DB, DB + '-wal', DB + '-shm']) if (existsSync(f)) rmSync(f);

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`, extra ?? '');
  }
}

initDb(DB);
const db = getDb();
const now = Date.now();
const DAY = 24 * 60 * 60 * 1000;

// ---------- 种数据辅助 ----------
const insSession = db.prepare(
  'INSERT INTO sessions (id,bot_id,channel_id,channel_type,channel_name,guild_id,title,created_at,last_active_at) VALUES (?,?,?,?,?,?,?,?,?)'
);
const insRun = db.prepare(
  'INSERT INTO runs (id,session_id,bot_id,requester_id,status,user_message_id,finish_reason,tool_call_count,usage_json,error,started_at,ended_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
);
const insMsg = db.prepare(
  'INSERT INTO messages (id,session_id,run_id,bot_id,role,author_id,author_name,content,truncated,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
);
const insEvt = db.prepare(
  'INSERT INTO events (id,run_id,session_id,bot_id,seq,type,tool_name,label,status,input_json,output_json,duration_ms,parent_event_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
);
const session = (id: string, botId: string, lastActive: number) =>
  insSession.run(id, botId, `c-${id}`, 'guild', '#x', 'g', null, lastActive, lastActive);
const run = (id: string, sid: string, botId: string, status: string, started: number, ended: number | null) =>
  insRun.run(id, sid, botId, 'u1', status, null, null, 0, null, null, started, ended);
const msg = (id: string, sid: string, botId: string, created: number) =>
  insMsg.run(id, sid, null, botId, 'user', 'u1', 'name', 'hi', 0, created);
const evt = (id: string, rid: string, sid: string, botId: string, seq: number) =>
  insEvt.run(id, rid, sid, botId, seq, 'tool_call', 'bash', '🔧', 'ok', null, null, null, null, now);

const runStatus = (id: string): string | undefined =>
  (db.prepare('SELECT status FROM runs WHERE id = ?').get(id) as { status: string } | undefined)?.status;
const exists = (table: string, id: string): boolean =>
  ((db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE id = ?`).get(id) as { c: number }).c) > 0;

// ============================================================
// A) 孤儿 running 回合恢复
// ============================================================
console.log('A) recoverInterruptedRuns');
session('sA', 'botA', now);
run('rA-run1', 'sA', 'botA', 'running', now - 1000, null);
run('rA-run2', 'sA', 'botA', 'running', now - 900, null);
run('rA-ok', 'sA', 'botA', 'ok', now - 800, now - 700);
const recovered = recoverInterruptedRuns();
check('recover 返回 2（两个 running）', recovered === 2, recovered);
check('rA-run1 → aborted', runStatus('rA-run1') === 'aborted', runStatus('rA-run1'));
check('rA-run2 → aborted', runStatus('rA-run2') === 'aborted', runStatus('rA-run2'));
check('rA-ok 保持 ok', runStatus('rA-ok') === 'ok', runStatus('rA-ok'));
const rA1 = db.prepare('SELECT * FROM runs WHERE id = ?').get('rA-run1') as any;
check('aborted 回合补了 ended_at / finish_reason', rA1.ended_at != null && rA1.finish_reason === 'interrupted', { ended_at: rA1.ended_at, fr: rA1.finish_reason });
check('recover 幂等：再调返回 0', recoverInterruptedRuns() === 0);

// ============================================================
// B) 按保留天数清理（age + running 守护 + CASCADE）
// ============================================================
console.log('B) purgeByRetention');
session('sOld', 'botB', now - 40 * DAY); // 旧、无 running → 应删
session('sNew', 'botB', now); // 近期 → 保留
session('sOldRun', 'botB', now - 40 * DAY); // 旧、但有 running → 守护保留
run('rOld', 'sOld', 'botB', 'ok', now - 40 * DAY, now - 40 * DAY);
msg('mOld', 'sOld', 'botB', now - 40 * DAY);
evt('eOld', 'rOld', 'sOld', 'botB', 1);
run('rOldRun', 'sOldRun', 'botB', 'running', now - 40 * DAY, null);
const purged = purgeByRetention(30);
check('purge 至少删 1 个会话', purged.sessions >= 1, purged);
check('sOld 已删', !exists('sessions', 'sOld'));
check('sOld 的回合被 CASCADE 删', !exists('runs', 'rOld'));
check('sOld 的消息被 CASCADE 删', !exists('messages', 'mOld'));
check('sOld 的事件被 CASCADE 删', !exists('events', 'eOld'));
check('sNew 近期会话保留', exists('sessions', 'sNew'));
check('sOldRun 有 running 回合 → 守护保留', exists('sessions', 'sOldRun'));
check('purge(0) 关闭：返回 0 不删', purgeByRetention(0).sessions === 0 && exists('sessions', 'sNew'));

// ============================================================
// C) 手动删单个会话（CASCADE）
// ============================================================
console.log('C) deleteSession');
session('sDel', 'botC', now);
run('rDel', 'sDel', 'botC', 'ok', now, now);
msg('mDel', 'sDel', 'botC', now);
evt('eDel', 'rDel', 'sDel', 'botC', 1);
const delOk = deleteSession('sDel');
check('deleteSession 返回 true', delOk === true);
check('会话 + 回合 + 消息 + 事件全被删', !exists('sessions', 'sDel') && !exists('runs', 'rDel') && !exists('messages', 'mDel') && !exists('events', 'eDel'));
check('删不存在会话 → false', deleteSession('nope') === false);

// ============================================================
// D) 删某 bot 全部历史（按 bot 隔离）
// ============================================================
console.log('D) deleteBotHistory');
session('sx1', 'botX', now);
session('sx2', 'botX', now);
msg('mx1', 'sx1', 'botX', now);
session('sy1', 'botY', now);
msg('my1', 'sy1', 'botY', now);
const dh = deleteBotHistory('botX');
check('deleteBotHistory 返回 sessions=2', dh.sessions === 2, dh);
check('botX 会话/消息全删', !exists('sessions', 'sx1') && !exists('sessions', 'sx2') && !exists('messages', 'mx1'));
check('botY 不受影响', exists('sessions', 'sy1') && exists('messages', 'my1'));

// ============================================================
// E) 复合 (时间戳,id) 游标分页：同一毫秒多条不重不漏
// ============================================================
console.log('E) 复合游标分页');
session('sPag', 'botP', now);
const sameMs = 5000;
for (const id of ['mp-a', 'mp-b', 'mp-c', 'mp-d', 'mp-e']) msg(id, 'sPag', 'botP', sameMs);
function walkMessages(limit: number): string[] {
  const out: string[] = [];
  let before: number | undefined;
  let beforeId: string | undefined;
  for (let g = 0; g < 50; g++) {
    const p = observRepo.listMessages('sPag', { before, beforeId, limit });
    for (const m of p.items) out.push(m.id);
    if (p.nextCursor == null) break;
    before = p.nextCursor.ts;
    beforeId = p.nextCursor.id;
  }
  return out;
}
const walked = walkMessages(2);
check('同毫秒 5 条、limit=2 翻页共取回 5 条', walked.length === 5, walked);
check('无重复 id', new Set(walked).size === 5, walked);
check('覆盖全部 5 条', ['mp-a', 'mp-b', 'mp-c', 'mp-d', 'mp-e'].every((id) => walked.includes(id)), walked);
// 倒序：created_at DESC, id DESC → e,d,c,b,a
check('复合游标倒序正确（e..a）', walked.join(',') === 'mp-e,mp-d,mp-c,mp-b,mp-a', walked);
// sessions 同毫秒分页（轻量覆盖）
session('sp1', 'botP2', 8000);
session('sp2', 'botP2', 8000);
session('sp3', 'botP2', 8000);
const sp: string[] = [];
let sb: number | undefined, sbi: string | undefined;
for (let g = 0; g < 50; g++) {
  const p = observRepo.listSessions('botP2', { before: sb, beforeId: sbi, limit: 1 });
  for (const s of p.items) sp.push(s.id);
  if (p.nextCursor == null) break;
  sb = p.nextCursor.ts;
  sbi = p.nextCursor.id;
}
check('sessions 同毫秒 3 条、limit=1 翻页取回 3 条不重', sp.length === 3 && new Set(sp).size === 3, sp);

// ============================================================
// F) 清理写 API 路由（app.inject）
// ============================================================
console.log('F) 清理 API 路由');
const app = buildApi();
await app.ready();
const inject = async (
  method: string,
  url: string,
  headers?: Record<string, string>
): Promise<{ status: number; data: any; ok: boolean }> => {
  const res = await app.inject({ method: method as any, url, headers });
  const body = JSON.parse(res.payload);
  return { status: res.statusCode, data: body.data, ok: body.ok };
};

session('sApi', 'botApi', now);
run('rApi', 'sApi', 'botApi', 'ok', now, now);
msg('mApi', 'sApi', 'botApi', now);
const delSess = await inject('DELETE', '/api/sessions/sApi');
check('DELETE /api/sessions/:sid → deleted=true', delSess.ok && delSess.data.deleted === true, delSess.data);
check('API 删会话连带清子表', !exists('sessions', 'sApi') && !exists('runs', 'rApi') && !exists('messages', 'mApi'));

session('sH1', 'botHist', now);
session('sH2', 'botHist', now);
const delHist = await inject('DELETE', '/api/bots/botHist/history');
check('DELETE /api/bots/:id/history → sessions=2', delHist.ok && delHist.data.sessions === 2, delHist.data);
check('botHist 历史已清空', !exists('sessions', 'sH1') && !exists('sessions', 'sH2'));

const delBad = await inject('DELETE', '/api/bots/foo.bar/history');
check('非法 botId（含点）→ 400', delBad.status === 400, delBad.status);

session('sRetOld', 'botRet', now - 40 * DAY);
const retRun = await inject('POST', '/api/observ/retention/run?days=30');
check('POST /api/observ/retention/run?days=30 → days=30 + sessions>=1', retRun.ok && retRun.data.days === 30 && retRun.data.sessions >= 1, retRun.data);
check('retention API 删掉了过期会话 sRetOld', !exists('sessions', 'sRetOld'));

// CSRF Origin 护栏：跨源写请求被 403，白名单源放行（修复确认项）
session('sGuard', 'botGuard', now);
const goodOrigin = allowedOrigins()[0]!;
const guardBad = await inject('DELETE', '/api/sessions/sGuard', { origin: 'http://evil.example' });
check('跨源 Origin 写请求 → 403', guardBad.status === 403, guardBad.status);
check('被 403 的会话未被删', exists('sessions', 'sGuard'), goodOrigin);
const guardOk = await inject('DELETE', '/api/sessions/sGuard', { origin: goodOrigin });
check('白名单 Origin 写请求放行 + 删除生效', guardOk.ok && guardOk.data.deleted === true && !exists('sessions', 'sGuard'), { goodOrigin, data: guardOk.data });

// days 取整：?days=0.0001 取整为 0 → 不删（防 cutoff≈当下误删几乎全部）
session('sFloorOld', 'botFloor', now - 40 * DAY);
const retFrac = await inject('POST', '/api/observ/retention/run?days=0.0001');
check('?days=0.0001 → 取整为 0、sessions=0、不误删', retFrac.ok && retFrac.data.days === 0 && retFrac.data.sessions === 0 && exists('sessions', 'sFloorOld'), retFrac.data);

await app.close();
closeDb();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
