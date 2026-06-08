// Claude Code 委派的并发护栏（全局单例，内存维护）。
//
// 规则（方案 v6）：同一个 bot 同时最多 1 个 Claude 子进程；orchestrator 全局最多 5 个。
// 抢不到**不排队**——delegate 工具据此直接告诉 DeepSeek「我手上有任务，等会儿」，
// 由 DeepSeek 礼貌转达用户。这样既挡住失控刷订阅额度，也避免请求堆积。

const GLOBAL_MAX = 5;
const PER_BOT_MAX = 1;

let globalActive = 0;
const perBotActive = new Map<string, number>();

export interface DelegationSlot {
  /** 释放槽位（幂等，可重复调用）。务必放在 finally 里，防泄漏。 */
  release(): void;
}

export type AcquireResult =
  | { ok: true; slot: DelegationSlot }
  | { ok: false; reason: 'bot-busy' | 'global-busy' };

/** 非阻塞抢一个委派槽位。抢不到返回原因，调用方不应重试/排队。 */
export function tryAcquireDelegationSlot(botId: string): AcquireResult {
  const botCount = perBotActive.get(botId) ?? 0;
  // 先判 per-bot（更常见、信息更具体），再判全局
  if (botCount >= PER_BOT_MAX) return { ok: false, reason: 'bot-busy' };
  if (globalActive >= GLOBAL_MAX) return { ok: false, reason: 'global-busy' };

  globalActive++;
  perBotActive.set(botId, botCount + 1);

  let released = false;
  return {
    ok: true,
    slot: {
      release() {
        if (released) return;
        released = true;
        globalActive = Math.max(0, globalActive - 1);
        const n = (perBotActive.get(botId) ?? 1) - 1;
        if (n <= 0) perBotActive.delete(botId);
        else perBotActive.set(botId, n);
      },
    },
  };
}

export function delegationStats(): { globalActive: number; globalMax: number; perBotMax: number } {
  return { globalActive, globalMax: GLOBAL_MAX, perBotMax: PER_BOT_MAX };
}

// ============================================================
// Claude 帖直通的并发预算（与上面的委派槽分离）
// ------------------------------------------------------------
// 直通是「帖子=终端」：一个 bot 可同时维护多个活跃帖，故**不能**套用委派的 per-bot=1（会让多帖互相阻塞）。
// 同帖消息已由 bot-manager 的 channelQueues（key=thread.id）天然串行；这里只设**全局**上限保护机器。
// ============================================================

const GLOBAL_THREAD_SESSION_MAX = 6;
let threadSessionActive = 0;

export type ThreadSlotResult =
  | { ok: true; slot: DelegationSlot }
  | { ok: false; reason: 'global-busy' };

/** 非阻塞抢一个直通回合槽位（仅全局上限）。抢不到 → 帖里回「系统繁忙稍后」。 */
export function tryAcquireThreadSlot(): ThreadSlotResult {
  if (threadSessionActive >= GLOBAL_THREAD_SESSION_MAX) return { ok: false, reason: 'global-busy' };
  threadSessionActive++;
  let released = false;
  return {
    ok: true,
    slot: {
      release() {
        if (released) return;
        released = true;
        threadSessionActive = Math.max(0, threadSessionActive - 1);
      },
    },
  };
}
