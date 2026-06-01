// P5 SSE 冒烟：真实 listen + 原生 http 客户端读 text/event-stream，验证过滤/投递/CORS/断开清理。
// 重跑：apps/orchestrator/node_modules/.bin/tsx apps/orchestrator/p5-smoke.ts
import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import { rmSync, existsSync } from 'node:fs';
import { initDb, closeDb } from './src/db.ts';
import { buildApi } from './src/api.ts';
import { recorder } from './src/recorder.ts';

const DB = 'd:/tmp/p5-smoke.db';
for (const f of [DB, DB + '-wal', DB + '-shm']) if (existsSync(f)) rmSync(f);

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ''); }
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

initDb(DB);
const app = buildApi();
await app.listen({ port: 0, host: '127.0.0.1' });
const addr = app.server.address();
const port = typeof addr === 'object' && addr ? addr.port : 0;

interface Client {
  records: any[];
  ready: Promise<IncomingMessage>;
  close: () => void;
}
function connect(query: string): Client {
  const records: any[] = [];
  let resolveReady: (r: IncomingMessage) => void;
  const ready = new Promise<IncomingMessage>((r) => { resolveReady = r; });
  const req = http.request(
    { host: '127.0.0.1', port, path: `/api/stream${query}`, method: 'GET', headers: { Origin: 'http://localhost:3000' } },
    (res) => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (c: string) => {
        buf += c;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const dl = frame.split('\n').find((l) => l.startsWith('data:'));
          if (dl) {
            try { records.push(JSON.parse(dl.slice(5).trim())); } catch { /* ignore */ }
          }
        }
      });
      resolveReady(res);
    }
  );
  req.end();
  return { records, ready, close: () => req.destroy() };
}

// ---------- 1) botId 过滤 + CORS + 四种记录投递 ----------
const baseListeners = recorder.bus.listenerCount('record');
const a = connect('?botId=botS');
const resA = await a.ready;
check('SSE 响应 Content-Type=text/event-stream', String(resA.headers['content-type']).includes('text/event-stream'), resA.headers['content-type']);
check('SSE 手补 CORS 头(echo Origin)', resA.headers['access-control-allow-origin'] === 'http://localhost:3000', resA.headers['access-control-allow-origin']);
const b = connect('?botId=botOther');
await b.ready;
check('连接后 recorder 监听器 +2', recorder.bus.listenerCount('record') === baseListeners + 2, recorder.bus.listenerCount('record'));

// 触发 botS 全链路：session(create) + run(start) + message + event + run(end)
const sid = recorder.ensureSession({ botId: 'botS', channelId: 'c1', channelType: 'dm' });
const rid = recorder.startRun({ sessionId: sid, botId: 'botS', requesterId: 'u1' });
recorder.recordMessage({ sessionId: sid, runId: rid, botId: 'botS', role: 'user', content: 'hi' });
recorder.recordEvent({ runId: rid, sessionId: sid, botId: 'botS', type: 'tool_call', toolName: 'read_file' });
recorder.endRun(rid, { status: 'ok', toolCallCount: 1 });
await wait(200);

const kindsA = a.records.map((r) => r.kind);
check('A(botS) 收到 session', kindsA.includes('session'));
check('A(botS) 收到 run(start+end 共 2)', kindsA.filter((k) => k === 'run').length === 2, kindsA);
check('A(botS) 收到 message', kindsA.includes('message'));
check('A(botS) 收到 event', kindsA.includes('event'));
check('A 收到的都是 botS', a.records.every((r) => r.row.botId === 'botS'));
check('B(botOther) 一条都没收到（botId 过滤）', b.records.length === 0, b.records.length);

// ---------- 2) runId 过滤排除 session ----------
const r2 = connect(`?runId=${rid}`);
await r2.ready;
// 触发：新 session(create，无 runId) + 同 rid 下一个 event
recorder.ensureSession({ botId: 'botS', channelId: 'c2', channelType: 'dm' }); // 新会话广播 session
recorder.recordEvent({ runId: rid, sessionId: sid, botId: 'botS', type: 'tool_call', toolName: 'grep' });
await wait(200);
check('runId 过滤：收到该 run 的 event', r2.records.some((r) => r.kind === 'event'), r2.records.map((r) => r.kind));
check('runId 过滤：不收 session（session 无 runId）', r2.records.every((r) => r.kind !== 'session'), r2.records.map((r) => r.kind));

// ---------- 3) sessionId 过滤 ----------
const s2 = connect(`?sessionId=${sid}`);
await s2.ready;
recorder.recordEvent({ runId: rid, sessionId: sid, botId: 'botS', type: 'tool_call', toolName: 'ls' }); // 属 sid
const otherSid = recorder.ensureSession({ botId: 'botS', channelId: 'c3' }); // 新会话（不同 sessionId）
recorder.recordEvent({ runId: rid, sessionId: otherSid, botId: 'botS', type: 'error' }); // 属 otherSid
await wait(200);
check('sessionId 过滤：收到本会话 event', s2.records.some((r) => r.kind === 'event' && r.row.sessionId === sid), s2.records.map((r) => [r.kind, r.row.sessionId]));
check('sessionId 过滤：不收其他会话的 event', s2.records.every((r) => r.row.sessionId === sid || (r.kind === 'session' && r.row.id === sid)), s2.records.map((r) => [r.kind, r.row.sessionId ?? r.row.id]));

// ---------- 4) 断开清理 ----------
a.close(); b.close(); r2.close(); s2.close();
await wait(250);
check('全部断开后监听器归零（回到基线）', recorder.bus.listenerCount('record') === baseListeners, recorder.bus.listenerCount('record'));

await app.close();
closeDb();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
