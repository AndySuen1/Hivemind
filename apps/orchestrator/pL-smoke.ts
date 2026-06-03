// pL = discord_push 工具白名单冒烟（Phase 3.5）：命中→发送 / 非白名单→拒绝不发 / 缺上下文 / 空白名单 fail-closed / 发送失败。
// 纯逻辑，stub sendToChannel 记录被调频道；不连真 Discord。
// 重跑：apps/orchestrator/node_modules/.bin/tsx apps/orchestrator/pL-smoke.ts
import { buildDiscordPushTool } from './src/tools/discord-push.ts';

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

const makeTool = (channelIds: string[]) =>
  (buildDiscordPushTool('bot-1', { enabled: true, channelIds }) as any).discord_push;

function makePush(allowed: string[], result: { ok: boolean; error?: string } = { ok: true }) {
  const calls: string[] = [];
  return {
    calls,
    ctx: {
      experimental_context: {
        push: {
          botId: 'bot-1',
          allowedChannelIds: allowed,
          sendToChannel: async (cid: string) => {
            calls.push(cid);
            return result;
          },
        },
      },
    },
  };
}

console.log('— 命中白名单 → 发送 —');
{
  const t = makeTool(['C1']);
  const p = makePush(['C1']);
  const out = await t.execute({ channel_id: 'C1', content: 'hi' }, p.ctx);
  check('调用 sendToChannel(C1)', p.calls.length === 1 && p.calls[0] === 'C1');
  check('返回已推送', String(out).startsWith('已推送'), out);
}

console.log('— 非白名单 → 拒绝且不发送 —');
{
  const t = makeTool(['C1']);
  const p = makePush(['C1']);
  const out = await t.execute({ channel_id: 'CX', content: 'hi' }, p.ctx);
  check('未调用 sendToChannel', p.calls.length === 0);
  check('返回白名单错误', String(out).includes('白名单'), out);
}

console.log('— 缺推送上下文 → 内部错误 —');
{
  const t = makeTool(['C1']);
  const out = await t.execute({ channel_id: 'C1', content: 'hi' }, { experimental_context: {} });
  check('返回推送上下文缺失', String(out).includes('推送上下文缺失'), out);
}

console.log('— 空白名单 fail-closed → 全拒 —');
{
  const t = makeTool([]);
  const p = makePush([]);
  const out = await t.execute({ channel_id: 'C1', content: 'hi' }, p.ctx);
  check('空白名单不发送', p.calls.length === 0);
  check('返回白名单错误', String(out).includes('白名单'), out);
}

console.log('— sendToChannel 失败 → 返回错误串 —');
{
  const t = makeTool(['C1']);
  const p = makePush(['C1'], { ok: false, error: '频道不可用' });
  const out = await t.execute({ channel_id: 'C1', content: 'hi' }, p.ctx);
  check('调用了 sendToChannel', p.calls.length === 1);
  check('返回推送失败', String(out).startsWith('错误：推送失败'), out);
}

console.log(`\npL discord_push 冒烟：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
