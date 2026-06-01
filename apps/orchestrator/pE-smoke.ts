// Phase 修复冒烟（review 后）：budgetHistoryByChars 字符预算裁剪（#2 修复）的纯函数行为。
// 重跑：apps/orchestrator/node_modules/.bin/tsx apps/orchestrator/pE-smoke.ts
import type { ModelMessage } from 'ai';
import { budgetHistoryByChars } from './src/bot-manager.ts';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ''); }
}

const m = (role: 'user' | 'assistant', content: string): ModelMessage => ({ role, content });
const contents = (a: ModelMessage[]) => a.map((x) => x.content);

// 6 条，每条 100 字符
const six = [m('user', 'a'.repeat(100)), m('assistant', 'b'.repeat(100)), m('user', 'c'.repeat(100)),
            m('assistant', 'd'.repeat(100)), m('user', 'e'.repeat(100)), m('assistant', 'f'.repeat(100))];

check('预算够大→原样返回', budgetHistoryByChars(six, 10000).length === 6);
check('预算=0（不限）→原样返回', budgetHistoryByChars(six, 0).length === 6);
check('≤2 条→原样返回（至少留 1 轮）', budgetHistoryByChars(six.slice(-2), 10).length === 2);

// 预算 250：从最近往回累计，保留最近若干条（每条 100），250 容得下 2 条(200)，第 3 条(300)超→只留最近 2
const b250 = budgetHistoryByChars(six, 250);
check('预算 250→保留最近 2 条', b250.length === 2 && contents(b250).join('') === ['e'.repeat(100), 'f'.repeat(100)].join(''), contents(b250).map((c) => (c as string)[0]));

// 预算 350：容得下 3 条(300)，第 4 条(400)超→留最近 3
const b350 = budgetHistoryByChars(six, 350);
check('预算 350→保留最近 3 条', b350.length === 3 && (b350[0]?.content as string)[0] === 'd', b350.map((x) => (x.content as string)[0]));

// 单条超长但在最近 2 内→仍保留（不能砍当前轮）
const huge = [m('user', 'x'.repeat(100)), m('assistant', 'y'.repeat(5000))];
check('最近 2 条即便超预算也保留', budgetHistoryByChars(huge, 100).length === 2);

console.log(`\nPhase 修复冒烟：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
