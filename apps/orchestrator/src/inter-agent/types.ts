// Inter-Agent 协作（Phase 3）的内部类型。
//
// 协作模型：bot A 调 mention_bot(bot_name, message) → Inter-Agent Router 校验通过后，A 用自己的
// Discord 身份在频道里真实 @对方（`<@Buser> message`），对方 bot 的消息处理（receiveMention 门）接力。
// 转交**异步即发即走**：A 发完就返回任务号，B 在频道里独立接力，不阻塞 A（各 bot 各自的 channelQueues）。
//
// 一条「@ 链」= 一个 MentionTask（任务），有唯一 taskId 作为跨 bot 血缘关联键；预算/跳数/路径都挂在
// task 上（内存单例真相源），通过 taskId 在各 bot 的处理间传递。所有状态仅在 orchestrator 进程内存。

import type { MentionTaskState } from '@hivemind/shared';
import type { DelegationContext } from '../claude/delegation.js';

export type { MentionTaskState };

/** 一条协作任务的共享预算（被链上每一跳按引用读写，故累计可见）。 */
export interface ChainBudget {
  /** 已转交跳数（= hops.length - 1）。每成功转交一跳 +1。 */
  turnsUsed: number;
  /** 最大转交跳数（由发起任务的那个 bot 的 maxTurnsPerTask 决定；恢复时可上调）。 */
  maxTurns: number;
  /** 累计成本（USD，主要来自链内 Claude 委派的等价订阅成本）。 */
  costUsd: number;
  /** 最大累计成本（USD）。0 = 不按成本限。 */
  maxCostUsd: number;
}

/**
 * 经 experimental_context.mention 注入到一次 generateAgentReply 的「链上下文」。
 * - taskId 存在 → 本回合属于一条已存在的协作任务（B 接力 A 的转交），mention_bot 调用会**扩展**该任务。
 * - taskId 缺省、root 存在 → 人类发起的普通回合，尚未开链；首次调 mention_bot 才**惰性创建**任务。
 */
export interface MentionChainContext {
  taskId?: string;
  /** 人类发起回合的开链种子（仅 taskId 缺省时有意义）。 */
  root?: {
    rootRequesterId: string; // 发起这条链的**人类** Discord user id
    rootBotId: string;       // 开链的 bot id（depth 0）
    channelId: string;
  };
}

/** 一条协作任务（一条 @ 链）。仅内存（router.taskRegistry）。 */
export interface MentionTask {
  taskId: string;
  rootRequesterId: string; // 发起人（人类），用于目标 bot 的访问控制 + 暂停通知 + 按钮裁决归属
  rootBotId: string;
  channelId: string;
  /** 链路径：按转交顺序的 botId，起点是 rootBotId（depth 0）。短循环检测与路径展示用。 */
  hops: string[];
  budget: ChainBudget;
  state: MentionTaskState;
  /** 被暂停时记下「被挡住的那一跳」，供恢复时原样重投。 */
  pendingResume?: PendingHop;
  /** 本任务相关的在跑 AbortController（各接力 bot 的回合 ac）；终止任务时全 abort。 */
  controllers: Set<AbortController>;
  createdAt: number;
  updatedAt: number;
}

/** 被暂停时挂起的一跳（恢复时重投）。 */
export interface PendingHop {
  fromBotId: string;
  fromUserId: string;
  targetBotId: string;
  targetUserId: string;
  targetName: string;
  message: string;
}

/**
 * 一条「已注册、待对方接力」的转交。A 在发 @ 消息**之前**先注册（按 (channel,target,author) FIFO，
 * 消除「网关事件早于消息 id 拿到」的竞态）；发出后再按 messageId 建精确索引。对方 bot 的 receiveMention
 * 门只处理能匹配到已注册 relay 的 bot 消息——其余 bot/webhook 闲聊仍被 author.bot 门丢弃（防全队循环）。
 */
export interface PendingRelay {
  relayId: string;
  taskId: string;
  channelId: string;
  targetBotId: string;
  targetUserId: string;
  fromBotId: string;
  fromUserId: string;
  /** 发出后回填的 Discord 消息 id（精确匹配用；FIFO 兜底不依赖它）。 */
  messageId?: string;
  createdAt: number;
}

/**
 * 一条「已发出、等待对方接力回报」的转交消息登记。owner（发出 @ 转交消息的 bot）在消息发出后按其消息 id 登记；
 * 当频道里出现「引用回复了这条消息」的 bot 消息时，owner 据此把对方的回复当作本协作任务的**接力回报**来处理。
 * 这修复了「员工 bot 引用回复 PM 的转交消息时，PM 收不到 / 不处理」——回报方向此前完全没接线。
 *
 * 非一次性消费：同一条「@ 了多个同伴」的消息可能收到多个同伴各自的回复，都应回到 owner；仅按 TTL 过期清理。
 */
export interface ReplyAwait {
  taskId: string;
  /** 发出该 @ 转交消息的 bot id —— 对方的回报应回到它。 */
  ownerBotId: string;
  channelId: string;
  /** 被引用回复的那条消息 id（= owner 发出的 @ 转交消息 / 内联 @ 改写后的回复消息）。 */
  messageId: string;
  /**
   * 这条转交消息 @ 的目标同伴的 Discord user id 集合 —— 只有这些同伴的「引用回复」才是合法回报。
   * 防止频道里其它 bot（非被 @ 者）恰好引用回复这条消息时被误当作回报处理。空集 = 不校验（向后兼容）。
   */
  expectedSenderUserIds: string[];
  createdAt: number;
}

/** mention_bot 工具调用 deliverMention 的入参（除调用方 Discord 上下文外的部分）。 */
export interface DeliverMentionArgs {
  /** 调用方回合的链上下文（人类回合=带 root；接力回合=带 taskId）。 */
  chain: MentionChainContext;
  targetName: string;
  message: string;
}

/**
 * bot-manager 暴露给 mention_bot 工具的转交函数。fromCtx 提供调用方的频道/发起人/中止信号/
 * runId/sessionId/botId/botName（即 delegate 复用的 DelegationContext）。
 */
export type DeliverMentionFn = (fromCtx: DelegationContext, args: DeliverMentionArgs) => Promise<DeliverMentionResult>;

/** deliverMention 的结果（mention_bot 把它转成给模型看的字符串）。 */
export interface DeliverMentionResult {
  ok: boolean;
  /** 给调用方模型看的简明说明（已是自然语言）。 */
  message: string;
  taskId?: string;
  /** 失败/暂停原因码，便于日志与测试断言。 */
  reason?:
    | 'not_found'
    | 'not_authorized'
    | 'self_mention'
    | 'offline'
    | 'target_denies_requester'
    | 'task_inactive'
    | 'context_missing'
    | MentionTaskState;
}
