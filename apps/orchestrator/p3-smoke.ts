// P3 冒烟：① extractAssistant 解析 Claude 消息内容（text + tool_use 入参）；
// ② 委派事件时间线落库（delegate_start→step→permission_request→decision→ask_question→delegate_end），
//    全部 parentEventId 串联在 delegate_start 之下，验证事件类型/嵌套/seq/出参。
// 重跑：apps/orchestrator/node_modules/.bin/tsx apps/orchestrator/p3-smoke.ts
import { rmSync, existsSync } from 'node:fs';
import { initDb, getDb, closeDb } from './src/db.ts';
import { recorder } from './src/recorder.ts';
import { extractAssistant } from './src/claude/delegation.ts';

const DB = 'd:/tmp/p3-smoke.db';
for (const f of [DB, DB + '-wal', DB + '-shm']) if (existsSync(f)) rmSync(f);

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ''); }
}

// ---------- 1) extractAssistant ----------
const content = [
  { type: 'text', text: '我来帮你改代码。' },
  { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
  { type: 'text', text: '先跑测试。' },
  { type: 'tool_use', name: 'Edit', input: { file_path: '/a.ts', old: 'x', new: 'y' } },
  { type: 'thinking', thinking: '忽略我' },
];
const ex = extractAssistant(content);
check('extractAssistant 拼接 text', ex.text === '我来帮你改代码。先跑测试。', ex.text);
check('extractAssistant 抽出 2 个 tool_use', ex.toolUses.length === 2, ex.toolUses.length);
check('tool_use[0] = Bash + input.command', ex.toolUses[0]?.name === 'Bash' && (ex.toolUses[0]?.input as any)?.command === 'npm test', ex.toolUses[0]);
check('tool_use[1] = Edit + input', ex.toolUses[1]?.name === 'Edit' && (ex.toolUses[1]?.input as any)?.file_path === '/a.ts', ex.toolUses[1]);
check('extractAssistant 非数组 → 空', extractAssistant(undefined).toolUses.length === 0 && extractAssistant('x').text === '');

// ---------- 2) 委派事件时间线 ----------
initDb(DB);
const db = getDb();
const sid = recorder.ensureSession({ botId: 'botD', channelId: 'chanD' });
const rid = recorder.startRun({ sessionId: sid, botId: 'botD', requesterId: 'u1' });

// delegate_start → parentEventId
const parent = recorder.recordEvent({
  runId: rid, sessionId: sid, botId: 'botD', type: 'delegate_start',
  toolName: 'delegate_to_claude', label: '🤖 委派 Claude Code', status: 'running',
  input: { task: '重构 X', cwd: 'd:/proj', resume: false },
});
check('delegate_start 返回非空 eventId', !!parent);

// delegate_step x2
recorder.recordEvent({ runId: rid, sessionId: sid, botId: 'botD', type: 'delegate_step', toolName: 'Read', label: '🔎 阅读代码', status: 'ok', input: { file_path: '/a.ts' }, parentEventId: parent });
recorder.recordEvent({ runId: rid, sessionId: sid, botId: 'botD', type: 'delegate_step', toolName: 'Bash', label: '🔧 执行命令', status: 'ok', input: { command: 'git push' }, parentEventId: parent });

// 危险操作 → 权限请求 + 裁决
recorder.recordEvent({ runId: rid, sessionId: sid, botId: 'botD', type: 'permission_request', toolName: 'Bash', label: '🔐 权限请求', status: 'pending', input: { title: '想执行 git push', detail: 'git push origin main' }, parentEventId: parent });
recorder.recordEvent({ runId: rid, sessionId: sid, botId: 'botD', type: 'permission_decision', toolName: 'Bash', label: '🔐 权限裁决', status: 'allow', parentEventId: parent });

// 反问
recorder.recordEvent({ runId: rid, sessionId: sid, botId: 'botD', type: 'ask_question', label: '❓ 向你提问', status: 'answered', input: [{ question: '用哪个分支?', header: '分支' }], output: { '用哪个分支?': 'main' }, parentEventId: parent });

// delegate_end（含 numTurns/costUsd/rateLimited）
recorder.recordEvent({ runId: rid, sessionId: sid, botId: 'botD', type: 'delegate_end', toolName: 'delegate_to_claude', label: '🤖 委派 Claude Code', status: 'ok', output: { summary: '已完成重构', numTurns: 7, costUsd: 0.123, rateLimited: false, claudeSessionId: 'cs-1' }, parentEventId: parent });

const evts = db.prepare('SELECT seq, type, tool_name, status, parent_event_id, input_json, output_json FROM events WHERE run_id=? ORDER BY seq').all(rid) as any[];
check('共 7 条委派事件', evts.length === 7, evts.length);
const types = evts.map((e) => e.type);
check('事件类型序列正确', JSON.stringify(types) === JSON.stringify(['delegate_start', 'delegate_step', 'delegate_step', 'permission_request', 'permission_decision', 'ask_question', 'delegate_end']), types);
check('seq 连续 1..7', evts.every((e, i) => e.seq === i + 1));
check('delegate_start 无 parent', evts[0]?.parent_event_id === null, evts[0]?.parent_event_id);
check('其余 6 条均挂在 delegate_start 下', evts.slice(1).every((e) => e.parent_event_id === parent), evts.slice(1).map((e) => e.parent_event_id));
const endEvt = evts.find((e) => e.type === 'delegate_end');
const endOut = JSON.parse(endEvt.output_json);
check('delegate_end 出参含 numTurns/costUsd/summary', endOut.numTurns === 7 && endOut.costUsd === 0.123 && endOut.summary === '已完成重构', endOut);
const permDecision = evts.find((e) => e.type === 'permission_decision');
check('permission_decision status=allow', permDecision?.status === 'allow');
const stepBash = evts.find((e) => e.type === 'delegate_step' && e.tool_name === 'Bash');
check('delegate_step(Bash) 入参含 git push 命令', JSON.parse(stepBash.input_json)?.command === 'git push', stepBash?.input_json);
const askEvt = evts.find((e) => e.type === 'ask_question');
check('ask_question 出参含答案', JSON.parse(askEvt.output_json)?.['用哪个分支?'] === 'main', askEvt?.output_json);

closeDb();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
