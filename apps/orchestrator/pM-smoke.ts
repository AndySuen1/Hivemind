// pM 日志系统冒烟：log-collector 采集（patch stdout/stderr → 行解析 → level 推断 → 脱敏 → 批量落盘）
// + 游标分页 + ingest 去重 + onLog 订阅 + retention 清理 + HTTP 路由（inject）。
// 重跑：apps/orchestrator/node_modules/.bin/tsx apps/orchestrator/pM-smoke.ts
import http from 'node:http';
import { rmSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { LogEntry } from '@hivemind/shared';
import { initDb, closeDb, getDb } from './src/db.ts';
import { logCollector } from './src/log-collector.ts';
import { purgeLogsByRetention } from './src/observ-retention.ts';
import { buildApi } from './src/api.ts';

const DB = 'd:/tmp/pM-smoke.db';
for (const f of [DB, DB + '-wal', DB + '-shm']) if (existsSync(f)) rmSync(f);

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ''); }
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 直写真实 stdout/stderr（绕过被 patch 的 console，便于在 patch 后产生「被采集」的行）。
const out = (s: string): void => { process.stdout.write(s + '\n'); };
const err = (s: string): void => { process.stderr.write(s + '\n'); };

// 从 DB 取最近匹配 q 的日志（先 flush 确保落盘）。
function find(q: string): LogEntry[] {
  logCollector.flush();
  return logCollector.list({ q, limit: 500 }).items;
}

initDb(DB);
logCollector.install();
logCollector.initStore(getDb());

// ---------- 1) 采集 + level 推断 + tag 解析 ----------
out('[boot] hello-world MARK-INFO');
err('something failed badly MARK-ERR');
err('just some stderr noise MARK-PLAIN');
out('[bot:Alpha] working MARK-TAG');

const info = find('MARK-INFO')[0];
check('采集到 stdout 行', !!info, info);
check('stdout 默认 level=info', info?.level === 'info', info?.level);
check('解析 tag=boot', info?.tag === 'boot', info?.tag);
check('source=orchestrator', info?.source === 'orchestrator', info?.source);

check('含 error 关键词 → level=error', find('MARK-ERR')[0]?.level === 'error', find('MARK-ERR')[0]?.level);
check('普通 stderr → level=warn', find('MARK-PLAIN')[0]?.level === 'warn', find('MARK-PLAIN')[0]?.level);
check('解析 tag=bot:Alpha', find('MARK-TAG')[0]?.tag === 'bot:Alpha', find('MARK-TAG')[0]?.tag);

// ---------- 2) 脱敏（redactText） ----------
out('leaked key sk-ant-ABCDEFGHIJKLMNOP123456 MARK-SECRET');
const secret = find('MARK-SECRET')[0];
check('密钥被脱敏（出现 ‹redacted›）', !!secret && secret.message.includes('‹redacted›'), secret?.message);
check('密钥明文不入库', !!secret && !secret.message.includes('ABCDEFGHIJKLMNOP'), secret?.message);

// ---------- 3) 批量落盘 + 游标分页 ----------
for (let i = 0; i < 30; i++) out(`bulk line ${i} MARK-BULK`);
logCollector.flush();
const page1 = logCollector.list({ q: 'MARK-BULK', limit: 10 });
check('第一页 10 条', page1.items.length === 10, page1.items.length);
check('有 nextCursor', page1.nextCursor != null, page1.nextCursor);
const page2 = logCollector.list({ q: 'MARK-BULK', limit: 10, before: page1.nextCursor!.ts, beforeId: page1.nextCursor!.id });
check('第二页 10 条', page2.items.length === 10, page2.items.length);
check('两页不重叠', !page1.items.some((a) => page2.items.some((b) => b.id === a.id)));
check('倒序：第二页时间 <= 第一页', (page2.items[0]?.ts ?? 0) <= (page1.items[page1.items.length - 1]?.ts ?? 0));

// ---------- 4) ingest 去重（orchestrator）+ 接纳（dashboard） ----------
out('[bot:Dup] duplicated line MARK-DUP');
logCollector.flush();
const before = find('MARK-DUP').length;
const dupAccepted = logCollector.ingest({ entries: [{ source: 'orchestrator', message: '[bot:Dup] duplicated line MARK-DUP', ts: Date.now() }] });
check('ingest：orchestrator 重复行被去重（accepted=0）', dupAccepted === 0, dupAccepted);
check('ingest：去重后 MARK-DUP 仍只有 1 条', find('MARK-DUP').length === before, find('MARK-DUP').length);

const dashAccepted = logCollector.ingest({ entries: [{ source: 'dashboard', message: 'next ready MARK-DASH', ts: Date.now(), stream: 'out' }] });
check('ingest：dashboard 行被接纳（accepted=1）', dashAccepted === 1, dashAccepted);
const dash = find('MARK-DASH')[0];
check('ingest：source=dashboard', dash?.source === 'dashboard', dash?.source);

// ---------- 5) onLog 订阅投递 ----------
const got: LogEntry[] = [];
const off = logCollector.onLog((e) => { if (e.message.includes('MARK-LIVE')) got.push(e); });
out('realtime push MARK-LIVE');
off();
out('after-unsub MARK-LIVE-2');
check('onLog 收到实时日志', got.length === 1 && got[0]!.message.includes('MARK-LIVE'), got.map((g) => g.message));
check('退订后不再收', got.every((g) => !g.message.includes('MARK-LIVE-2')));

// ---------- 6) retention 清理 ----------
const oldTs = Date.now() - 100 * 24 * 60 * 60 * 1000; // 100 天前
getDb().prepare('INSERT INTO logs (id, seq, ts, source, level, tag, message) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run(randomUUID(), 999999, oldTs, 'orchestrator', 'info', null, 'ANCIENT MARK-OLD');
check('retention 前能查到旧日志', find('MARK-OLD').length === 1, find('MARK-OLD').length);
const purged = purgeLogsByRetention(7);
check('purgeLogsByRetention 删了 1 条', purged.logs === 1, purged);
check('retention 后查不到旧日志', find('MARK-OLD').length === 0, find('MARK-OLD').length);

// ---------- 7) 实时 SSE /api/logs/stream（真实 listen + 原生 http 读流） ----------
const app = buildApi();
await app.listen({ port: 0, host: '127.0.0.1' });
const addr = app.server.address();
const ssePort = typeof addr === 'object' && addr ? addr.port : 0;

const sseRecords: LogEntry[] = [];
const sseReq = http.request({ host: '127.0.0.1', port: ssePort, path: '/api/logs/stream?level=error', method: 'GET', headers: { Origin: 'http://localhost:3000' } }, (res) => {
  res.setEncoding('utf8');
  let buf = '';
  res.on('data', (c: string) => {
    buf += c;
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const dl = frame.split('\n').find((l) => l.startsWith('data:'));
      if (dl) { try { sseRecords.push(JSON.parse(dl.slice(5).trim())); } catch { /* ignore */ } }
    }
  });
});
sseReq.end();
await wait(150);
err('Error: boom something MARK-SSE-ERR');   // error 级 → 命中 level=error 过滤
out('info noise MARK-SSE-INFO');             // info 级 → 不应推给该订阅
await wait(200);
check('SSE 收到 error 级日志', sseRecords.some((r) => r.message.includes('MARK-SSE-ERR')), sseRecords.map((r) => r.message));
check('SSE level 过滤：不收 info', !sseRecords.some((r) => r.message.includes('MARK-SSE-INFO')));
sseReq.destroy();
await wait(50);

// ---------- 8) HTTP 路由（inject）：GET /api/logs + POST /api/logs/ingest + DELETE ----------

const listRes = await app.inject({ method: 'GET', url: '/api/logs?q=MARK-DASH&limit=10' });
const listBody = listRes.json() as { ok: boolean; data: { items: LogEntry[] } };
check('GET /api/logs 200 + ok', listRes.statusCode === 200 && listBody.ok, listRes.statusCode);
check('GET /api/logs 命中 MARK-DASH', listBody.data.items.some((i) => i.message.includes('MARK-DASH')));

const ingRes = await app.inject({ method: 'POST', url: '/api/logs/ingest', payload: { entries: [{ source: 'launcher', message: '[pm] start MARK-HTTP-INGEST', ts: Date.now(), stream: 'out' }] } });
const ingBody = ingRes.json() as { ok: boolean; data: { accepted: number } };
check('POST /api/logs/ingest 接纳 1 条', ingRes.statusCode === 200 && ingBody.data.accepted === 1, ingBody);
check('ingest 的 launcher 行可查到', find('MARK-HTTP-INGEST').some((e) => e.source === 'launcher'));

const ingBad = await app.inject({ method: 'POST', url: '/api/logs/ingest', payload: { entries: [{ bad: true }] } });
check('POST /api/logs/ingest 非法 body → 400', ingBad.statusCode === 400, ingBad.statusCode);

const delRes = await app.inject({ method: 'DELETE', url: '/api/logs' });
check('DELETE /api/logs 200', delRes.statusCode === 200, delRes.statusCode);
check('清空后查不到任何 MARK', find('MARK-DASH').length === 0 && find('MARK-BULK').length === 0);

await app.close();
closeDb();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
