// L2 滚动摘要的核心：把「滑出近期窗口」的旧对话持续折叠（fold）进一段有上限的摘要。
//
// 设计要点：
//  · fire-and-forget：note() 入队后立刻返回，绝不阻塞 Discord 回复；失败只 console.error，退化为今天的「静默丢弃旧对话」。
//  · 每会话串行 fold（chains 链式）：并发两条消息不会互相覆盖 conversation_state，且每次 fold 都建立在上一次结果之上，旧对话不丢。
//  · 摘要走 system prompt 注入（见 tools/index.ts composeSystemPrompt），绝不作为合成消息——保住 history 文本不变量。
//  · 摘要文本有硬字符上限，注入开销恒定，不随对话变长而增长。

import type { LanguageModel, ModelMessage } from 'ai';
import { generateReply } from './llm.js';
import { conversationRepo } from './conversation-repo.js';

function intEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}
function boolEnv(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return def;
  return !/^(0|false|no|off)$/i.test(raw.trim());
}

/** L2 主开关（全局）。per-bot 还有 conversationMemory.summaryEnabled，两者皆 true 才生效。 */
export const SUMMARY_ENABLED = boolEnv('CONV_SUMMARY_ENABLED', true);
/** 摘要硬上限（按字符近似 token；中文约 1 字≈1 token）。fold 指令 + 落库前截断双重保证。 */
export const SUMMARY_MAX_CHARS = intEnv('CONV_SUMMARY_MAX_TOKENS', 1000);
/**
 * fold 批量粒度（轮）：滑出窗口的旧对话先在内存里暂存（仍喂给模型，不丢上下文），攒够这么多轮才折叠一次。
 * 默认 3——把「每条消息都折叠」的额外 LLM 调用降到约 1/3，显著省 token；代价是内存里多留至多这么多轮、
 * 且重启可能丢失这一小批未折叠轮（逐字窗口仍完整复原）。设为 1 即「每溢出即折叠」。
 */
export const SUMMARY_TRIGGER_TURNS = intEnv('CONV_SUMMARY_TRIGGER_TURNS', 3);

const FOLD_SYSTEM = `你是对话记忆压缩器。把【已有摘要】与【新增对话】合并成一段不超过 ${SUMMARY_MAX_CHARS} 字的第三人称要点摘要。
要求：
- 只合并、不创造：不要编造未在内容中出现的事实。
- 保留稳定有用的信息：用户透露的事实/偏好、双方的决定、未解决的问题、正在进行的任务。
- 丢弃寒暄、客套、以及已被后续内容覆盖或纠正的旧信息。
- 用紧凑的要点式中文，不要加前后缀说明，直接输出摘要正文。`;

/** 把若干轮 ModelMessage 渲染成 fold 用的文本。content 非字符串时降级为 JSON。 */
export function renderDroppedTurns(turns: ModelMessage[]): string {
  const textOf = (c: ModelMessage['content']): string =>
    typeof c === 'string' ? c : JSON.stringify(c);
  return turns
    .map((t) => `${t.role === 'assistant' ? '助手' : '用户'}：${textOf(t.content)}`)
    .join('\n');
}

/** 按字符上限截断（保证注入开销有界）。 */
export function capSummary(text: string, maxChars: number = SUMMARY_MAX_CHARS): string {
  const s = text.trim();
  return s.length <= maxChars ? s : s.slice(0, maxChars);
}

/** 用 LLM 把旧摘要 + 新增对话折叠成新摘要（单次无工具调用）。抛错由调用方处理（保留旧摘要）。 */
export async function foldSummary(
  model: LanguageModel,
  oldSummary: string,
  droppedTurns: ModelMessage[]
): Promise<string> {
  const payload =
    `【已有摘要】\n${oldSummary || '（无）'}\n\n【新增对话（请并入摘要）】\n${renderDroppedTurns(droppedTurns)}`;
  const { text } = await generateReply(model, FOLD_SYSTEM, [], payload);
  return capSummary(String(text ?? ''));
}

export type FoldFn = (oldSummary: string, droppedTurns: ModelMessage[]) => Promise<string>;

/** 用 bot 自己的（或 CONV_SUMMARY_MODEL 指定的）模型构造 fold 函数。 */
export function makeLlmFoldFn(model: LanguageModel): FoldFn {
  return (oldSummary, droppedTurns) => foldSummary(model, oldSummary, droppedTurns);
}

/**
 * 每 BotInstance 一个：管某 bot 各会话的滚动摘要缓存 + 串行 fold 队列。
 * getForInjection 懒从 DB 载入（重启后自动接上）；note 入队 fold（fire-and-forget）。
 */
export class ConversationSummarizer {
  private cache = new Map<string, string>(); // sessionId -> summary
  private loaded = new Set<string>();
  private chains = new Map<string, Promise<void>>();

  constructor(private foldFn: FoldFn) {}

  /** 注入用：返回当前摘要（首次访问从 DB 懒载入并缓存）。失败→''。 */
  getForInjection(sessionId: string): string {
    if (!this.loaded.has(sessionId)) {
      this.cache.set(sessionId, conversationRepo.getSummary(sessionId));
      this.loaded.add(sessionId);
    }
    return this.cache.get(sessionId) ?? '';
  }

  /** 告知有若干轮滑出窗口，需并入摘要。立刻返回；fold 在每会话串行队列里 fire-and-forget 执行。 */
  note(sessionId: string, botId: string, droppedTurns: ModelMessage[]): void {
    if (!droppedTurns.length) return;
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prev
      .then(() => this.doFold(sessionId, botId, droppedTurns))
      .catch((e) => {
        console.error('[conv-memory] fold 失败（已忽略，退化为静默丢弃这批旧对话）', e);
      });
    this.chains.set(sessionId, next);
  }

  private async doFold(sessionId: string, botId: string, droppedTurns: ModelMessage[]): Promise<void> {
    const oldSummary = this.getForInjection(sessionId);
    const folded = await this.foldFn(oldSummary, droppedTurns); // 抛错则不更新缓存/DB（保留旧摘要）
    this.cache.set(sessionId, folded);
    this.loaded.add(sessionId);
    conversationRepo.upsertSummary(sessionId, botId, folded);
  }

  /** 测试用：等待某会话的 fold 队列排空。 */
  async settle(sessionId: string): Promise<void> {
    await (this.chains.get(sessionId) ?? Promise.resolve());
  }
}
