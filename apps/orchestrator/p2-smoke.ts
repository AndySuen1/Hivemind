// P2 集成冒烟：mock LLM 驱动真实工具调用 → generateAgentReply 的 onStepFinish →
// 复刻 bot-manager 的埋点闭包（observe-helpers + recorder）→ 临时 DB。验证字段/预览/错误状态/会话回合链路。
// 放在 src 外，避免进 tsc；tsx 直接跑：apps/orchestrator/node_modules/.bin/tsx apps/orchestrator/p2-smoke.ts
import { rmSync, existsSync } from 'node:fs';
import { z } from 'zod';
import { tool } from 'ai';
import { initDb, getDb, closeDb } from './src/db.ts';
import { recorder } from './src/recorder.ts';
import { generateAgentReply, type ToolResultObservation } from './src/llm.ts';
import { sessionMetaFromMessage, localToolLabel, shapeToolInput, isToolError } from './src/observe-helpers.ts';

const DB = 'd:/tmp/p2-smoke.db';
for (const f of [DB, DB + '-wal', DB + '-shm']) if (existsSync(f)) rmSync(f);

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ''); }
}

initDb(DB);
const db = getDb();

// --- 测试工具集：write_file（大 content 测 2KB 预览）、read_file（返回错误测 status）、web_search ---
const tools = {
  write_file: tool({
    description: 'w',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async ({ path, content }) => `已写入 ${path}（${content.length} 字节）`,
  }),
  read_file: tool({
    description: 'r',
    inputSchema: z.object({ path: z.string() }),
    execute: async () => '错误：文件不存在',
  }),
  // execute 抛异常 → SDK 产生 tool-error content part（只进 step.content、不进 toolResults）
  boom: tool({
    description: 'b',
    inputSchema: z.object({}),
    execute: async () => {
      throw new Error('boom failed');
    },
  }),
};

const bigContent = 'C'.repeat(5000); // 5KB，shapeToolInput 应裁到 ~2KB

// 最小 LanguageModelV2 mock（generateText 只用 doGenerate）：第一步发两个工具调用，第二步出最终文本。
const responses: any[] = [
  {
    content: [
      { type: 'tool-call', toolCallId: 'c1', toolName: 'write_file', input: JSON.stringify({ path: '/x/a.txt', content: bigContent }) },
      { type: 'tool-call', toolCallId: 'c2', toolName: 'read_file', input: JSON.stringify({ path: '/x/missing' }) },
      { type: 'tool-call', toolCallId: 'c3', toolName: 'boom', input: '{}' },
    ],
    finishReason: 'tool-calls',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    warnings: [],
  },
  {
    content: [{ type: 'text', text: '我已写入并尝试读取。' }],
    finishReason: 'stop',
    usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
    warnings: [],
  },
];
let callIndex = 0;
const model: any = {
  specificationVersion: 'v2',
  provider: 'mock',
  modelId: 'mock-test',
  supportedUrls: {},
  async doGenerate() {
    const resp = responses[Math.min(callIndex, responses.length - 1)];
    callIndex++;
    return resp;
  },
  async doStream() {
    throw new Error('doStream 不应被调用');
  },
};

// --- 复刻 bot-manager 的可观测链路 ---
const sessionId = recorder.ensureSession({ botId: 'botX', channelId: 'chanY', channelType: 'guild', channelName: '#general', guildId: 'g1', title: '测试问题' });
const runId = recorder.startRun({ sessionId, botId: 'botX', requesterId: 'userZ' });
recorder.recordMessage({ sessionId, runId, botId: 'botX', role: 'user', content: '帮我写文件并读一个不存在的', authorId: 'userZ', authorName: 'sun' });

const observed: ToolResultObservation[] = [];

const { text, usage, toolCallCount, finishReason } = await generateAgentReply({
  model: model as any,
  systemPrompt: '你是测试助手',
  history: [],
  userText: '帮我写文件并读一个不存在的',
  tools: tools as any,
  onToolResult: (r) => {
    observed.push(r);
    recorder.recordEvent({
      runId, sessionId, botId: 'botX',
      type: 'tool_call',
      toolName: r.toolName,
      label: localToolLabel(r.toolName),
      status: isToolError(r.output) ? 'error' : 'ok',
      input: shapeToolInput(r.toolName, r.input),
      output: r.output,
    });
  },
});

recorder.recordMessage({ sessionId, runId, botId: 'botX', role: 'assistant', content: text });
recorder.endRun(runId, { status: 'ok', finishReason, toolCallCount, usage });

// --- 断言 1：onToolResult 收到正确的 toolName/input/output（llm.ts 的 SDK 字段对接） ---
check('onToolResult 触发 3 次（含 tool-error）', observed.length === 3, observed.length);
const w = observed.find((o) => o.toolName === 'write_file');
const r = observed.find((o) => o.toolName === 'read_file');
const b = observed.find((o) => o.toolName === 'boom');
check('write_file input 含 path/content（已解析为对象）', !!w && (w.input as any)?.path === '/x/a.txt' && (w.input as any)?.content === bigContent, w?.input && { path: (w!.input as any).path, len: (w!.input as any).content?.length });
check('write_file output 为成功串', typeof w?.output === 'string' && (w!.output as string).startsWith('已写入'), w?.output);
check('read_file output 为错误串', r?.output === '错误：文件不存在', r?.output);
check('tool-error 被捕获（boom，output 以 错误：[tool-error] 开头）', typeof b?.output === 'string' && (b!.output as string).startsWith('错误：[tool-error]'), b?.output);

// --- 断言 2：最终文本/计数/finishReason ---
check('最终文本正确', text === '我已写入并尝试读取。', text);
check('toolCallCount = 3', toolCallCount === 3, toolCallCount);
check('finishReason = stop', finishReason === 'stop', finishReason);

// --- 断言 3：DB 事件落库 + shapeToolInput 预览 + 错误状态 ---
const evts = db.prepare('SELECT tool_name, label, status, input_json, output_json, seq FROM events WHERE run_id=? ORDER BY seq').all(runId) as any[];
check('DB 有 3 条 tool_call 事件', evts.length === 3, evts.length);
const bEvt = evts.find((e) => e.tool_name === 'boom');
check('boom 事件 status=error', bEvt?.status === 'error', bEvt?.status);
const wEvt = evts.find((e) => e.tool_name === 'write_file');
const rEvt = evts.find((e) => e.tool_name === 'read_file');
const wInput = JSON.parse(wEvt.input_json);
check('write_file 入库 content 被裁到 ~2KB（<2.2KB）', Buffer.byteLength(wInput.content, 'utf8') <= 2.2 * 1024 && wInput.content.length < 5000, Buffer.byteLength(wInput.content, 'utf8'));
check('write_file content 含截断标记', wInput.content.includes('…[截断]'));
check('write_file label 正确', wEvt.label === '✏️ 写入/编辑文件', wEvt.label);
check('write_file status=ok', wEvt.status === 'ok');
check('read_file status=error（错误：前缀）', rEvt.status === 'error', rEvt.status);
check('事件 seq 为 1,2,3', evts[0]?.seq === 1 && evts[1]?.seq === 2 && evts[2]?.seq === 3);

// --- 断言 4：会话/回合/消息链路 ---
const sess = db.prepare('SELECT channel_name, channel_type, guild_id, title FROM sessions WHERE id=?').get(sessionId) as any;
check('会话元信息落库', sess.channel_name === '#general' && sess.channel_type === 'guild' && sess.guild_id === 'g1' && sess.title === '测试问题', sess);
const run = db.prepare('SELECT status, tool_call_count, finish_reason, ended_at, usage_json FROM runs WHERE id=?').get(runId) as any;
check('回合 status=ok + 计数 + finishReason + ended_at', run.status === 'ok' && run.tool_call_count === 3 && run.finish_reason === 'stop' && !!run.ended_at, run);
check('回合 usage_json 含 totalTokens', String(run.usage_json).includes('28') || String(run.usage_json).includes('totalTokens'), run.usage_json);
const msgs = db.prepare("SELECT role, content FROM messages WHERE run_id=? ORDER BY created_at").all(runId) as any[];
check('消息 = user + assistant', msgs.length === 2 && msgs.some((m) => m.role === 'user') && msgs.some((m) => m.role === 'assistant'), msgs.map((m) => m.role));

// --- 断言 5：sessionMetaFromMessage 对 DM/guild 桩对象 ---
const dmMeta = sessionMetaFromMessage({ channel: { id: 'd1', isDMBased: () => true }, guildId: null } as any);
check('DM: channelType=dm + guildId 省略', dmMeta.channelType === 'dm' && dmMeta.channelId === 'd1' && dmMeta.guildId === undefined, dmMeta);
const guildMeta = sessionMetaFromMessage({ channel: { id: 'c9', isDMBased: () => false, name: '闲聊' }, guildId: 'gg' } as any);
check('guild: channelName/guildId 提取', guildMeta.channelType === 'guild' && guildMeta.channelName === '闲聊' && guildMeta.guildId === 'gg', guildMeta);

// --- 断言 6：localToolLabel 兜底 ---
check('memory_ 前缀标签', localToolLabel('memory_save') === '🧠 记忆');
check('未知工具兜底标签', localToolLabel('foo_bar') === '🔧 foo_bar');

// --- 断言 7：session.title 脱敏（用户首条消息含密钥时不应明文落库） ---
const secretSid = recorder.ensureSession({ botId: 'botX', channelId: 'chanSecret', title: '我的 key 是 sk-ant-api03-SECRETKEY1234567890abcdefXYZ 帮我用' });
const secretSess = db.prepare('SELECT title FROM sessions WHERE id=?').get(secretSid) as any;
check('session.title 脱敏（密钥被替换）', !String(secretSess.title).includes('sk-ant-api03-SECRETKEY') && String(secretSess.title).includes('‹redacted›'), secretSess.title);

closeDb();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
