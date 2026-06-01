// Phase 2 spike：验证 Claude Agent SDK 能用「订阅鉴权」从进程内驱动 Claude Code。
// 关键验证点：① 不设 ANTHROPIC_API_KEY 也能跑（走 Pro/Max 订阅）；② 能拿到流式消息；
// ③ 能拿到 sessionId（供 resume）；④ canUseTool 能拦到工具调用并看到 input 形状；⑤ cwd 生效、文件落地。
// 运行：在 apps/orchestrator 目录下 `node spike-claude.mjs`

import { query } from '@anthropic-ai/claude-agent-sdk';

// 镜像 orchestrator 入口：杜绝误走 API 计费，强制订阅鉴权
delete process.env.ANTHROPIC_API_KEY;

const CWD = process.platform === 'win32' ? './.claude-spike' : './.claude-spike';

const abort = new AbortController();
const HARD_TIMEOUT_MS = 120_000;
const timer = setTimeout(() => {
  console.error(`\n[spike] 硬超时 ${HARD_TIMEOUT_MS}ms，中止`);
  abort.abort();
}, HARD_TIMEOUT_MS);

let sessionId;
const toolCalls = [];
let finalResult;

console.log('[spike] 启动 query()，cwd =', CWD);
console.log('[spike] ANTHROPIC_API_KEY =', process.env.ANTHROPIC_API_KEY ? '(已设!!)' : '(未设，应走订阅)');

try {
  const q = query({
    prompt:
      '请在当前工作目录创建一个名为 spike.txt 的文件，内容写一行：hello from claude agent sdk。完成后用一句话告诉我你做了什么。',
    options: {
      cwd: CWD,
      maxTurns: 6,
      abortController: abort,
      // SDK 隔离：不加载本机 .claude 设置，权限完全由 canUseTool 决定
      settingSources: [],
      stderr: (d) => process.stderr.write(`[claude-stderr] ${d}`),
      // 全部放行，但打印每个工具调用的名字与 input，以确认形状（含 Write/Bash/AskUserQuestion 等）
      canUseTool: async (toolName, input, opts) => {
        toolCalls.push({ toolName, input });
        console.log(`[spike] canUseTool -> ${toolName}`, JSON.stringify(input).slice(0, 300));
        if (opts?.title) console.log(`        title: ${opts.title}`);
        return { behavior: 'allow', updatedInput: input };
      },
    },
  });

  for await (const msg of q) {
    // 打印每条消息的 type/subtype 概览，并尽力捕捉 session_id
    const t = msg.type;
    const sub = msg.subtype ?? '';
    if (!sessionId && msg.session_id) sessionId = msg.session_id;
    if (t === 'system') {
      console.log(`[msg] system/${sub} session_id=${msg.session_id ?? '?'}`);
    } else if (t === 'assistant' || t === 'user') {
      const blocks = msg.message?.content;
      const preview = Array.isArray(blocks)
        ? blocks.map((b) => (b.type === 'text' ? b.text : `<${b.type}>`)).join(' ').slice(0, 200)
        : String(blocks).slice(0, 200);
      console.log(`[msg] ${t}: ${preview}`);
    } else if (t === 'result') {
      finalResult = msg;
      console.log(`[msg] result/${sub} cost_usd=${msg.total_cost_usd ?? '?'} turns=${msg.num_turns ?? '?'}`);
    } else {
      console.log(`[msg] ${t}/${sub}`);
    }
  }

  console.log('\n========== SPIKE 结果 ==========');
  console.log('sessionId:', sessionId ?? '(没拿到!)');
  console.log('工具调用:', toolCalls.map((c) => c.toolName).join(', ') || '(无)');
  console.log('result.subtype:', finalResult?.subtype ?? '(无 result 消息)');
  console.log('result.is_error:', finalResult?.is_error);
  if (finalResult?.result) console.log('result.text:', String(finalResult.result).slice(0, 300));
} catch (e) {
  console.error('\n[spike] ❌ 出错:', e?.message ?? e);
  console.error(e?.stack);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
