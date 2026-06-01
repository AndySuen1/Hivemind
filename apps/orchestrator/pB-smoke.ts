// Phase B 冒烟（L2 滚动摘要）：migration 0006 + conversation-repo round-trip + ConversationSummarizer 串行 fold
// + composeSystemPrompt 注入。用确定性 mock fold 函数（不调真 LLM）。
// 重跑：apps/orchestrator/node_modules/.bin/tsx apps/orchestrator/pB-smoke.ts
import { rmSync, existsSync } from 'node:fs';
import type { ModelMessage } from 'ai';
import type { Bot } from '@hivemind/shared';
import { initDb, getDb, closeDb } from './src/db.ts';
import { conversationRepo } from './src/conversation-repo.ts';
import { ConversationSummarizer, renderDroppedTurns, capSummary, type FoldFn } from './src/conversation-memory.ts';
import { composeSystemPrompt, type BotToolRuntime } from './src/tools/index.ts';

const DB = 'd:/tmp/pB-smoke.db';
for (const f of [DB, DB + '-wal', DB + '-shm']) if (existsSync(f)) rmSync(f);

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ''); }
}

initDb(DB);
const db = getDb();

// migration 0006 已应用：表存在
const tbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_state'").get();
check('migration 0006: conversation_state 表存在', !!tbl, tbl);

// 种一个会话（conversation_state.session_id 有 FK→sessions）
db.prepare('INSERT INTO sessions (id,bot_id,channel_id,channel_type,channel_name,guild_id,title,created_at,last_active_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run('s1', 'botA', 'cA', 'dm', null, null, '会话A', 1000, 5000);

// 1) conversation-repo round-trip
conversationRepo.upsertSummary('s1', 'botA', '摘要v1');
check('repo: getSummary 读到 v1', conversationRepo.getSummary('s1') === '摘要v1');
conversationRepo.upsertSummary('s1', 'botA', '摘要v2', 'msg-9');
const st = conversationRepo.getState('s1');
check('repo: upsert 覆盖为 v2 + through 记录', st?.summary === '摘要v2' && st?.summarizedThroughMsgId === 'msg-9', st);
check('repo: 未知会话 getSummary→空', conversationRepo.getSummary('nope') === '', conversationRepo.getSummary('nope'));

// 2) 纯函数
check('renderDroppedTurns 渲染角色', renderDroppedTurns([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }]) === '用户：hi\n助手：yo');
check('capSummary 截断到上限', capSummary('x'.repeat(50), 10).length === 10);

// 3) ConversationSummarizer：getForInjection 懒载入 + 串行 fold 累积
// mock fold：把新增轮追加到旧摘要（确定性），便于断言串行顺序
const foldFn: FoldFn = async (old: string, dropped: ModelMessage[]) =>
  capSummary((old ? old + ' | ' : '') + renderDroppedTurns(dropped));
const sum = new ConversationSummarizer(foldFn);

// getForInjection 懒从 DB 载入现有摘要（s1 现为 v2）
check('summarizer: getForInjection 懒载入 DB 现值', sum.getForInjection('s1') === '摘要v2', sum.getForInjection('s1'));

// 用新会话 s2 测 fold（从空开始）
db.prepare('INSERT INTO sessions (id,bot_id,channel_id,channel_type,channel_name,guild_id,title,created_at,last_active_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run('s2', 'botA', 'cB', 'dm', null, null, '会话B', 1000, 5000);
check('summarizer: s2 初始空', sum.getForInjection('s2') === '');

// 并发两次 note：必须串行、第二次建立在第一次结果上（不互相覆盖）
sum.note('s2', 'botA', [{ role: 'user', content: 'U1' }, { role: 'assistant', content: 'A1' }]);
sum.note('s2', 'botA', [{ role: 'user', content: 'U2' }, { role: 'assistant', content: 'A2' }]);
await sum.settle('s2');
const folded = sum.getForInjection('s2');
check('summarizer: 串行 fold 累积两批', folded === '用户：U1\n助手：A1 | 用户：U2\n助手：A2', folded);
check('summarizer: fold 结果落库', conversationRepo.getSummary('s2') === folded, conversationRepo.getSummary('s2'));

// 空 dropped → 不触发
sum.note('s2', 'botA', []);
await sum.settle('s2');
check('summarizer: 空 dropped 不改摘要', conversationRepo.getSummary('s2') === folded);

// 4) composeSystemPrompt 注入摘要 + 检索片段（均带反注入外壳）
const fakeBot = { systemPrompt: 'PERSONA' } as Bot;
const runtime: BotToolRuntime = { tools: {}, memoryDir: null, staticPromptSuffix: '' };
const sp = composeSystemPrompt(fakeBot, runtime, { summary: '这是摘要', retrieved: '这是片段' });
check('compose: 含人格', sp.includes('PERSONA'));
check('compose: 含摘要正文 + 标题', sp.includes('这是摘要') && sp.includes('本会话历史摘要'), sp);
check('compose: 含检索片段 + 标题', sp.includes('这是片段') && sp.includes('相关历史片段'));
check('compose: 无 extras 时不注入摘要标题', !composeSystemPrompt(fakeBot, runtime).includes('本会话历史摘要'));

closeDb();
for (const f of [DB, DB + '-wal', DB + '-shm']) if (existsSync(f)) rmSync(f);
console.log(`\nPhase B 冒烟：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
