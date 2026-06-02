// Inter-Agent Router（Phase 3，全局单例，内存维护）。
//
// 职责（纯逻辑，无 discord.js / 无 recorder，便于 pG-smoke 直接单测）：
//  · 任务注册表 taskRegistry：一条 @ 链 = 一个 MentionTask，预算/跳数/路径的单一真相源。
//  · 待转交 relay 注册表：A 发 @ 消息前先登记，对方 receiveMention 门据此判定「是不是我方发起的合法转交」，
//    其余 bot/webhook 闲聊仍被丢弃——这是「真实 @mention 转发」下防全队循环的关键闸门。
//  · 护栏检查：转交跳数 / 累计成本 / 短循环(A→B→A→B) / 全局日成本熔断。失败→暂停态，等发起人裁决。
//  · 全局日成本熔断：累计「今日」Claude 委派等价成本超 INTERAGENT_DAILY_USD_CAP → 暂停所有新转交/委派。
//
// 真实的「按名字找 bot、取对方 user id、发 @ 消息、暂停按钮 UI、记可观测性事件」在 bot-manager.deliverMention，
// 它编排本 Router 的原语 —— 这样 Router 保持纯净可测，bot-manager 持有 Discord 副作用。

import { randomUUID } from 'node:crypto';
import type {
  ChainBudget,
  MentionTask,
  MentionTaskState,
  PendingHop,
  PendingRelay,
  ReplyAwait,
} from './types.js';

// 全局日成本熔断阈值（USD）。0 = 关闭熔断。默认 10：个人用、主要挡 Claude 委派失控刷订阅额度。
const DAILY_USD_CAP = (() => {
  const raw = process.env.INTERAGENT_DAILY_USD_CAP;
  const n = raw == null || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 10;
})();

// 同一任务内「转交给同一个目标 bot」的累计跳数上限。isShortLoop 只抓严格 A→B→A→B 乒乓，挡不住扇出型/多角
// 级联风暴（实测：PM 反复 @ 同一批同伴、回报里又带 @）。这条按「目标在 hops 中出现次数」兜底：达上限即暂停
// 等发起人裁决。默认 5（允许正常多轮协作，挡住失控刷屏）。0 = 关闭此项检查。可由 INTERAGENT_MAX_HOPS_PER_TARGET 调。
const MAX_HOPS_PER_TARGET = (() => {
  const raw = process.env.INTERAGENT_MAX_HOPS_PER_TARGET;
  const n = raw == null || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 5;
})();

// 待转交 relay 的存活上限（ms）：对方可能离线/消息发失败，超时未被消费即作废，防注册表无界增长。
const RELAY_TTL_MS = 60_000;
// 「等待接力回报」登记的存活上限（ms）：对方可能跑很久（如 delegate_to_claude 多步委派）才回复，
// 故远长于 relay TTL。超时仍没回报即作废，防注册表无界增长。
const REPLY_AWAIT_TTL_MS = 60 * 60_000;
// 已结束（done/terminated）任务在注册表里保留多久后清除（留窗口给恢复按钮的尾随交互/日志）。
const TASK_TTL_MS = 60 * 60_000;
// 兜底：任何任务（含 active/paused，例如发起人始终不点恢复按钮）空闲超过此值即清除，防注册表无界增长。
const TASK_IDLE_CAP_MS = 6 * 60 * 60_000;

/** UTC 日序号（用整数除法，避免 Date —— 既简洁又利于测试注入 now）。 */
function dayKey(now: number): number {
  return Math.floor(now / 86_400_000);
}

/**
 * 短循环检测：把 next 追加到 hops 后是否构成 A→B→A→B 乒乓。
 * hops 末尾为 [..., x, y, x] 且 next === y 时成立（即 x↔y 已往返一轮、又要回到 y）。
 */
export function isShortLoop(hops: string[], next: string): boolean {
  const n = hops.length;
  if (n < 3) return false;
  return next === hops[n - 2] && hops[n - 1] === hops[n - 3];
}

export interface CheckResult {
  ok: boolean;
  /** ok=false 时给出暂停态。 */
  state?: Extract<MentionTaskState, 'paused_turns' | 'paused_budget' | 'paused_loop' | 'paused_global'>;
}

export class InterAgentRouter {
  private tasks = new Map<string, MentionTask>();
  private relaysById = new Map<string, PendingRelay>();
  // FIFO 队列键：`${channelId}:${targetBotId}:${fromUserId}`，消除「拿到 messageId 前网关已派发」的竞态。
  private relayFifo = new Map<string, PendingRelay[]>();
  // 「等待接力回报」登记：键 `${channelId}:${messageId}`（被引用回复的那条 @ 转交消息）。
  private replyAwaits = new Map<string, ReplyAwait>();

  // 全局日成本累计（熔断用）。跨「日」自动归零（lazy，在读写时滚动）。
  private costDay = 0;
  private costToday = 0;

  // ----------------------------------------------------------------
  // 任务生命周期
  // ----------------------------------------------------------------

  /** 惰性创建一条协作任务（人类回合首次调 mention_bot 时）。 */
  createTask(seed: {
    rootRequesterId: string;
    rootBotId: string;
    channelId: string;
    maxTurns: number;
    maxCostUsd: number;
    now: number;
  }): MentionTask {
    const budget: ChainBudget = {
      turnsUsed: 0,
      maxTurns: seed.maxTurns,
      costUsd: 0,
      maxCostUsd: seed.maxCostUsd,
    };
    const task: MentionTask = {
      taskId: randomUUID(),
      rootRequesterId: seed.rootRequesterId,
      rootBotId: seed.rootBotId,
      channelId: seed.channelId,
      hops: [seed.rootBotId],
      budget,
      state: 'active',
      controllers: new Set(),
      createdAt: seed.now,
      updatedAt: seed.now,
    };
    this.tasks.set(task.taskId, task);
    return task;
  }

  getTask(taskId: string): MentionTask | undefined {
    return this.tasks.get(taskId);
  }

  /** 任务短码（给人看的 #xxxxxx）。 */
  static shortId(taskId: string): string {
    return taskId.slice(0, 6);
  }

  /**
   * 预算 / 短循环 / 熔断检查（授权类检查 canMention/online/access/self 由 bot-manager 在调用前完成）。
   * resumed=true（发起人点了「继续」后重投这一跳）时跳过这些限额，放行恰好一跳，之后限额照常生效。
   */
  checkHop(task: MentionTask, targetBotId: string, opts: { resumed: boolean; now: number }): CheckResult {
    if (opts.resumed) return { ok: true };
    if (this.isGloballyTripped(opts.now)) return { ok: false, state: 'paused_global' };
    if (task.budget.turnsUsed >= task.budget.maxTurns) return { ok: false, state: 'paused_turns' };
    if (task.budget.maxCostUsd > 0 && task.budget.costUsd >= task.budget.maxCostUsd)
      return { ok: false, state: 'paused_budget' };
    if (isShortLoop(task.hops, targetBotId)) return { ok: false, state: 'paused_loop' };
    // 扇出型/多角风暴兜底：同一目标在本任务被转交过太多次（isShortLoop 只抓严格乒乓，抓不到这类）。
    if (MAX_HOPS_PER_TARGET > 0 && task.hops.filter((h) => h === targetBotId).length >= MAX_HOPS_PER_TARGET)
      return { ok: false, state: 'paused_loop' };
    return { ok: true };
  }

  /** 通过检查后提交这一跳：跳数 +1、路径追加目标。**先于发 @ 消息**调用，使对方接力时 hops 必然已含自己。 */
  commitHop(task: MentionTask, targetBotId: string, now: number): void {
    task.budget.turnsUsed += 1;
    task.hops.push(targetBotId);
    task.state = 'active';
    task.pendingResume = undefined;
    task.updatedAt = now;
  }

  /** 发 @ 消息失败时回滚刚提交的这一跳（仅当链尾正是该目标时）。发送失败 = 对方没收到，不会有接力。 */
  rollbackHop(task: MentionTask, targetBotId: string, now: number): void {
    if (task.hops[task.hops.length - 1] === targetBotId) {
      task.hops.pop();
      task.budget.turnsUsed = Math.max(0, task.budget.turnsUsed - 1);
      task.updatedAt = now;
    }
  }

  /** 标记任务因某护栏暂停，记下被挡的那一跳供恢复。 */
  pauseTask(task: MentionTask, state: CheckResult['state'], hop: PendingHop, now: number): void {
    if (!state) return;
    task.state = state;
    task.pendingResume = hop;
    task.updatedAt = now;
  }

  /** 触达过这条任务（更新空闲计时，避免长链被 TTL 误清）。 */
  touchTask(taskId: string, now: number): void {
    const task = this.tasks.get(taskId);
    if (task) task.updatedAt = now;
  }

  /**
   * 发起人点「继续」：放行被挡的那一跳。turns/budget 暂停 → 上调对应上限；其余 → 仅本跳 bypass。
   * 返回被挂起的 hop（bot-manager 据此重投），任务不存在/无挂起/已终止则返回 undefined。
   */
  resumeTask(taskId: string, bumpTurns: number, now: number): PendingHop | undefined {
    const task = this.tasks.get(taskId);
    if (!task || !task.pendingResume || task.state === 'terminated') return undefined;
    if (task.state === 'paused_turns') task.budget.maxTurns += Math.max(1, bumpTurns);
    if (task.state === 'paused_budget' && task.budget.maxCostUsd > 0)
      task.budget.maxCostUsd += Math.max(0.01, task.budget.costUsd - task.budget.maxCostUsd + 1);
    const hop = task.pendingResume;
    task.state = 'active';
    task.pendingResume = undefined;
    task.updatedAt = now;
    return hop;
  }

  /** 发起人点「终止」：标记终止并中止本任务在跑的所有回合。 */
  terminateTask(taskId: string, now: number): MentionTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    task.state = 'terminated';
    task.pendingResume = undefined;
    task.updatedAt = now;
    for (const ac of task.controllers) {
      try {
        ac.abort();
      } catch {
        /* 隔离 */
      }
    }
    task.controllers.clear();
    return task;
  }

  /** 把一笔成本（USD）计入某协作任务的累计预算（链内 Claude 委派回灌）。 */
  addTaskCost(taskId: string, usd: number, now: number): void {
    const task = this.tasks.get(taskId);
    if (task && Number.isFinite(usd) && usd > 0) {
      task.budget.costUsd += usd;
      task.updatedAt = now;
    }
  }

  addController(taskId: string, ac: AbortController): void {
    this.tasks.get(taskId)?.controllers.add(ac);
  }

  removeController(taskId: string, ac: AbortController): void {
    this.tasks.get(taskId)?.controllers.delete(ac);
  }

  // ----------------------------------------------------------------
  // 待转交 relay 注册表
  // ----------------------------------------------------------------

  private fifoKey(channelId: string, targetBotId: string, fromUserId: string): string {
    return `${channelId}:${targetBotId}:${fromUserId}`;
  }

  /** A 发 @ 消息前登记（FIFO，先于消息 id），返回 relay（caller 发出后回填 messageId）。 */
  registerRelay(input: Omit<PendingRelay, 'relayId' | 'createdAt' | 'messageId'> & { now: number }): PendingRelay {
    this.sweepRelays(input.now);
    const relay: PendingRelay = {
      relayId: randomUUID(),
      taskId: input.taskId,
      channelId: input.channelId,
      targetBotId: input.targetBotId,
      targetUserId: input.targetUserId,
      fromBotId: input.fromBotId,
      fromUserId: input.fromUserId,
      createdAt: input.now,
    };
    this.relaysById.set(relay.relayId, relay);
    const key = this.fifoKey(relay.channelId, relay.targetBotId, relay.fromUserId);
    const arr = this.relayFifo.get(key) ?? [];
    arr.push(relay);
    this.relayFifo.set(key, arr);
    return relay;
  }

  /** 消息发出后回填 messageId，建精确索引（消费时优先用）。 */
  attachMessageId(relayId: string, messageId: string): void {
    const relay = this.relaysById.get(relayId);
    if (relay) relay.messageId = messageId;
  }

  /** 发送失败时撤销登记（避免占着 FIFO 名额误配后续消息）。 */
  cancelRelay(relayId: string): void {
    const relay = this.relaysById.get(relayId);
    if (!relay) return;
    this.removeRelay(relay);
  }

  private removeRelay(relay: PendingRelay): void {
    this.relaysById.delete(relay.relayId);
    const key = this.fifoKey(relay.channelId, relay.targetBotId, relay.fromUserId);
    const arr = this.relayFifo.get(key);
    if (arr) {
      const i = arr.indexOf(relay);
      if (i >= 0) arr.splice(i, 1);
      if (arr.length === 0) this.relayFifo.delete(key);
    }
  }

  /**
   * 目标 bot 的 receiveMention 门：判定这条 bot 发来的消息是不是我方登记的合法转交。
   * 先按 messageId 精确匹配；未命中（拿到 id 前网关已派发的竞态）退化为 (channel,target,author) FIFO 取最旧。
   * 命中即消费（从两索引移除）。返回 undefined → 调用方应丢弃该消息（防全队循环）。
   */
  consumeRelay(input: {
    messageId: string;
    channelId: string;
    targetBotId: string;
    authorId: string;
    now: number;
  }): PendingRelay | undefined {
    this.sweepRelays(input.now);
    // 1) 精确匹配 messageId
    for (const relay of this.relaysById.values()) {
      if (
        relay.messageId === input.messageId &&
        relay.targetBotId === input.targetBotId &&
        relay.channelId === input.channelId
      ) {
        this.removeRelay(relay);
        return relay;
      }
    }
    // 2) FIFO 兜底：同频道、同目标、同发起 bot 的最旧一条
    const key = this.fifoKey(input.channelId, input.targetBotId, input.authorId);
    const arr = this.relayFifo.get(key);
    if (arr && arr.length) {
      const relay = arr.shift()!;
      if (arr.length === 0) this.relayFifo.delete(key);
      this.relaysById.delete(relay.relayId);
      return relay;
    }
    return undefined;
  }

  private sweepRelays(now: number): void {
    if (this.relaysById.size === 0) return;
    for (const relay of [...this.relaysById.values()]) {
      if (now - relay.createdAt > RELAY_TTL_MS) this.removeRelay(relay);
    }
    // 顺带清理任务，防注册表无界增长：已结束的短 TTL，其余（含 active/paused）按空闲上限兜底清除。
    for (const task of [...this.tasks.values()]) {
      const idle = now - task.updatedAt;
      const ended = task.state === 'done' || task.state === 'terminated';
      if ((ended && idle > TASK_TTL_MS) || idle > TASK_IDLE_CAP_MS) {
        this.tasks.delete(task.taskId);
      }
    }
  }

  // ----------------------------------------------------------------
  // 等待接力回报登记（修复：对方引用回复转交消息时，回报回不到发起 bot）
  // ----------------------------------------------------------------

  private replyAwaitKey(channelId: string, messageId: string): string {
    return `${channelId}:${messageId}`;
  }

  /** owner 发出 @ 转交消息后登记：当被 @ 的同伴「引用回复」这条消息时，把回复当作本任务的接力回报路由回 owner。 */
  registerReplyAwait(input: {
    taskId: string;
    ownerBotId: string;
    channelId: string;
    messageId: string;
    /** 这条消息 @ 的目标同伴 user id（合法回报方白名单；空 = 不校验）。 */
    expectedSenderUserIds: string[];
    now: number;
  }): void {
    this.sweepReplyAwaits(input.now);
    this.replyAwaits.set(this.replyAwaitKey(input.channelId, input.messageId), {
      taskId: input.taskId,
      ownerBotId: input.ownerBotId,
      channelId: input.channelId,
      messageId: input.messageId,
      expectedSenderUserIds: [...input.expectedSenderUserIds],
      createdAt: input.now,
    });
  }

  /**
   * 命中判定：一条 bot 消息「引用回复」的目标消息（refMessageId），是否是 ownerBotId 自己发出、仍在等待回报的
   * 转交消息，且回报方（senderUserId）确属当初被 @ 的同伴。命中返回该登记（含 taskId）。**非一次性**（同一条
   * @ 了多个同伴的消息会陆续收到多个回报，都要回到 owner），仅按 owner + 频道 + 回报方白名单 + 未过期校验；
   * 过期与无界增长由 TTL sweep 处理。
   */
  matchReplyAwait(input: { channelId: string; refMessageId: string; ownerBotId: string; senderUserId: string; now: number }): ReplyAwait | undefined {
    this.sweepReplyAwaits(input.now);
    const ra = this.replyAwaits.get(this.replyAwaitKey(input.channelId, input.refMessageId));
    if (!ra || ra.ownerBotId !== input.ownerBotId) return undefined;
    // 回报方必须是当初被 @ 的同伴之一（防其它 bot 恰好引用回复这条转交消息被误当作回报）。
    if (ra.expectedSenderUserIds.length > 0 && !ra.expectedSenderUserIds.includes(input.senderUserId)) return undefined;
    return ra;
  }

  private sweepReplyAwaits(now: number): void {
    if (this.replyAwaits.size === 0) return;
    for (const [k, ra] of [...this.replyAwaits]) {
      if (now - ra.createdAt > REPLY_AWAIT_TTL_MS) this.replyAwaits.delete(k);
    }
  }

  // ----------------------------------------------------------------
  // 全局日成本熔断
  // ----------------------------------------------------------------

  private rollDay(now: number): void {
    const d = dayKey(now);
    if (d !== this.costDay) {
      this.costDay = d;
      this.costToday = 0;
    }
  }

  /** 累计一笔成本（USD）。来源：链内 Claude 委派的 total_cost_usd。 */
  recordGlobalCost(usd: number, now: number): void {
    if (!Number.isFinite(usd) || usd <= 0) return;
    this.rollDay(now);
    this.costToday += usd;
  }

  isGloballyTripped(now: number): boolean {
    if (DAILY_USD_CAP <= 0) return false;
    this.rollDay(now);
    return this.costToday >= DAILY_USD_CAP;
  }

  globalCostState(now: number): { capUsd: number; spentUsd: number; tripped: boolean } {
    this.rollDay(now);
    return { capUsd: DAILY_USD_CAP, spentUsd: this.costToday, tripped: this.isGloballyTripped(now) };
  }

  // 测试辅助：清空所有内存态（pG-smoke 各用例间隔离）。
  _resetForTest(): void {
    this.tasks.clear();
    this.relaysById.clear();
    this.relayFifo.clear();
    this.replyAwaits.clear();
    this.costDay = 0;
    this.costToday = 0;
  }
}

export const interAgentRouter = new InterAgentRouter();
export const DAILY_USD_CAP_VALUE = DAILY_USD_CAP;
export const REPLY_AWAIT_TTL_MS_VALUE = REPLY_AWAIT_TTL_MS;
export const MAX_HOPS_PER_TARGET_VALUE = MAX_HOPS_PER_TARGET;
