// pG = Phase 3 Inter-Agent Router 冒烟：纯逻辑（无 Discord/无 DB）。
// 覆盖：schema 默认/合并 · observ 事件类型 · 短循环检测 · 任务预算(轮数/成本/循环/熔断) ·
//       恢复重投 · 终止中止 · 待转交 relay 注册/消费(messageId 精确 + FIFO 兜底 + TTL + 撤销 + 错作者隔离)。
// 重跑：apps/orchestrator/node_modules/.bin/tsx apps/orchestrator/pG-smoke.ts

// 熔断阈值在 router 模块加载时读 env，故必须先设再动态 import。
process.env.INTERAGENT_DAILY_USD_CAP = '5';

import { botToolsSchema, botToolsPartialSchema, observEventTypeSchema, mentionBotToolConfigSchema } from '@hivemind/shared';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ''); }
}

const { interAgentRouter, InterAgentRouter, isShortLoop, DAILY_USD_CAP_VALUE } = await import('./src/inter-agent/router.ts');

const A = 'bot-A', B = 'bot-B', C = 'bot-C';
const HUMAN = 'human-1';
const CH = 'chan-1';

// ============================================================
console.log('— schema —');
{
  const t = botToolsSchema.parse({});
  check('botToolsSchema 默认含 mentionBot.enabled=false', t.mentionBot.enabled === false);
  check('mentionBot 默认 canMention=[]', Array.isArray(t.mentionBot.canMention) && t.mentionBot.canMention.length === 0);
  check('mentionBot 默认 maxTurnsPerTask=6', t.mentionBot.maxTurnsPerTask === 6);
  check('mentionBot 默认 maxCostUsd=2', t.mentionBot.maxCostUsd === 2);

  // PATCH 深度可选：只传 maxTurnsPerTask 不应带出 canMention（保证 repos 合并能保留旧值）
  const p = botToolsPartialSchema.parse({ mentionBot: { maxTurnsPerTask: 3 } });
  check('partial 只传 maxTurnsPerTask → 不含 canMention', p.mentionBot !== undefined && !('canMention' in (p.mentionBot as object)));

  // 模拟 repos.update 的 section 合并：旧值 canMention 应保留
  const existing = botToolsSchema.parse({}).mentionBot;
  const merged = mentionBotToolConfigSchema.parse({ ...existing, ...(p.mentionBot ?? {}), canMention: [B] });
  check('合并后 maxTurnsPerTask=3 且 canMention 保留', merged.maxTurnsPerTask === 3 && merged.canMention.includes(B));

  check("observEventType 含 'mention'", observEventTypeSchema.safeParse('mention').success);
}

// ============================================================
console.log('— 短循环检测 isShortLoop —');
check('[A] +B 不算（链太短）', isShortLoop([A], B) === false);
check('[A,B] +A 不算（链太短）', isShortLoop([A, B], A) === false);
check('[A,B,A] +B → 短循环', isShortLoop([A, B, A], B) === true);
check('[A,B,A,B] +A → 持续乒乓', isShortLoop([A, B, A, B], A) === true);
check('[A,B,C] +A 不算（非乒乓）', isShortLoop([A, B, C], A) === false);
check('[A,B,C,A] +B 不算（3 节点环，靠轮数兜底）', isShortLoop([A, B, C, A], B) === false);

// ============================================================
console.log('— 任务预算：轮数 —');
{
  interAgentRouter._resetForTest();
  const task = interAgentRouter.createTask({ rootRequesterId: HUMAN, rootBotId: A, channelId: CH, maxTurns: 2, maxCostUsd: 0, now: 1000 });
  check('新任务 active / hops=[A] / 0 跳', task.state === 'active' && task.hops.length === 1 && task.budget.turnsUsed === 0);
  check('第 1 跳通过', interAgentRouter.checkHop(task, B, { resumed: false, now: 1000 }).ok);
  interAgentRouter.commitHop(task, B, 1000);
  check('commit 后 turnsUsed=1 / hops=[A,B]', task.budget.turnsUsed === 1 && task.hops.join() === [A, B].join());
  check('第 2 跳通过', interAgentRouter.checkHop(task, C, { resumed: false, now: 1000 }).ok);
  interAgentRouter.commitHop(task, C, 1000);
  const r3 = interAgentRouter.checkHop(task, A, { resumed: false, now: 1000 });
  check('第 3 跳被挡 → paused_turns', !r3.ok && r3.state === 'paused_turns', r3);
  check('resumed=true 绕过轮数限制', interAgentRouter.checkHop(task, A, { resumed: true, now: 1000 }).ok);

  // rollbackHop：发送失败时回滚刚提交的那一跳（仅当链尾正是该目标）
  const before = task.budget.turnsUsed;
  interAgentRouter.commitHop(task, A, 1000); // [A,B,C,A], turnsUsed=3
  interAgentRouter.rollbackHop(task, A, 1000); // 回滚
  check('rollbackHop 回滚链尾跳（turnsUsed/hops 复原）', task.budget.turnsUsed === before && task.hops[task.hops.length - 1] === C, { used: task.budget.turnsUsed, before });
  interAgentRouter.rollbackHop(task, 'bot-Z', 1000); // 链尾非 Z → 不动
  check('rollbackHop 链尾不匹配则不动', task.budget.turnsUsed === before && task.hops[task.hops.length - 1] === C);
}

// ============================================================
console.log('— 任务预算：成本 —');
{
  interAgentRouter._resetForTest();
  const task = interAgentRouter.createTask({ rootRequesterId: HUMAN, rootBotId: A, channelId: CH, maxTurns: 99, maxCostUsd: 1, now: 1000 });
  check('成本 0 时通过', interAgentRouter.checkHop(task, B, { resumed: false, now: 1000 }).ok);
  interAgentRouter.addTaskCost(task.taskId, 1.5, 1000);
  const r = interAgentRouter.checkHop(task, B, { resumed: false, now: 1000 });
  check('成本超 maxCostUsd → paused_budget', !r.ok && r.state === 'paused_budget', r);
  // maxCostUsd=0 表示不限
  const free = interAgentRouter.createTask({ rootRequesterId: HUMAN, rootBotId: A, channelId: CH, maxTurns: 99, maxCostUsd: 0, now: 1000 });
  interAgentRouter.addTaskCost(free.taskId, 999, 1000);
  check('maxCostUsd=0 → 成本不设限', interAgentRouter.checkHop(free, B, { resumed: false, now: 1000 }).ok);
}

// ============================================================
console.log('— 任务预算：短循环（经 checkHop）—');
{
  interAgentRouter._resetForTest();
  const task = interAgentRouter.createTask({ rootRequesterId: HUMAN, rootBotId: A, channelId: CH, maxTurns: 99, maxCostUsd: 0, now: 1000 });
  interAgentRouter.commitHop(task, B, 1000); // [A,B]
  interAgentRouter.commitHop(task, A, 1000); // [A,B,A]
  const r = interAgentRouter.checkHop(task, B, { resumed: false, now: 1000 });
  check('hops=[A,B,A] 再 →B 被挡 paused_loop', !r.ok && r.state === 'paused_loop', r);
}

// ============================================================
console.log('— 恢复 / 终止 —');
{
  interAgentRouter._resetForTest();
  const task = interAgentRouter.createTask({ rootRequesterId: HUMAN, rootBotId: A, channelId: CH, maxTurns: 1, maxCostUsd: 0, now: 1000 });
  interAgentRouter.commitHop(task, B, 1000); // 用满 1 跳
  const check2 = interAgentRouter.checkHop(task, C, { resumed: false, now: 1000 });
  check('用满轮数 → 第 2 跳 paused_turns', !check2.ok && check2.state === 'paused_turns');
  interAgentRouter.pauseTask(task, 'paused_turns', { fromBotId: B, fromUserId: 'uB', targetBotId: C, targetUserId: 'uC', targetName: 'C', message: 'go' }, 1000);
  check('暂停后 state=paused_turns 且有 pendingResume', task.state === 'paused_turns' && !!task.pendingResume);
  const hop = interAgentRouter.resumeTask(task.taskId, 6, 2000);
  check('resume 返回被挡的 hop（target=C）', hop?.targetBotId === C, hop);
  check('resume 后 maxTurns 上调（1→7）且 state=active', task.budget.maxTurns === 7 && task.state === 'active');
  check('resume 后该跳可放行', interAgentRouter.checkHop(task, C, { resumed: false, now: 2000 }).ok);

  // 终止：中止登记的 controllers
  const ac = new AbortController();
  interAgentRouter.addController(task.taskId, ac);
  interAgentRouter.terminateTask(task.taskId, 3000);
  check('terminate 后 state=terminated 且 controller 被 abort', task.state === 'terminated' && ac.signal.aborted);
  check('terminate 后 resume 无效', interAgentRouter.resumeTask(task.taskId, 6, 3000) === undefined);
}

// ============================================================
console.log('— 待转交 relay 注册/消费 —');
{
  interAgentRouter._resetForTest();
  // messageId 精确匹配
  const r1 = interAgentRouter.registerRelay({ taskId: 't1', channelId: CH, targetBotId: B, targetUserId: 'uB', fromBotId: A, fromUserId: 'uA', now: 0 });
  interAgentRouter.attachMessageId(r1.relayId, 'msg-1');
  const got1 = interAgentRouter.consumeRelay({ messageId: 'msg-1', channelId: CH, targetBotId: B, authorId: 'uA', now: 1 });
  check('按 messageId 精确消费命中', got1?.taskId === 't1', got1);
  check('消费后不可再消费', interAgentRouter.consumeRelay({ messageId: 'msg-1', channelId: CH, targetBotId: B, authorId: 'uA', now: 1 }) === undefined);

  // FIFO 兜底（尚未回填 messageId 的竞态）
  interAgentRouter.registerRelay({ taskId: 't2', channelId: CH, targetBotId: B, targetUserId: 'uB', fromBotId: A, fromUserId: 'uA', now: 10 });
  const got2 = interAgentRouter.consumeRelay({ messageId: 'unknown-id', channelId: CH, targetBotId: B, authorId: 'uA', now: 11 });
  check('messageId 未命中 → FIFO 兜底消费', got2?.taskId === 't2', got2);

  // 错误作者不应消费（FIFO key 含 fromUserId）
  interAgentRouter.registerRelay({ taskId: 't3', channelId: CH, targetBotId: B, targetUserId: 'uB', fromBotId: A, fromUserId: 'uA', now: 20 });
  check('错作者消费 → 不命中', interAgentRouter.consumeRelay({ messageId: 'x', channelId: CH, targetBotId: B, authorId: 'uX', now: 21 }) === undefined);
  // 正确作者仍能消费回来
  check('正确作者仍能消费', interAgentRouter.consumeRelay({ messageId: 'x', channelId: CH, targetBotId: B, authorId: 'uA', now: 22 })?.taskId === 't3');

  // 撤销
  const r4 = interAgentRouter.registerRelay({ taskId: 't4', channelId: CH, targetBotId: B, targetUserId: 'uB', fromBotId: A, fromUserId: 'uA', now: 30 });
  interAgentRouter.cancelRelay(r4.relayId);
  check('cancelRelay 后不可消费', interAgentRouter.consumeRelay({ messageId: 'y', channelId: CH, targetBotId: B, authorId: 'uA', now: 31 }) === undefined);

  // TTL 过期（>60s）
  interAgentRouter.registerRelay({ taskId: 't5', channelId: CH, targetBotId: B, targetUserId: 'uB', fromBotId: A, fromUserId: 'uA', now: 1000 });
  check('超 TTL 的 relay 被清，不可消费', interAgentRouter.consumeRelay({ messageId: 'z', channelId: CH, targetBotId: B, authorId: 'uA', now: 1000 + 120_000 }) === undefined);
}

// ============================================================
console.log('— 全局日成本熔断 —');
{
  interAgentRouter._resetForTest();
  check(`DAILY_USD_CAP 读 env = 5`, DAILY_USD_CAP_VALUE === 5);
  check('初始未熔断', interAgentRouter.isGloballyTripped(0) === false);
  interAgentRouter.recordGlobalCost(3, 0);
  check('累计 3 < 5 未熔断', interAgentRouter.isGloballyTripped(0) === false);
  interAgentRouter.recordGlobalCost(3, 0);
  check('累计 6 ≥ 5 熔断', interAgentRouter.isGloballyTripped(0) === true);

  const task = interAgentRouter.createTask({ rootRequesterId: HUMAN, rootBotId: A, channelId: CH, maxTurns: 99, maxCostUsd: 0, now: 0 });
  const r = interAgentRouter.checkHop(task, B, { resumed: false, now: 0 });
  check('熔断时新跳被挡 → paused_global', !r.ok && r.state === 'paused_global', r);
  check('resumed=true 可越过熔断（人工放行）', interAgentRouter.checkHop(task, B, { resumed: true, now: 0 }).ok);

  // 跨日自动归零
  check('次日自动归零 → 不再熔断', interAgentRouter.isGloballyTripped(86_400_001) === false);
}

console.log(`\npG Inter-Agent Router 冒烟：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
