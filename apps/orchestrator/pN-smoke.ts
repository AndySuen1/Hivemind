// pN = Claude 帖直通冒烟：① thread-session-repo CRUD + bot_id 校验 + updateSession + reset 链；
//      ② classifyThreadMessage 四分支（create/passthrough/reset/normal）；
//      ③ ThreadStreamSink 渲染（命令原文逐条贴 / 纯读结果不贴 / 大输出转附件 / 分块 / 滑窗节流 fake clock）；
//      ④ cwd path-guard（白名单内放行 / 越界拒绝）。
// 纯逻辑，临时 DB（不连真 Discord / 真 Claude）。
// 重跑：apps/orchestrator/node_modules/.bin/tsx apps/orchestrator/pN-smoke.ts
import { rmSync, existsSync } from 'node:fs';
import { initDb, getDb } from './src/db.ts';
import { threadSessionRepo } from './src/thread-session-repo.ts';
import { classifyThreadMessage } from './src/thread-router.ts';
import { ThreadStreamSink, chunk1900, type ThreadStreamTarget } from './src/claude/thread-stream-sink.ts';
import { assertRealpathAllowed } from './src/tools/path-guard.ts';

const DB = 'd:/tmp/pN-smoke.db';
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

// ============================================================
console.log('— ① thread-session-repo CRUD + reset 链 —');
{
  threadSessionRepo.create({ threadId: 'th1', botId: 'b1', forumChannelId: 'f1', cwd: 'd:/tmp', requesterId: 'u1', title: '会话A' });
  const got = threadSessionRepo.getByThread('b1', 'th1');
  check('create→getByThread 命中', !!got && got.threadId === 'th1', got);
  check('建帖瞬间 claudeSessionId 空', !!got && got.claudeSessionId === undefined, got?.claudeSessionId);
  check('status=active / resetCount=0', !!got && got.status === 'active' && got.resetCount === 0, got);

  check('跨 bot 不命中（bot_id 校验）', threadSessionRepo.getByThread('b2', 'th1') === null);

  threadSessionRepo.updateSession('th1', 'sess-1');
  check('updateSession 刷新 claudeSessionId', threadSessionRepo.getByThread('b1', 'th1')?.claudeSessionId === 'sess-1');

  threadSessionRepo.recordReset({ threadId: 'th1', oldSession: 'sess-1', newSession: 'sess-2', handoffDoc: 'd:/tmp/doc.md', openingLine: '续接' });
  const afterReset = threadSessionRepo.getByThread('b1', 'th1');
  check('recordReset：reset_count++', afterReset?.resetCount === 1, afterReset?.resetCount);
  check('recordReset：claudeSessionId=新 session', afterReset?.claudeSessionId === 'sess-2', afterReset?.claudeSessionId);
  const resets = getDb().prepare('SELECT * FROM thread_session_resets WHERE thread_id = ?').all('th1') as any[];
  check('reset 链表追加 1 行', resets.length === 1 && resets[0].old_session === 'sess-1' && resets[0].new_session === 'sess-2', resets);

  check('listActive 含本帖', threadSessionRepo.listActive('b1').length === 1);
  threadSessionRepo.close('th1');
  check('close→status=closed', threadSessionRepo.getByThread('b1', 'th1')?.status === 'closed');
  check('close 后 listActive 为空', threadSessionRepo.listActive('b1').length === 0);
}

// ============================================================
console.log('— ② classifyThreadMessage 四分支 —');
{
  const base = {
    enabled: true,
    forumChannelId: 'f1',
    triggerKeyword: '新建会话',
    resetKeywords: ['/reset', '重开'],
  };
  // create：非帖内 + @bot + 触发词
  const create = classifyThreadMessage({ ...base, isThread: false, isMentioned: true, content: '新建会话 修复登录bug', boundActive: false });
  check('create 分支', create.kind === 'create' && (create as any).prompt === '修复登录bug', create);
  // passthrough：绑定帖内任意消息
  const pass2 = classifyThreadMessage({ ...base, isThread: true, isMentioned: false, content: '继续改', boundActive: true });
  check('passthrough 分支（免@）', pass2.kind === 'passthrough', pass2);
  // reset：帖内命中重开关键词
  const reset = classifyThreadMessage({ ...base, isThread: true, isMentioned: false, content: '重开 换个思路', boundActive: true });
  check('reset 分支', reset.kind === 'reset' && (reset as any).instruction === '换个思路', reset);
  // normal：未启用 / 普通 @bot 非触发词 / 未绑定帖
  check('未启用 → normal', classifyThreadMessage({ ...base, enabled: false, isThread: false, isMentioned: true, content: '新建会话 x', boundActive: false }).kind === 'normal');
  check('普通 @bot 非触发词 → normal', classifyThreadMessage({ ...base, isThread: false, isMentioned: true, content: '你好', boundActive: false }).kind === 'normal');
  check('未绑定帖内消息 → normal', classifyThreadMessage({ ...base, isThread: true, isMentioned: false, content: 'hi', boundActive: false }).kind === 'normal');
  check('"重开机" 不误命中重开', classifyThreadMessage({ ...base, isThread: true, isMentioned: false, content: '重开机试试', boundActive: true }).kind === 'passthrough');
}

// ============================================================
console.log('— ③ ThreadStreamSink 渲染 + 节流 —');
{
  // mock target：收集 send/file，注入 fake 时钟
  function makeTarget(): { t: ThreadStreamTarget; sends: string[]; files: { name: string; content: string }[]; sleeps: number[] } {
    const sends: string[] = [];
    const files: { name: string; content: string }[] = [];
    const sleeps: number[] = [];
    let fakeNow = 1_000_000;
    return {
      sends,
      files,
      sleeps,
      t: {
        send: async (content) => void sends.push(content),
        sendFile: async (name, content) => void files.push({ name, content }),
        now: () => fakeNow,
        sleep: async (ms) => {
          sleeps.push(ms);
          fakeNow += ms;
        },
      },
    };
  }

  // 命令原文逐条贴 + 纯读结果不贴
  {
    const m = makeTarget();
    const sink = new ThreadStreamSink(m.t);
    await sink.onAssistant('我来改代码。', [{ name: 'Bash', input: { command: 'pnpm test' }, id: 'tu-bash' }]);
    await sink.onAssistant('', [{ name: 'Read', input: { file_path: 'src/a.ts' }, id: 'tu-read' }]);
    await sink.flush();
    const all = m.sends.join('\n');
    check('贴出 assistant 文本原文', all.includes('我来改代码。'), m.sends);
    check('贴出 Bash 命令原文（pnpm test）', all.includes('pnpm test') && all.includes('🔧'), m.sends);
    check('贴出 Read 工具行', all.includes('读取'), m.sends);

    // tool_result：Bash 结果贴出；Read 结果（纯读）不贴
    await sink.onToolResult([{ toolUseId: 'tu-bash', content: '5 passed', isError: false }]);
    await sink.onToolResult([{ toolUseId: 'tu-read', content: 'file contents here', isError: false }]);
    await sink.flush();
    const all2 = m.sends.join('\n');
    check('Bash 结果被贴出', all2.includes('5 passed'), m.sends);
    check('纯读(Read)结果不贴', !all2.includes('file contents here'), m.sends);
  }

  // 大输出 → 附件
  {
    const m = makeTarget();
    const sink = new ThreadStreamSink(m.t);
    const big = 'x'.repeat(5000);
    await sink.onAssistant('', [{ name: 'Bash', input: { command: 'echo big' }, id: 'tu-b2' }]);
    await sink.onToolResult([{ toolUseId: 'tu-b2', content: big, isError: false }]);
    await sink.flush();
    check('大工具结果走附件', m.files.length === 1 && m.files[0]!.content.includes('xxxxx'), m.files.length);
  }

  // 节流：连发 6 条 → 至少 1 次 sleep（滑窗 5/5s，fake clock）
  {
    const m = makeTarget();
    const sink = new ThreadStreamSink(m.t);
    for (let i = 0; i < 6; i++) sink.notice(`line ${i}`);
    await sink.flush();
    check('6 条消息触发滑窗节流 sleep', m.sleeps.length >= 1, m.sleeps);
    check('6 条都发出（节流不丢消息）', m.sends.length === 6, m.sends.length);
  }

  // chunk1900：超长文本分块
  {
    const parts = chunk1900('a'.repeat(4000));
    check('chunk1900 把 4000 字符切成多块', parts.length >= 3 && parts.every((p) => p.length <= 1900), parts.map((p) => p.length));
  }
}

// ============================================================
console.log('— ④ cwd path-guard —');
{
  let okPath = '';
  try {
    okPath = assertRealpathAllowed('d:/tmp/proj', ['d:/tmp']);
  } catch {
    okPath = '';
  }
  check('白名单内目录放行', okPath !== '');

  let rejected = false;
  try {
    assertRealpathAllowed('d:/Windows', ['d:/tmp']);
  } catch {
    rejected = true;
  }
  check('越界目录被拒绝', rejected);

  let emptyRejected = false;
  try {
    assertRealpathAllowed('d:/tmp/x', []);
  } catch {
    emptyRejected = true;
  }
  check('空白名单 fail-closed', emptyRejected);
}

console.log(`\npN Claude 帖直通冒烟：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
