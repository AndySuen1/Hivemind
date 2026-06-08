import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  PermissionFlagsBits,
  type Message,
  type SendableChannels,
  type ForumChannel,
} from 'discord.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { query, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { LanguageModel, ModelMessage } from 'ai';
import type { Bot, BotRuntimeInfo, ScheduleItem, ScheduleRunAck } from '@hivemind/shared';
import { botRepo, providerRepo, projectRepo } from './repos.js';
import { createLlmModel, generateAgentReply } from './llm.js';
import { buildBotToolRuntime, composeSystemPrompt, type BotToolRuntime, type PromptExtras } from './tools/index.js';
import type { DelegationContext } from './claude/delegation.js';
import {
  buildClaudeOptions,
  pumpQuery,
  wireAbort,
  type ClaudeRunResult,
  type ClaudeStreamSink,
} from './claude/delegation-core.js';
import { createPermissionHandler } from './claude/permission-relay.js';
import { tryAcquireThreadSlot } from './claude/concurrency.js';
import { ThreadStreamSink, type ThreadStreamTarget } from './claude/thread-stream-sink.js';
import { threadSessionRepo, type ThreadSession } from './thread-session-repo.js';
import { classifyThreadMessage } from './thread-router.js';
import { assertRealpathAllowed, assertWriteTargetAllowed } from './tools/path-guard.js';
import type { MentionExperimentalContext, DiscordPushContext } from './tools/mention-bot.js';
import { scheduler } from './scheduler.js';
import { interAgentRouter, InterAgentRouter, type CheckResult } from './inter-agent/router.js';
import type { DeliverMentionArgs, DeliverMentionResult, MentionChainContext, MentionTask, PendingHop } from './inter-agent/types.js';
import { computePeerHandles, scanPeerMentions, rewriteHandles, resolveMentionsReadable, resolvePeerByHandle } from './inter-agent/inline-mention.js';
import { askResume, sendStatus } from './claude/discord-ui.js';
import { recorder } from './recorder.js';
import { observRepo } from './observ-repo.js';
import { ConversationSummarizer, makeLlmFoldFn, SUMMARY_ENABLED, SUMMARY_TRIGGER_TURNS } from './conversation-memory.js';
import { retrieve, renderRetrieved, RETRIEVAL_ENABLED, RETRIEVAL_TOPK } from './retrieval.js';
import { conversationRepo } from './conversation-repo.js';
import {
  consolidate,
  CONSOLIDATE_ENABLED,
  CONSOLIDATE_EVERY_TURNS,
  CONSOLIDATE_IDLE_HOURS,
  CONSOLIDATE_MAX_PER_SWEEP,
  MEMORY_MAX_FACTS,
} from './memory-consolidation.js';
import { sessionMetaFromMessage, localToolLabel, shapeToolInput, isToolError } from './observe-helpers.js';

/**
 * 内联 @ 触发已通过护栏、登记好（FIFO）的一条待发转交：发出回复后由 processTurn 按消息块回填 messageId
 * 并登记「等待接力回报」。relay 先于发送登记（沿用 FIFO-first 消除网关竞态），attached 标记是否已回填。
 */
interface InlinePendingRelay {
  relayId: string;
  targetUserId: string;
  taskId: string;
  attached: boolean;
}

// L1 近期逐字窗口的全局默认轮数（实际消息数 = ×2）。可被每 bot 的 conversationMemory.windowTurns 覆盖。
// 读 env BOT_HISTORY_TURNS（仿 observ-retention 的 intEnv：缺省/非法 → 默认 20），clamp 到 [1,100] 防撑爆上下文。
const HISTORY_TURNS_MIN = 1;
const HISTORY_TURNS_MAX = 100;
function clampHistoryTurns(n: number): number {
  return Math.max(HISTORY_TURNS_MIN, Math.min(HISTORY_TURNS_MAX, Math.floor(n)));
}
const DEFAULT_HISTORY_TURNS = (() => {
  const raw = process.env.BOT_HISTORY_TURNS;
  const n = raw == null || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? clampHistoryTurns(n) : 20;
})();

// 喂给模型的逐字窗口的「总字符预算」：窗口按轮数封顶外，再按字符封顶——否则少数超长回复会让每条消息的
// 窗口输入 token 飙升（窗口是每条消息最大的 token 项）。0 = 不限。默认 16000 字符（约 5–6k token）。
const WINDOW_MAX_CHARS = (() => {
  const raw = process.env.CONV_WINDOW_MAX_CHARS;
  const n = raw == null || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 16000;
})();

/**
 * 按总字符预算裁剪喂给模型的历史：从最旧开始丢，保留最近若干条，至少保留 1 轮（2 条）。
 * 仅作用于「喂给模型的副本」，不动存储与折叠——被预算挤出的旧轮仍在内存/会按轮数折叠进摘要，gist 不丢。
 */
export function budgetHistoryByChars(msgs: ModelMessage[], maxChars: number): ModelMessage[] {
  if (maxChars <= 0 || msgs.length <= 2) return msgs;
  let total = 0;
  let startIdx = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const c = msgs[i]?.content;
    const len = typeof c === 'string' ? c.length : 200;
    if (msgs.length - i > 2 && total + len > maxChars) {
      startIdx = i + 1;
      break;
    }
    total += len;
  }
  return startIdx > 0 ? msgs.slice(startIdx) : msgs;
}

// 合成回合（调度器/手动触发）的「发起人」：非外部用户，跳过访问控制（调度是平台配置的）。
const SCHEDULER_REQUESTER = '__scheduler__';

// Claude 帖直通的权限/反问超时（与委派同口径）。
const THREAD_PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
const THREAD_QUESTION_TIMEOUT_MS = 30 * 60 * 1000;
// reset 时让旧 Claude 自我总结的固定 prompt（交接文档）。
const HANDOFF_PROMPT =
  '请把本次会话到目前为止的工作总结成一份「交接文档」，供另一个 Claude 接手继续：\n' +
  '1) 已完成的工作；2) 当前文件/代码状态；3) 未完成的任务；4) 关键决策与踩过的坑；5) 建议的下一步。\n' +
  '用简洁的中文 Markdown 输出，只输出文档正文，不要执行任何工具或命令。';

/** 从首条 prompt 解析可选「项目」前缀：首个词若匹配某 workspaceDir 的目录名，用它作 cwd 并从 prompt 剥离。 */
function pickThreadCwd(prompt: string, dirs: string[]): { cwd: string; prompt: string } {
  const trimmed = prompt.trimStart();
  const firstTok = trimmed.split(/\s+/)[0] ?? '';
  if (firstTok) {
    const lower = firstTok.toLowerCase();
    for (const d of dirs) {
      const base = d.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
      if (base && base === lower) return { cwd: d, prompt: trimmed.slice(firstTok.length).trim() };
    }
  }
  return { cwd: dirs[0]!, prompt };
}

/**
 * 主脑工具 workdir 参数 → 具体 cwd：匹配某 workspaceDir 的目录名 → 那个；看起来像路径 → 原样（交 path-guard 校验）；
 * 否则（含空/「主工作区」这类口语）→ 第一个工作目录。最终都会过 assertRealpathAllowed。
 */
function resolveWorkdirHint(hint: string | undefined, dirs: string[]): string {
  const h = (hint ?? '').trim();
  if (!h) return dirs[0]!;
  const lower = h.toLowerCase();
  for (const d of dirs) {
    const base = d.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
    if (base && base === lower) return d;
  }
  if (/[\\/]/.test(h) || /^[a-zA-Z]:/.test(h)) return h; // 像绝对/相对路径 → 交白名单校验
  return dirs[0]!;
}

/** runSyntheticTurn 的结果（与 shared ScheduleRunAck 对齐，缺 botId 由 manager 补）。 */
type SyntheticTurnResult = Omit<ScheduleRunAck, 'botId'>;

class BotInstance {
  private client: Client;
  private model: LanguageModel | null = null;
  private toolRuntime: BotToolRuntime | null = null;
  private history = new Map<string, ModelMessage[]>();
  // 每频道串行处理队列：同一频道的多条消息排队顺序处理，杜绝「并发 handleMessage 用陈旧 prev 快照
  // 互相覆盖 history → 静默丢轮」的读改写竞态（不同频道仍并发）。
  private channelQueues = new Map<string, Promise<void>>();
  // 已做过 L1 复原的频道：保证「从 DB 复原最近窗口」每频道至多一次（即便之后 history 合法地清空）
  private hydrated = new Set<string>();
  // 该 bot 的近期逐字窗口轮数（每 bot 可覆盖全局默认）。构造时按快照确定，运行期不变。
  private readonly windowTurns: number;
  // L2 滚动摘要：start() 时按开关创建；null = 未启用。summaryActive 是「全局 && 本 bot」开关的合取。
  private summarizer: ConversationSummarizer | null = null;
  private summaryActive = false;
  // L4 历史检索是否启用（「全局 && 本 bot」开关的合取）。
  private readonly retrievalActive: boolean;
  // L3 触发式记忆整理：start() 时按开关确定（需 全局开关 && 本 bot memory.enabled && L2 摘要启用）。
  private consolidateActive = false;
  // 每频道自上次整理以来的成功回合数（达 CONSOLIDATE_EVERY_TURNS 触发整理）。内存计数，重启清零（由空闲 loop 兜底）。
  private turnsSinceConsolidate = new Map<string, number>();
  // 每 bot 整理串行守护：避免轮数触发与空闲 loop 并发写同一 memoryDir / MEMORY.md。
  private consolidating = false;
  // 在跑的消息处理的 AbortController 集合：bot 停机时全部 abort，中止在跑的 Claude 委派
  private active = new Set<AbortController>();
  // 已停机标记：stop() 置 true，用于在 start() 的登录重试退避期间被停机时立刻放弃（避免停机后还在重连）。
  private stopped = false;
  public status: BotRuntimeInfo['status'] = 'offline';
  public errorMessage?: string;
  public connectedAt?: number;

  constructor(private bot: Bot) {
    this.windowTurns = clampHistoryTurns(bot.tools.conversationMemory.windowTurns ?? DEFAULT_HISTORY_TURNS);
    this.retrievalActive = RETRIEVAL_ENABLED && bot.tools.conversationMemory.retrievalEnabled;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this.client.once('ready', () => {
      this.status = 'online';
      this.connectedAt = Date.now();
      console.log(`[bot:${this.bot.name}] 已上线: ${this.client.user?.tag}`);
    });

    this.client.on('error', (e) => {
      this.status = 'error';
      this.errorMessage = e.message;
      console.error(`[bot:${this.bot.name}] error`, e);
    });

    this.client.on('messageCreate', (msg) => this.enqueueMessage(msg));
  }

  /**
   * 把消息按频道串行入队：同频道严格顺序处理（前一条 handleMessage 完整写回 history 后下一条才开始），
   * 消除并发读改写竞态导致的丢轮。不同频道的队列相互独立、仍并发。链尾异常被吞，不影响后续。
   */
  private enqueueMessage(msg: Message): void {
    const chanId = msg.channel.id;
    const prev = this.channelQueues.get(chanId) ?? Promise.resolve();
    const next = prev
      .then(() => this.handleMessage(msg))
      .catch((e) => console.error(`[bot:${this.bot.name}] handleMessage 未捕获异常（已隔离）`, e));
    this.channelQueues.set(chanId, next);
  }

  async start(): Promise<void> {
    this.status = 'connecting';
    try {
      const token = await botRepo.getDiscordToken(this.bot.id);
      if (!token) throw new Error('Discord token 未配置');

      const provider = providerRepo.get(this.bot.providerId);
      if (!provider) throw new Error(`Provider ${this.bot.providerId} 不存在`);

      this.model = await createLlmModel(provider, provider.model);
      // 注入跨 bot 转交（mention_bot）+ 开 Claude 帖（open_claude_thread）回调：都绑到全局 manager。
      this.toolRuntime = buildBotToolRuntime(
        this.bot,
        (ctx, args) => botManager.deliverMention(ctx, args),
        (ctx, args) => botManager.openClaudeThread(ctx, args)
      );
      const toolNames = Object.keys(this.toolRuntime.tools);
      if (toolNames.length) console.log(`[bot:${this.bot.name}] 工具：${toolNames.join(', ')}`);

      // L2 滚动摘要：全局开关 && 本 bot 开关皆开才启用。fold 默认复用 bot 自己的模型，
      // 可由 CONV_SUMMARY_MODEL 路由到同 provider 下更便宜的模型。
      this.summaryActive = SUMMARY_ENABLED && this.bot.tools.conversationMemory.summaryEnabled;
      if (this.summaryActive) {
        const summaryModelName = process.env.CONV_SUMMARY_MODEL?.trim();
        const summaryModel = summaryModelName
          ? await createLlmModel(provider, summaryModelName)
          : this.model;
        this.summarizer = new ConversationSummarizer(makeLlmFoldFn(summaryModel));
      }

      // L3 触发式整理：需全局开关 && 本 bot 开了长期记忆文件 && L2 摘要启用（整理以摘要为输入）。
      this.consolidateActive =
        CONSOLIDATE_ENABLED && this.bot.tools.memory.enabled && this.summaryActive && !!this.toolRuntime.memoryDir;

      await this.loginWithRetry(token);

      // Phase 3.5：注册本 bot 的定时任务（按构造时快照的 bot.schedule）。改 schedule 要重启实例（restart=stop+start
      // 自动「注销旧 + 注册新」）。非法 cron / disabled 项由 scheduler 跳过。
      scheduler.register(this.bot, (item, index) => this.runScheduledItem(item, index));
    } catch (e) {
      this.status = 'error';
      this.errorMessage = (e as Error).message;
      console.error(`[bot:${this.bot.name}] 启动失败`, e);
      throw e;
    }
  }

  /**
   * 冷启动网络竞速容错：开机自启时 orchestrator 往往在网络/DNS/TLS 通道就绪前就拉起，
   * 首次 client.login 会因 TLS 握手被掐断而失败（discord.js 自带的自动重连只在「首连成功后」掉线才生效，
   * 救不了首连失败）。这里对**网络类瞬时错误**带退避重试；**鉴权错误（token 无效 / intents 不被允许）不重试**
   * （重试也不会好，还可能触发 Discord 限流）。重试期间 status 保持 'connecting'，被停机则立刻放弃。
   */
  private async loginWithRetry(token: string): Promise<void> {
    const backoffMs = [2000, 4000, 8000, 16000, 30000]; // 最多 6 次尝试（首次 + 5 次重试），约覆盖开机后 60s 网络预热
    for (let attempt = 0; ; attempt++) {
      try {
        await this.client.login(token);
        return;
      } catch (e) {
        if (this.stopped) throw e; // 重试期间被停机：放弃
        if (attempt >= backoffMs.length || !this.isTransientNetworkError(e)) throw e;
        const wait = backoffMs[attempt];
        console.warn(
          `[bot:${this.bot.name}] 登录失败（第 ${attempt + 1} 次，${wait}ms 后重试）：${(e as Error).message}`,
        );
        await new Promise((r) => setTimeout(r, wait));
        if (this.stopped) throw new Error('启动期间已停机，放弃登录重试');
      }
    }
  }

  /** 判断是否为「网络/DNS/TLS 瞬时错误」（值得重试）。鉴权类错误明确排除——重试无意义且会被限流。 */
  private isTransientNetworkError(e: unknown): boolean {
    const err = e as { code?: unknown; message?: unknown };
    const code = typeof err?.code === 'string' ? err.code : '';
    const msg = typeof err?.message === 'string' ? err.message : String(e ?? '');
    // 鉴权/配置类失败：不重试
    if (/invalid token|token.*invalid|disallowed intents|privileged intent/i.test(msg)) return false;
    return (
      /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR/i.test(code) ||
      /socket disconnected|secure TLS|network socket|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|getaddrinfo|EAI_AGAIN|network|timed out|timeout|fetch failed|terminated/i.test(
        msg,
      )
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // 先注销定时任务（防停机后 cron 还触发已断开的实例），再中止在跑回合、断开 client。
    scheduler.unregister(this.bot.id);
    // 先中止所有在跑的委派（杀 Claude 子进程 + 取消待处理的 Discord 交互），再断开 client
    for (const ac of this.active) ac.abort();
    this.active.clear();
    try {
      await this.client.destroy();
    } catch (e) {
      console.error(`[bot:${this.bot.name}] stop error`, e);
    }
    this.status = 'offline';
    this.connectedAt = undefined;
    console.log(`[bot:${this.bot.name}] 已下线`);
  }

  private async handleMessage(msg: Message): Promise<void> {
    if (!this.model || !this.toolRuntime) return;
    const me = this.client.user;
    // 忽略自己发的消息（含自己发出的 @ 转交；否则 A 会处理自己刚发的转交消息）
    if (me && msg.author.id === me.id) return;

    // Claude 帖直通分流（仅人类消息）：绑定帖内消息 → 直接喂给该帖的 Claude session（跳过 DeepSeek）；
    // @bot + 触发词 → 在论坛频道建帖。命中即在此收口，不落入下面的 DeepSeek 流。
    if (!msg.author.bot && this.bot.tools.claudeThread.enabled) {
      if (await this.maybeHandleThread(msg)) return;
    }

    // 本回合的协作链上下文：人类回合 = undefined（首次调 mention_bot 才惰性开链）；接力回合 = { taskId }。
    let relayChain: MentionChainContext | undefined;
    // 访问控制 / 可观测性归属的「发起人」：人类回合 = 消息作者；接力回合 = 链的人类发起人。
    let requesterId = msg.author.id;
    // 该回合是否为「接力回报」（对方引用回复了我发出的转交消息），用于可观测性标签 + 抑制回报回合再扇出。
    let isReport = false;
    // 转发/回报这条消息的同伴 bot（= msg.author）。用于：可观测性 fromBotId 取真实转发者、给接收方注入来源上下文。
    let senderBot: { id: string; name: string } | undefined;

    if (msg.author.bot) {
      const now = Date.now();
      senderBot = botManager.resolveBotByUserId(msg.author.id);
      // ① 接力回报：对方「引用回复」了我发出的 @ 转交消息 → 把它当作本协作任务的回报来处理。
      // （修复：员工 bot 引用回复 PM 的转交消息时，PM 此前收不到 / 不处理——回报方向从未接线。）
      // 仅当回报方确属当初被 @ 的同伴时才受理（matchReplyAwait 校验 senderUserId），防其它 bot 误触发回报。
      const refId = msg.reference?.messageId;
      const back = refId
        ? interAgentRouter.matchReplyAwait({ channelId: msg.channel.id, refMessageId: refId, ownerBotId: this.bot.id, senderUserId: msg.author.id, now })
        : undefined;
      if (back) {
        const task = interAgentRouter.getTask(back.taskId);
        if (!task || task.state === 'terminated') return; // 任务已终止/失效，不再处理回报
        relayChain = { taskId: task.taskId };
        requesterId = task.rootRequesterId;
        isReport = true;
      } else {
        // ② 否则只接力「我方 Inter-Agent Router 登记过的合法转交」（@ 我）——consumeRelay 命中才处理；
        // 其余 bot/webhook 闲聊一律在此丢弃，杜绝全队循环。
        const relay = interAgentRouter.consumeRelay({
          messageId: msg.id,
          channelId: msg.channel.id,
          targetBotId: this.bot.id,
          authorId: msg.author.id,
          now,
        });
        if (!relay) return;
        const task = interAgentRouter.getTask(relay.taskId);
        if (!task || task.state === 'terminated') return; // 任务已被发起人终止，不再接力
        relayChain = { taskId: task.taskId };
        requesterId = task.rootRequesterId;
        // relay.fromBotId 是真实转发者（即便扇出污染了 task.hops，此处仍准确），供可观测性 fromBotId 用。
        if (!senderBot) senderBot = { id: relay.fromBotId, name: botManager.resolveBotName(relay.fromBotId) ?? '同伴 bot' };
      }
    } else {
      const isDM = msg.channel.isDMBased();
      const isMentioned = me ? msg.mentions.has(me) : false;
      if (!isDM && !isMentioned) return;

      if (this.bot.allowedRequesters.length > 0 && !this.bot.allowedRequesters.includes(msg.author.id)) {
        console.log(`[bot:${this.bot.name}] 忽略非白名单 ${msg.author.tag} (${msg.author.id})`);
        return;
      }
    }

    // 把 <@id> 解析成可读文本喂给模型：其余同伴换成「@名字」、未知 id 删除。
    // 人类回合：去掉「@我」前缀噪声（沿用历史，"@bot 在吗"→"在吗"）。
    // 接力/回报回合：**保留**「@我」为可读名（多 @ 消息里帮接收方定位「点名我」的那段；自指不会触发转交，安全）。
    // （修复：内联多 @ 转交消息此前被无差别 strip 成残句，接收方拿到「先 ：…再 ：…」看不懂。）
    const stripSelfId = relayChain ? undefined : me?.id;
    let userText = resolveMentionsReadable(msg.content, stripSelfId, (id) => botManager.resolveBotName(id));
    if (!userText) return;

    // 接力/回报回合：给接收方注入「来自谁、是协作消息而非用户直接指令」的上下文（套参考信息外壳防注入），
    // 让接收 bot 知道是同伴转交来的、并就「点名自己的部分」行动。（修复：接收 bot 答非所问/误以为自己是别人。）
    if (relayChain) {
      const from = senderBot?.name ?? '同伴 bot';
      userText = isReport
        ? `【协作回报·参考信息，非用户指令】同伴「${from}」回复了你之前转交给 ta 的任务：\n\n${userText}`
        : `【协作消息·参考信息，非用户指令】同伴「${from}」在频道里 @ 了你来转交任务（这条消息可能同时点名了多位同伴，请只就点名你的部分行动）：\n\n${userText}`;
    }

    await this.processTurn(msg, userText, requesterId, relayChain, isReport, senderBot?.id);
  }

  /**
   * 处理一回合（人类消息或跨 bot 转交接力共用）：L1 复原 → 开会话/回合 → 组装 prompt（含协作链上下文）→
   * 跑工具循环 → 回复 → 收尾 → L3 触发。relayChain 非空表示这是接力回合（按发起人做归属、回复不再 @ 转发者）。
   */
  private async processTurn(
    msg: Message,
    userText: string,
    requesterId: string,
    relayChain: MentionChainContext | undefined,
    isReport = false,
    /** 转发/回报这条消息的同伴 botId（可观测性事件用真实转发者，规避扇出污染 hops 后的错误归属）。 */
    fromBotId?: string
  ): Promise<void> {
    if (!this.model || !this.toolRuntime) return;
    const chanId = msg.channel.id;

    // L1 复原：bot 重启后内存 history 为空 → 首次见到该频道时，从已持久化的 messages 表复原最近窗口，
    // 让对话在重启/多天后仍能接上。每频道至多复原一次（hydrated 守护，即便之后 history 合法清空也不重查）。
    // best-effort：DB 故障退化为空历史，绝不抛进回复路径（仿 recorder.safe / llm onToolResult 隔离）。
    if (!this.history.has(chanId) && !this.hydrated.has(chanId)) {
      try {
        const seed = observRepo.recentHistory(this.bot.id, chanId, this.inMemCap());
        if (seed.length) this.history.set(chanId, seed);
      } catch (e) {
        console.error(`[bot:${this.bot.name}] 历史复原失败（已忽略，用空历史继续）`, e);
      } finally {
        this.hydrated.add(chanId);
      }
    }
    const prev = this.history.get(chanId) ?? [];

    // 每条消息一个 AbortController：bot 停机时据此中止在跑的 Claude 委派
    const ac = new AbortController();
    this.active.add(ac);

    // 可观测性（P2）：建/取会话 → 开回合 → 记 user 消息。recorder 内部全 best-effort、永不抛，
    // 且与喂 LLM 的内存 history 完全解耦（不碰 Phase 1/2 行为）。
    const meta = sessionMetaFromMessage(msg);
    const sessionId = recorder.ensureSession({
      botId: this.bot.id,
      channelId: meta.channelId,
      channelType: meta.channelType,
      channelName: meta.channelName,
      guildId: meta.guildId,
      title: userText.slice(0, 80),
    });
    const runId = recorder.startRun({ sessionId, botId: this.bot.id, requesterId });
    recorder.recordMessage({
      sessionId,
      runId,
      botId: this.bot.id,
      role: 'user',
      content: userText,
      // 接力回合的「作者」是转发它的 bot（msg.author），归属（run.requesterId）则记人类发起人，两者并存便于追溯。
      authorId: msg.author.id,
      authorName: msg.author.username,
    });

    // 接力回合：把本回合的 ac 登记到协作任务（发起人「终止」时据此中止下游在跑回合）；记一条「收到转交」事件。
    if (relayChain?.taskId) {
      interAgentRouter.addController(relayChain.taskId, ac);
      interAgentRouter.touchTask(relayChain.taskId, Date.now());
      const hops = interAgentRouter.getTask(relayChain.taskId)?.hops ?? [];
      recorder.recordEvent({
        runId,
        sessionId,
        botId: this.bot.id,
        type: 'mention',
        label: isReport ? '🤝 收到回报' : '🤝 收到转交',
        status: 'received',
        input: {
          taskId: relayChain.taskId,
          // 用真实转发/回报者（fromBotId）；扇出（一条消息@多人）会把多条平行边塞进线性 hops，
          // hops[n-2] 在第 2+ 个目标上会指错人，故优先用 fromBotId，仅缺省时退回 hops 推断。
          fromBotId: fromBotId ?? (hops.length >= 2 ? hops[hops.length - 2] : undefined),
          depth: Math.max(0, hops.length - 1),
        },
      });
    }

    // 频道可发送时，构造委派/协作用的 Discord 上下文（delegate_to_claude / mention_bot 经 experimental_context 取用）
    const channel = msg.channel;
    const experimentalContext: MentionExperimentalContext | undefined = channel.isSendable()
      ? {
          discord: {
            botId: this.bot.id,
            botName: this.bot.name,
            // 接力回合用人类发起人做权限/反问归属（msg.author 是转发它的 bot，不该替它批准危险操作）
            requesterId,
            channel,
            signal: ac.signal,
            // 串联可观测性：委派内的 delegate_*/权限/反问事件挂在本回合 run 下
            runId,
            sessionId,
          },
          // 协作链：接力回合带 taskId（扩展现有任务）；人类回合带 root 种子（首次 mention_bot 才开链）
          mention: relayChain ?? {
            root: { rootRequesterId: requesterId, rootBotId: this.bot.id, channelId: chanId },
          },
          // discord_push：让 bot 主动推到白名单频道（启用了才注入；未启用为 undefined，工具也不会装配）
          push: this.buildPushContext(),
        }
      : undefined;

    // 内联 @ 触发已登记（FIFO）、待发出回复后回填 messageId 的 relay。声明在 try 外，使发送失败时 catch 能撤销未回填的，
    // 避免「relay 已登记但消息没发出去」的悬挂登记被后续无关消息 FIFO 误配（与 postRelay 发送失败 cancelRelay 一致）。
    let inlinePending: InlinePendingRelay[] = [];

    try {
      if ('sendTyping' in msg.channel && typeof msg.channel.sendTyping === 'function') {
        await msg.channel.sendTyping();
      }
      // L2：注入本会话滚动摘要（更早对话的压缩记录）。getForInjection 懒从 DB 载入，重启后自动接上。
      const promptExtras: PromptExtras = {};
      if (this.summaryActive && this.summarizer) {
        promptExtras.summary = this.summarizer.getForInjection(sessionId);
      }
      // L4：按当前提问从历史消息检索相关旧片段，注入更早对话。仅当已有内容滑出窗口（prev 已满）才检索——
      // 窗口未满时所有历史都在 prev 里，FTS 只会捞到「已在窗口内」的消息（会被排除），白跑一次查询。
      // 排除最近 prev.length 条（= 当前内存窗口实际大小），避免与逐字历史重复且不过度排除。best-effort。
      if (this.retrievalActive && prev.length >= this.windowTurns * 2) {
        const snippets = retrieve(sessionId, userText, RETRIEVAL_TOPK, prev.length);
        if (snippets.length) promptExtras.retrieved = renderRetrieved(snippets);
      }
      const systemPrompt = composeSystemPrompt(this.bot, this.toolRuntime, promptExtras);
      const { text, usage, toolCallCount, finishReason } = await generateAgentReply({
        model: this.model,
        systemPrompt,
        // 按字符预算裁剪喂给模型的窗口（封顶每条消息的窗口 token 开销）；存储/折叠仍用完整 prev。
        history: budgetHistoryByChars(prev, WINDOW_MAX_CHARS),
        userText,
        tools: this.toolRuntime.tools,
        temperature: this.bot.temperature,
        experimentalContext,
        // bot 停机时中断整个工具循环（含本机工具），并让 catch 的 'aborted' 分支生效
        abortSignal: ac.signal,
        // 本地工具调用中央埋点：每个工具调用结束后记一条 tool_call 事件（含入参/出参，已脱敏截断）。
        // delegate_to_claude 由 runDelegation 记 delegate_start/step/end（更细，且 parentEventId 串联），
        // 这里跳过它的扁平 tool_call，避免时间线里与委派事件重复。
        onToolResult: (r) => {
          if (r.toolName === 'delegate_to_claude') return;
          recorder.recordEvent({
            runId,
            sessionId,
            botId: this.bot.id,
            type: 'tool_call',
            toolName: r.toolName,
            label: localToolLabel(r.toolName),
            status: isToolError(r.output) ? 'error' : 'ok',
            input: shapeToolInput(r.toolName, r.input),
            output: r.output,
          });
        },
      });

      // 区分“正常无文本”与“工具循环被步数上限截断”——后者不能谎报已完成
      let replyText = text.trim();
      if (!replyText) {
        const truncated = finishReason === 'tool-calls' || finishReason === 'length';
        if (truncated) {
          console.warn(`[bot:${this.bot.name}] 工具循环在 ${finishReason} 处截断，toolCalls=${toolCallCount}`);
          replyText = `⚠️ 处理步数已达上限，任务可能未完成（已执行 ${toolCallCount} 个工具调用）。需要的话我可以继续。`;
        } else {
          replyText = '（已处理完毕，但没有需要回复的文本。）';
        }
      }

      const newHistory: ModelMessage[] = [
        ...prev,
        { role: 'user', content: userText },
        { role: 'assistant', content: replyText },
      ];
      const keep = this.windowTurns * 2;
      if (this.summaryActive && this.summarizer) {
        // L2「软窗口」：超出窗口的旧轮先留在内存（仍喂模型，不丢上下文），攒够一批（keep + batch）才折叠，
        // 把「每条消息都折叠」的额外 LLM 调用降到约 1/批，省 token。折叠 fire-and-forget，绝不阻塞回复。
        const batchMsgs = SUMMARY_TRIGGER_TURNS * 2;
        if (newHistory.length > keep + batchMsgs) {
          const dropped = newHistory.slice(0, newHistory.length - keep);
          this.summarizer.note(sessionId, this.bot.id, dropped);
          this.history.set(chanId, newHistory.slice(-keep));
        } else {
          this.history.set(chanId, newHistory); // 暂存这一小批，待攒够再折叠
        }
      } else {
        this.history.set(chanId, newHistory.slice(-keep)); // 无摘要：维持今天的硬截断（直接丢弃旧轮）
      }

      // 记 assistant 消息（生成即记，无论 Discord 投递是否成功）。记模型原文（含「@同伴名」），不记改写后的 <@id>。
      recorder.recordMessage({ sessionId, runId, botId: this.bot.id, role: 'assistant', content: replyText });

      // Bug2：把回复正文里「@同项目同伴名」的纯文本转成真实 <@id> 提及 + 登记转交 relay，让对方接力处理。
      // （DeepSeek 常按系统提示在正文里内联 @ 派活而非走 mention_bot 工具；这一步让两种写法都能真正触发对方，
      // 并修复「@ 出现在消息中间时失败」。）best-effort：失败则原文照发、不触发内联，不打断回复。
      // **回报回合精准放开**：回报回合也扇出内联 @，但排除「刚给我回报的那个 bot」(fromBotId)——既修「PM 收到
      // 方案回报后转头 @ 程序派新活被静默吞掉」，又挡住「@ 回报者」这条 ping-pong 主链（旧 B2 整轮跳过的初衷，
      // 实测 35s 几十条风暴的源头）。残余风暴风险由 @纪律提示 + 同一目标跳数上限 + 短循环检测兜底。
      let outText = replyText;
      if (experimentalContext) {
        const res = botManager.deliverInlineMentions(
          experimentalContext.discord!,
          experimentalContext.mention!,
          replyText,
          Date.now(),
          isReport ? fromBotId : undefined
        );
        outText = res.text;
        inlinePending = res.pending;
      }

      // 接力回合回复对方的转交消息，但不再 @ 回转发它的 bot（避免互相 ping 噪声 / 误触发）。
      // 仅放行「我们注入的同伴 <@id>」，杜绝 LLM 正文里写出 @everyone/@role 被真实触达。
      for (const chunk of chunkText(outText, 1900)) {
        const injected = inlinePending.filter((p) => chunk.includes(`<@${p.targetUserId}>`)).map((p) => p.targetUserId);
        let payload: Parameters<typeof msg.reply>[0];
        if (relayChain) {
          payload = injected.length
            ? { content: chunk, allowedMentions: { users: injected, repliedUser: false } }
            : { content: chunk, allowedMentions: { repliedUser: false } };
        } else {
          // 人类回合：保留「回复并 ping 发问的人」（repliedUser 默认 true），但内容里仅放行注入的同伴。
          payload = injected.length ? { content: chunk, allowedMentions: { users: injected } } : chunk;
        }
        const sent = await msg.reply(payload);
        // 内联 @ 触发：本块含某同伴的 <@id> → 回填该 relay 的 messageId（精确匹配优先），并登记「等待接力回报」，
        // 这样对方接力后引用回复这条消息，回报能路由回本 bot（与 bug1 同一机制）。
        if (injected.length) {
          let taskId: string | undefined;
          for (const p of inlinePending) {
            if (!p.attached && chunk.includes(`<@${p.targetUserId}>`)) {
              interAgentRouter.attachMessageId(p.relayId, sent.id);
              p.attached = true;
              taskId = p.taskId; // 同一回合内各 pending 同属一条任务，取其一即可
            }
          }
          // expectedSenderUserIds=injected：只有本块点名的同伴才是合法回报方，杜绝其它 bot 引用回复误触发回报。
          if (taskId) {
            interAgentRouter.registerReplyAwait({
              taskId,
              ownerBotId: this.bot.id,
              channelId: msg.channel.id,
              messageId: sent.id,
              expectedSenderUserIds: injected,
              now: Date.now(),
            });
          }
        }
      }

      // 收尾回合（投递成功后）。finishReason 记录是否因步数/长度截断。
      recorder.endRun(runId, { status: 'ok', finishReason, toolCallCount, usage });

      console.log(
        `[bot:${this.bot.name}] ${msg.author.tag} -> ${userText.slice(0, 60)}${userText.length > 60 ? '…' : ''} | tools: ${toolCallCount} | usage: ${JSON.stringify(usage)}`
      );

      // L3 轮数触发：本频道累计成功回合达阈值 → 整理一次（fire-and-forget，绝不阻塞）。
      // 计数器只在「整理真正跑了」后才清零（attempted=true）；若被 consolidating 守护挤掉（attempted=false），
      // 保留计数，下条消息再试，避免「跳过却清零 → 这次里程碑被白白丢掉、要再攒满 50 轮」。
      if (this.consolidateActive) {
        const n = (this.turnsSinceConsolidate.get(chanId) ?? 0) + 1;
        this.turnsSinceConsolidate.set(chanId, n);
        if (n >= CONSOLIDATE_EVERY_TURNS) {
          void this.consolidateSession(sessionId)
            .then((attempted) => {
              if (attempted) this.turnsSinceConsolidate.set(chanId, 0);
            })
            .catch(() => {});
        }
      }
    } catch (e) {
      // 撤销「已登记但其消息没发出去」的内联 @ relay（如回复发送中途抛错），防悬挂登记被后续无关消息 FIFO 误配。
      // 已成功发出并回填 messageId 的（attached）不动；已被对方消费的 cancelRelay 是 no-op，安全。
      for (const p of inlinePending) if (!p.attached) interAgentRouter.cancelRelay(p.relayId);
      // abortSignal 已透传给 generateText：bot 停机 / 放弃该消息（ac.abort()）会让其抛 AbortError 落到这里。
      // abort 是**正常中止**而非出错：只把回合收尾为 'aborted'，不记 error 事件、也不向用户发误导性的
      // 「出错」消息（委派场景下 runDelegation 已记过 delegate_end(aborted)，这里再记 error 会污染时间线）。
      if (ac.signal.aborted) {
        recorder.endRun(runId, { status: 'aborted' });
        console.log(`[bot:${this.bot.name}] 回合已中止（停机/取消）`);
      } else {
        recorder.recordEvent({
          runId,
          sessionId,
          botId: this.bot.id,
          type: 'error',
          status: 'error',
          output: (e as Error).message,
        });
        recorder.endRun(runId, { status: 'error', error: (e as Error).message });
        console.error(`[bot:${this.bot.name}] reply error`, e);
        // 错误通知本身可能再失败（频道被删/限流），吞掉以免冒泡成 unhandled rejection 影响进程。
        await msg.reply(`❌ 出错：${(e as Error).message}`).catch(() => {});
      }
    } finally {
      this.active.delete(ac);
      if (relayChain?.taskId) {
        interAgentRouter.removeController(relayChain.taskId, ac);
        interAgentRouter.touchTask(relayChain.taskId, Date.now());
      }
    }
  }

  getStatus(): BotRuntimeInfo {
    return {
      botId: this.bot.id,
      status: this.status,
      errorMessage: this.errorMessage,
      connectedAt: this.connectedAt,
    };
  }

  /** 本 bot 的 Discord 应用 user id（上线后才有）。供 Inter-Agent 组装 @mention 与判定 fleet 身份。 */
  get userId(): string | undefined {
    return this.client.user?.id;
  }

  /** 本 bot 启动时快照的配置（Inter-Agent 取 mentionBot 白名单/预算等）。 */
  getBot(): Bot {
    return this.bot;
  }

  /**
   * 内存中保留的消息数上限：逐字窗口 keep(=windowTurns×2) + 启用摘要时额外暂存一批（待折叠）。
   * 同时用作 L1 复原条数与 L4 检索排除的近期消息数，保证「内存里有的」不与摘要/检索重复。
   */
  private inMemCap(): number {
    return this.windowTurns * 2 + (this.summaryActive ? SUMMARY_TRIGGER_TURNS * 2 : 0);
  }

  /**
   * L3：把某会话的 L2 摘要整理（固化）进长期记忆文件。每 bot 串行（consolidating 守护），best-effort 永不抛。
   * 由轮数触发与空闲 loop 共用。
   */
  private async consolidateSession(sessionId: string): Promise<boolean> {
    if (!this.consolidateActive || !this.model || !this.toolRuntime?.memoryDir) return true; // 无需整理，视作已处理
    if (this.consolidating) return false; // 已在整理（轮数触发 vs 空闲 loop 竞争）→ 本次跳过，调用方保留计数下次再试
    this.consolidating = true;
    try {
      const summary = conversationRepo.getState(sessionId)?.summary ?? '';
      if (!summary.trim()) return true; // 无摘要可固化，视作已处理（无需再触发）
      const res = await consolidate({
        model: this.model,
        dir: this.toolRuntime.memoryDir,
        summary,
        maxFacts: MEMORY_MAX_FACTS,
      });
      conversationRepo.markConsolidated(sessionId);
      if (res) {
        console.log(
          `[bot:${this.bot.name}] 记忆整理 会话${sessionId.slice(0, 8)}：+${res.upserted} -${res.deleted} 淘汰${res.evicted.length}`
        );
      }
      return true;
    } catch (e) {
      console.error(`[bot:${this.bot.name}] consolidateSession 失败（已忽略）`, e);
      return true; // 失败也算「尝试过」：清零计数避免每条消息重试刷屏；下个里程碑或空闲 loop 会再来
    } finally {
      this.consolidating = false;
    }
  }

  /** L3 空闲触发：整理本 bot「已空闲且有新内容」的会话。供 BotManager 的后台 loop 调用。 */
  async consolidateIdleSessions(now: number): Promise<void> {
    if (!this.consolidateActive) return;
    const idleBefore = now - CONSOLIDATE_IDLE_HOURS * 60 * 60 * 1000;
    // 每个 sweep 每 bot 限量处理，防止重启/积压后一次齐发几十个整理 LLM 调用；剩余会话下个 sweep（每 1h）续跑。
    const candidates = conversationRepo
      .listIdleForConsolidation(this.bot.id, idleBefore)
      .slice(0, CONSOLIDATE_MAX_PER_SWEEP);
    for (const c of candidates) {
      await this.consolidateSession(c.sessionId); // 串行（consolidating 守护）
    }
  }

  // ============================================================
  // Phase 3.5：discord_push 推送 + 调度/手动触发的合成回合
  // ============================================================

  /** 取一个可发送的频道（缓存优先，再 fetch）。不可用 → null。 */
  private async fetchSendableChannel(channelId: string): Promise<SendableChannels | null> {
    try {
      const ch = this.client.channels.cache.get(channelId) ?? (await this.client.channels.fetch(channelId));
      return ch && ch.isSendable() ? ch : null;
    } catch {
      return null;
    }
  }

  /**
   * 把内容发到指定频道（discord_push 工具与调度直发的底层发送原语）。禁 @everyone/@role（allowedMentions parse:[]），
   * 超 1900 自动分块。不抛——返回 {ok,error}。白名单校验由调用方（工具 execute 已查 / 调度直发系平台授权）负责。
   */
  async sendToChannel(channelId: string, content: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const channel = await this.fetchSendableChannel(channelId);
      if (!channel) return { ok: false, error: '频道不存在或不可发送' };
      for (const chunk of chunkText(content, 1900)) {
        await channel.send({ content: chunk, allowedMentions: { parse: [] } });
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 启用 discord_push 时构造注入工具的推送上下文（白名单 + 绑定本 bot 的发送闭包）；未启用 → undefined。 */
  private buildPushContext(): DiscordPushContext | undefined {
    if (!this.bot.tools.discordPush.enabled) return undefined;
    return {
      botId: this.bot.id,
      allowedChannelIds: this.bot.tools.discordPush.channelIds,
      sendToChannel: (channelId, text) => this.sendToChannel(channelId, text),
    };
  }

  /** cron 到点触发：跑 schedule 第 index 项。best-effort（runSyntheticTurn 内部已兜异常）。 */
  private async runScheduledItem(item: ScheduleItem, index: number): Promise<void> {
    await this.runSyntheticTurn(item.prompt, {
      source: 'schedule',
      targetChannelId: item.targetChannelId,
      cron: item.cron,
    });
  }

  /**
   * 合成回合（调度器 / Dashboard 手动触发共用）：不依赖 Discord Message，复用 generateAgentReply 核心跑一回合。
   * 经 channelQueues 串行（键 = targetChannelId 或合成键），避免与该频道普通消息并发读改写 history。
   * 不写入 this.history（不污染人类对话窗口）；以空历史 + 现算 system prompt（含已加载 skill）运行。
   * targetChannelId 有值 → 最终回复直接发该频道（平台授权，不经 discord_push 白名单）；空 → 发哪靠 skill 内 discord_push。
   */
  async runSyntheticTurn(
    prompt: string,
    opts: { source: 'schedule' | 'manual'; targetChannelId?: string; cron?: string }
  ): Promise<SyntheticTurnResult> {
    if (this.status !== 'online' || !this.model || !this.toolRuntime) {
      return { status: 'offline', message: 'bot 未在线' };
    }
    const queueKey = opts.targetChannelId ?? `synthetic:${this.bot.id}`;
    return this.enqueueOnChannel(queueKey, () => this.doSyntheticTurn(prompt, opts));
  }

  private async doSyntheticTurn(
    prompt: string,
    opts: { source: 'schedule' | 'manual'; targetChannelId?: string; cron?: string }
  ): Promise<SyntheticTurnResult> {
    if (!this.model || !this.toolRuntime) return { status: 'error', message: '未就绪' };

    const ac = new AbortController();
    this.active.add(ac);
    const channel = opts.targetChannelId ? await this.fetchSendableChannel(opts.targetChannelId) : null;
    const channelId = opts.targetChannelId ?? `synthetic:${this.bot.id}`;
    const isManual = opts.source === 'manual';

    const sessionId = recorder.ensureSession({
      botId: this.bot.id,
      channelId,
      channelType: opts.targetChannelId ? undefined : 'scheduled',
      title: `[${isManual ? '手动' : '定时'}] ${prompt.slice(0, 60)}`,
    });
    const runId = recorder.startRun({ sessionId, botId: this.bot.id, requesterId: SCHEDULER_REQUESTER });
    recorder.recordEvent({
      runId,
      sessionId,
      botId: this.bot.id,
      type: 'schedule_trigger',
      label: isManual ? '▶️ 手动触发' : '⏰ 定时触发',
      status: 'received',
      input: { source: opts.source, prompt, cron: opts.cron, targetChannelId: opts.targetChannelId },
    });
    recorder.recordMessage({
      sessionId,
      runId,
      botId: this.bot.id,
      role: 'user',
      content: prompt,
      authorName: isManual ? '手动触发' : '调度器',
    });

    try {
      const experimentalContext: MentionExperimentalContext = {
        push: this.buildPushContext(),
        // 仅当有可发送频道时给 discord 上下文（delegate/mention 需 channel）；无则这些工具本回合不可用，discord_push 仍可用。
        ...(channel
          ? {
              discord: {
                botId: this.bot.id,
                botName: this.bot.name,
                requesterId: SCHEDULER_REQUESTER,
                channel,
                signal: ac.signal,
                runId,
                sessionId,
              },
            }
          : {}),
      };
      const systemPrompt = composeSystemPrompt(this.bot, this.toolRuntime);
      const { text, usage, toolCallCount, finishReason } = await generateAgentReply({
        model: this.model,
        systemPrompt,
        history: [],
        userText: prompt,
        tools: this.toolRuntime.tools,
        temperature: this.bot.temperature,
        experimentalContext,
        abortSignal: ac.signal,
        onToolResult: (r) => {
          if (r.toolName === 'delegate_to_claude') return;
          recorder.recordEvent({
            runId,
            sessionId,
            botId: this.bot.id,
            type: 'tool_call',
            toolName: r.toolName,
            label: localToolLabel(r.toolName),
            status: isToolError(r.output) ? 'error' : 'ok',
            input: shapeToolInput(r.toolName, r.input),
            output: r.output,
          });
        },
      });

      const replyText = text.trim();
      recorder.recordMessage({
        sessionId,
        runId,
        botId: this.bot.id,
        role: 'assistant',
        content: replyText || '（本回合无文本输出）',
      });

      // targetChannelId 直发：把最终回复发到该频道（平台授权，禁 @everyone/@role）。best-effort。
      if (channel && replyText) {
        for (const chunk of chunkText(replyText, 1900)) {
          await channel
            .send({ content: chunk, allowedMentions: { parse: [] } })
            .catch((e) => console.error(`[bot:${this.bot.name}] 合成回合直发失败（已忽略）`, e));
        }
      }

      recorder.endRun(runId, { status: 'ok', finishReason, toolCallCount, usage });
      console.log(`[bot:${this.bot.name}] 合成回合(${opts.source}) -> ${prompt.slice(0, 50)} | tools: ${toolCallCount}`);
      return { status: 'triggered', runId, sessionId };
    } catch (e) {
      if (ac.signal.aborted) {
        recorder.endRun(runId, { status: 'aborted' });
        return { status: 'error', message: '已中止', runId, sessionId };
      }
      recorder.recordEvent({ runId, sessionId, botId: this.bot.id, type: 'error', status: 'error', output: (e as Error).message });
      recorder.endRun(runId, { status: 'error', error: (e as Error).message });
      console.error(`[bot:${this.bot.name}] 合成回合失败`, e);
      return { status: 'error', message: (e as Error).message, runId, sessionId };
    } finally {
      this.active.delete(ac);
    }
  }

  // ============================================================
  // Claude 帖直通（论坛帖子 ↔ 本地 Claude Code session）
  // ============================================================

  /**
   * 分流：判定这条人类消息是不是「Claude 帖」相关（建帖 / 帖内直通 / 帖内重开），是则在此处理并返回 true
   * （handleMessage 据此收口、不落入 DeepSeek 流）；否则返回 false 走原流程。
   */
  private async maybeHandleThread(msg: Message): Promise<boolean> {
    const cfg = this.bot.tools.claudeThread;
    const me = this.client.user;
    const isThread = msg.channel.isThread();
    const isMentioned = me ? msg.mentions.has(me) : false;
    const content = resolveMentionsReadable(msg.content, me?.id, (id) => botManager.resolveBotName(id));
    const binding = isThread ? threadSessionRepo.getByThread(this.bot.id, msg.channel.id) : null;
    const boundActive = !!binding && binding.status === 'active';

    const fork = classifyThreadMessage({
      enabled: cfg.enabled,
      forumChannelId: cfg.forumChannelId,
      triggerKeyword: cfg.triggerKeyword,
      resetKeywords: cfg.resetKeywords,
      isThread,
      isMentioned,
      content,
      boundActive,
    });
    if (fork.kind === 'normal') return false;

    // 访问控制：帖内驱动 / 建帖都用 bot 级 allowedRequesters 白名单（与 normal 路径同口径）。
    // 非白名单：在 Claude 帖里静默吞掉（既不喂 Claude，也不落入 DeepSeek），防公共帖被劫持。
    if (this.bot.allowedRequesters.length > 0 && !this.bot.allowedRequesters.includes(msg.author.id)) {
      return true;
    }

    try {
      if (fork.kind === 'create') {
        await this.handleThreadCreate(msg, fork.prompt);
      } else if (fork.kind === 'passthrough' && binding) {
        if (content.trim()) await this.streamThreadTurn(binding, content, msg.author.id, msg.channel as SendableChannels);
      } else if (fork.kind === 'reset' && binding) {
        await this.handleThreadReset(msg, binding, fork.instruction);
      }
    } catch (e) {
      console.error(`[bot:${this.bot.name}] Claude 帖处理异常（已隔离）`, e);
    }
    return true;
  }

  /** 把一个 thread channel 包成渲染器的输出端（禁 @everyone/@role；大输出走附件）。 */
  private threadTarget(thread: SendableChannels): ThreadStreamTarget {
    return {
      send: async (content) => {
        await thread.send({ content, allowedMentions: { parse: [] } });
      },
      sendFile: async (name, content) => {
        await thread.send({ files: [{ attachment: Buffer.from(content, 'utf8'), name }], allowedMentions: { parse: [] } });
      },
    };
  }

  /**
   * 跑一个直通回合：组装 options（含 resume）→ pumpQuery 把 SDKMessage 流逐条喂给 sink → 返回收尾态。
   * 不发收尾文案（由调用方按 aborted/timedOut/isError 决定贴什么）。canUseTool 可覆盖（reset 总结时传 deny-all）。
   */
  private async runClaudeTurn(args: {
    prompt: string;
    cwd: string;
    resumeSessionId?: string;
    maxTurns: number;
    timeoutMs: number;
    upstream: AbortSignal;
    requesterId: string;
    channel: SendableChannels;
    sink: ClaudeStreamSink;
    canUseTool?: CanUseTool;
    obs?: { runId: string; sessionId: string };
  }): Promise<ClaudeRunResult & { aborted: boolean; timedOut: boolean }> {
    const abort = wireAbort(args.upstream, args.timeoutMs);
    let capturedSession: string | undefined;
    // 包一层捕获 sessionId（pumpQuery 抛错时也能拿到，用于 resume 失效兜底/落库）。
    const wrapSink: ClaudeStreamSink = {
      onInit: (sid) => {
        capturedSession = sid;
        return args.sink.onInit?.(sid);
      },
      onAssistant: (t, tu) => args.sink.onAssistant?.(t, tu),
      onToolResult: (r) => args.sink.onToolResult?.(r),
      onRateLimit: (i, r) => args.sink.onRateLimit?.(i, r),
      onResult: (m) => args.sink.onResult?.(m),
    };
    const handler =
      args.canUseTool ??
      createPermissionHandler({
        botName: this.bot.name,
        requesterId: args.requesterId,
        channel: args.channel,
        signal: abort.ac.signal,
        permissionTimeoutMs: THREAD_PERMISSION_TIMEOUT_MS,
        questionTimeoutMs: THREAD_QUESTION_TIMEOUT_MS,
        observe: args.obs ? { runId: args.obs.runId, sessionId: args.obs.sessionId, botId: this.bot.id } : undefined,
      });
    const options = buildClaudeOptions({
      cwd: args.cwd,
      abortController: abort.ac,
      canUseTool: handler,
      maxTurns: args.maxTurns,
      resumeSessionId: args.resumeSessionId,
      logTag: this.bot.name,
    });
    try {
      const r = await pumpQuery(query({ prompt: args.prompt, options }), wrapSink, { logTag: this.bot.name });
      abort.dispose();
      return {
        ...r,
        sessionId: r.sessionId ?? capturedSession,
        aborted: abort.ac.signal.aborted && !abort.timedOut(),
        timedOut: abort.timedOut(),
      };
    } catch (e) {
      abort.dispose();
      if (!abort.ac.signal.aborted) console.error(`[bot:${this.bot.name}] 直通回合出错`, e);
      return {
        sessionId: capturedSession,
        finalText: '',
        isError: true,
        numTurns: undefined,
        costUsd: undefined,
        rateLimited: false,
        aborted: abort.ac.signal.aborted && !abort.timedOut(),
        timedOut: abort.timedOut(),
      };
    }
  }

  /**
   * 帖内一条用户消息 = 一个直通回合：抢全局槽 + 熔断检查 → resume 该帖 session 跑一回合并逐条贴帖 →
   * resume 失效兜底（重试一次不带 resume）→ 刷新 session_id 落库 + 回灌全局成本 + 贴收尾文案。
   */
  private async streamThreadTurn(
    binding: ThreadSession,
    prompt: string,
    requesterId: string,
    thread: SendableChannels
  ): Promise<void> {
    if (interAgentRouter.isGloballyTripped(Date.now())) {
      await thread.send('⚠️ 今日协作成本已达全局熔断阈值，暂停新的 Claude 回合。稍后再试。').catch(() => {});
      return;
    }
    const acq = tryAcquireThreadSlot();
    if (!acq.ok) {
      await thread.send('⚠️ 当前并发的 Claude 直通回合已达上限，请稍后再发。').catch(() => {});
      return;
    }
    const turnAc = new AbortController();
    this.active.add(turnAc);

    const cfg = this.bot.tools.claudeThread;
    const sessionId = recorder.ensureSession({
      botId: this.bot.id,
      channelId: thread.id,
      channelType: 'thread',
      channelName: 'name' in thread && typeof thread.name === 'string' ? thread.name : undefined,
      title: prompt.slice(0, 80),
    });
    const runId = recorder.startRun({ sessionId, botId: this.bot.id, requesterId });
    recorder.recordMessage({ sessionId, runId, botId: this.bot.id, role: 'user', content: prompt, authorId: requesterId });
    recorder.recordEvent({
      runId,
      sessionId,
      botId: this.bot.id,
      type: 'thread_session_start',
      label: '🧵 Claude 帖回合',
      status: 'running',
      input: { threadId: binding.threadId, resume: !!binding.claudeSessionId, cwd: binding.cwd },
    });

    const sink = new ThreadStreamSink(this.threadTarget(thread));
    try {
      let res = await this.runClaudeTurn({
        prompt,
        cwd: binding.cwd,
        resumeSessionId: binding.claudeSessionId,
        maxTurns: cfg.maxTurns,
        timeoutMs: cfg.timeoutMs,
        upstream: turnAc.signal,
        requesterId,
        channel: thread,
        sink,
        obs: { runId, sessionId },
      });

      // resume 失效兜底：有 resume 且出错（非取消/超时）→ 多半是上次 session 不可续，新开一次。
      if (res.isError && binding.claudeSessionId && !res.aborted && !res.timedOut) {
        sink.notice('↻ 上次会话无法续接，正在新开会话继续…');
        res = await this.runClaudeTurn({
          prompt,
          cwd: binding.cwd,
          resumeSessionId: undefined,
          maxTurns: cfg.maxTurns,
          timeoutMs: cfg.timeoutMs,
          upstream: turnAc.signal,
          requesterId,
          channel: thread,
          sink,
          obs: { runId, sessionId },
        });
      }

      if (res.sessionId) threadSessionRepo.updateSession(binding.threadId, res.sessionId);
      else threadSessionRepo.touch(binding.threadId);
      interAgentRouter.recordGlobalCost(res.costUsd ?? 0, Date.now());

      if (res.timedOut) sink.notice('⚠️ 本回合超时已中止。');
      else if (res.aborted) sink.notice('⏹️ 本回合已取消。');
      else if (res.isError) sink.notice(`⚠️ 本回合未成功完成${res.finalText ? '：' + res.finalText.slice(0, 200) : '。'}`);
      await sink.flush();

      recorder.recordMessage({ sessionId, runId, botId: this.bot.id, role: 'assistant', content: res.finalText || '（无文本输出）' });
      recorder.endRun(runId, { status: res.aborted ? 'aborted' : res.isError ? 'error' : 'ok', toolCallCount: res.numTurns ?? 0 });
    } catch (e) {
      await sink.flush().catch(() => {});
      recorder.endRun(runId, { status: 'error', error: (e as Error).message });
      await thread.send(`❌ 出错：${(e as Error).message}`).catch(() => {});
    } finally {
      this.active.delete(turnAc);
      acq.slot.release();
    }
  }

  /** @bot + 触发词（快捷路径）：解析 cwd（首词可指定项目）后建帖、起首轮。 */
  private async handleThreadCreate(msg: Message, prompt: string): Promise<void> {
    const dirs = (this.toolRuntime?.workspaceDirs ?? []).filter((d) => d.trim());
    if (!dirs.length) {
      await msg.reply('❌ 未配置任何工作目录白名单，无法新建 Claude 帖（请在工具配置里填写工作目录）。').catch(() => {});
      return;
    }
    const picked = pickThreadCwd(prompt, dirs);
    const res = await this.createThreadSession({ cwd: picked.cwd, task: picked.prompt, requesterId: msg.author.id });
    await msg
      .reply({ content: res.ok ? `✅ ${res.message}` : `❌ ${res.message.replace(/^错误：/, '')}`, allowedMentions: { parse: [] } })
      .catch(() => {});
  }

  /**
   * 主脑工具 open_claude_thread 的落地（口语化入口）：校验 → 解析 workdir → 建帖 + 起首轮 → 返回给主脑转告。
   * 与关键词快捷路径共用 createThreadSession。
   */
  async openClaudeThreadFromTool(ctx: DelegationContext, args: { task: string; workdir?: string }): Promise<{ ok: boolean; message: string }> {
    const cfg = this.bot.tools.claudeThread;
    if (!cfg.enabled || !cfg.forumChannelId.trim()) {
      return { ok: false, message: '错误：本 bot 未启用 Claude 帖直通或未配置论坛频道，无法开帖。' };
    }
    const dirs = (this.toolRuntime?.workspaceDirs ?? []).filter((d) => d.trim());
    if (!dirs.length) return { ok: false, message: '错误：未配置任何工作目录白名单，无法开 Claude 帖。' };
    const cwd = resolveWorkdirHint(args.workdir, dirs);
    const res = await this.createThreadSession({ cwd, task: (args.task ?? '').trim(), requesterId: ctx.requesterId });
    if (!res.ok) return res;
    return { ok: true, message: `${res.message}（已在帖子里开始处理，你可以去帖子继续，无需在这里等待。）` };
  }

  /**
   * 建帖核心（关键词快捷路径与主脑工具共用）：校验 cwd/论坛频道/权限/tag → threads.create → 绑定落库 →
   * 有首条任务则在该帖队列 fire 首轮。不自己回链，返回结果串供调用方决定怎么回。
   */
  private async createThreadSession(args: { cwd: string; task: string; requesterId: string }): Promise<{ ok: boolean; threadId?: string; message: string }> {
    const cfg = this.bot.tools.claudeThread;
    const dirs = (this.toolRuntime?.workspaceDirs ?? []).filter((d) => d.trim());
    let safeCwd: string;
    try {
      safeCwd = assertRealpathAllowed(args.cwd, dirs);
    } catch (e) {
      return { ok: false, message: `错误：${(e as Error).message}` };
    }

    const forum = await this.client.channels.fetch(cfg.forumChannelId).catch(() => null);
    if (!forum || forum.type !== ChannelType.GuildForum) {
      return { ok: false, message: '错误：配置的论坛频道无效或不是「论坛(Forum)」类型频道。' };
    }
    const forumCh = forum as ForumChannel;

    // 建帖前置权限校验（best-effort）。
    const me = this.client.user;
    if (me) {
      const perms = forumCh.permissionsFor(me.id);
      const need = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.SendMessagesInThreads];
      if (perms && !need.every((p) => perms.has(p))) {
        return { ok: false, message: '错误：我在该论坛频道缺少建帖权限（需要：查看频道 / 创建公开帖 / 在帖中发言）。' };
      }
    }

    // forum 频道若设了 RequireTag，建帖必须带至少一个 tag，否则 API 报错——自动套用第一个可用 tag。
    let appliedTags: string[] = [];
    try {
      if ((forumCh.flags?.has('RequireTag') ?? false) && forumCh.availableTags.length) appliedTags = [forumCh.availableTags[0]!.id];
    } catch {
      appliedTags = [];
    }

    const title = (args.task || `Claude · ${this.bot.name}`).slice(0, 90);
    let thread: SendableChannels;
    try {
      const created = await forumCh.threads.create({
        name: title,
        message: {
          content:
            `🤖 已为「${this.bot.name}」创建 Claude Code 帖。工作目录：\`${safeCwd}\`。\n` +
            `直接在本帖发消息即可与 Claude 对话（无需 @）；发「${cfg.resetKeywords[0] ?? '/reset'}」可重开会话。`,
        },
        ...(appliedTags.length ? { appliedTags } : {}),
        autoArchiveDuration: 10080,
      });
      thread = created as unknown as SendableChannels;
    } catch (e) {
      return { ok: false, message: `错误：建帖失败：${(e as Error).message}` };
    }

    const binding = threadSessionRepo.create({
      threadId: thread.id,
      botId: this.bot.id,
      forumChannelId: cfg.forumChannelId,
      cwd: safeCwd,
      requesterId: args.requesterId,
      title,
    });

    // 首条任务：在该帖的串行队列里跑首个直通回合，不阻塞发起处。
    const first = args.task.trim();
    if (first) void this.enqueueOnChannel(thread.id, () => this.streamThreadTurn(binding, first, args.requesterId, thread));
    return { ok: true, threadId: thread.id, message: `已开 Claude 帖 👉 <#${thread.id}>` };
  }

  /**
   * 帖内「重开 session」：让旧 Claude 自我总结成交接文档（写进工作目录）→ 以「续接开场白」起一个新 session，
   * 仍在同一帖子；记 reset 链。旧 session 不可续时降级为极简交接，绝不阻断重开。
   */
  private async handleThreadReset(msg: Message, binding: ThreadSession, instruction: string): Promise<void> {
    const cfg = this.bot.tools.claudeThread;
    const thread = msg.channel as SendableChannels;
    if (interAgentRouter.isGloballyTripped(Date.now())) {
      await thread.send('⚠️ 今日协作成本已达熔断阈值，暂不重开会话。').catch(() => {});
      return;
    }
    const acq = tryAcquireThreadSlot();
    if (!acq.ok) {
      await thread.send('⚠️ 当前并发已达上限，请稍后再重开。').catch(() => {});
      return;
    }
    const turnAc = new AbortController();
    this.active.add(turnAc);

    const sink = new ThreadStreamSink(this.threadTarget(thread));
    const sessionId = recorder.ensureSession({
      botId: this.bot.id,
      channelId: thread.id,
      channelType: 'thread',
      channelName: 'name' in thread && typeof thread.name === 'string' ? thread.name : undefined,
      title: `[重开] ${instruction.slice(0, 60)}`,
    });
    const runId = recorder.startRun({ sessionId, botId: this.bot.id, requesterId: msg.author.id });
    try {
      sink.notice('🔄 正在归档上一段会话…');
      await sink.flush();

      // 1) 让旧 Claude 自我总结（deny 所有工具，只要文本）。安静渲染（不刷屏）。
      let handoff = '';
      if (binding.claudeSessionId) {
        const denyAll: CanUseTool = async () => ({ behavior: 'deny', message: '仅需文字总结，无需工具', interrupt: false });
        const quietSink = new ThreadStreamSink(this.threadTarget(thread), { quiet: true });
        const sum = await this.runClaudeTurn({
          prompt: HANDOFF_PROMPT,
          cwd: binding.cwd,
          resumeSessionId: binding.claudeSessionId,
          maxTurns: 4,
          timeoutMs: 5 * 60 * 1000,
          upstream: turnAc.signal,
          requesterId: msg.author.id,
          channel: thread,
          sink: quietSink,
          canUseTool: denyAll,
        });
        handoff = sum.finalText.trim();
      }
      if (!handoff) handoff = `（无法从上一段会话自动总结。）\n用户的续接说明：${instruction || '（无）'}`;

      // 2) 交接文档落盘（在 cwd 内，过 path-guard）。失败不阻断。
      let docPath: string | undefined;
      try {
        docPath = this.writeHandoffDoc(binding, handoff);
      } catch (e) {
        console.error(`[bot:${this.bot.name}] 写交接文档失败（已忽略）`, e);
      }

      // 3) 开场白：交接文档作为新 session 的首个上下文。
      const openingLine =
        '你在续接一个已重置的会话（同一个论坛帖子，但这是一个全新的 Claude session）。\n' +
        (docPath
          ? `上一段会话的交接文档见 \`${docPath}\`（请先读取它了解上下文）。\n`
          : `上一段会话的交接如下：\n\n${handoff}\n\n`) +
        `续接目标：${instruction || '继续之前的工作。'}`;

      // 4) 起新 session（不带 resume）跑开场白，逐条贴帖。
      const newRes = await this.runClaudeTurn({
        prompt: openingLine,
        cwd: binding.cwd,
        resumeSessionId: undefined,
        maxTurns: cfg.maxTurns,
        timeoutMs: cfg.timeoutMs,
        upstream: turnAc.signal,
        requesterId: msg.author.id,
        channel: thread,
        sink,
        obs: { runId, sessionId },
      });
      await sink.flush();

      threadSessionRepo.recordReset({
        threadId: binding.threadId,
        oldSession: binding.claudeSessionId,
        newSession: newRes.sessionId,
        handoffDoc: docPath,
        openingLine,
      });
      interAgentRouter.recordGlobalCost(newRes.costUsd ?? 0, Date.now());
      recorder.recordEvent({
        runId,
        sessionId,
        botId: this.bot.id,
        type: 'thread_reset',
        label: '🔄 重开会话',
        status: newRes.isError ? 'error' : 'ok',
        input: { threadId: binding.threadId, oldSession: binding.claudeSessionId, newSession: newRes.sessionId, handoffDoc: docPath },
      });

      sink.notice(`🔄 已重开会话（第 ${binding.resetCount + 1} 次），上一段已总结交接。`);
      await sink.flush();
      recorder.recordMessage({ sessionId, runId, botId: this.bot.id, role: 'assistant', content: newRes.finalText || '（已重开会话）' });
      recorder.endRun(runId, { status: newRes.isError ? 'error' : 'ok', toolCallCount: newRes.numTurns ?? 0 });
    } catch (e) {
      await sink.flush().catch(() => {});
      recorder.endRun(runId, { status: 'error', error: (e as Error).message });
      await thread.send(`❌ 重开失败：${(e as Error).message}`).catch(() => {});
    } finally {
      this.active.delete(turnAc);
      acq.slot.release();
    }
  }

  /** 把交接文档写到 `<cwd>/.hivemind-threads/<threadId>/gen-<N>-carryover.md`（过 path-guard，在白名单内）。 */
  private writeHandoffDoc(binding: ThreadSession, content: string): string {
    const dir = join(binding.cwd, '.hivemind-threads', binding.threadId);
    const file = join(dir, `gen-${binding.resetCount + 1}-carryover.md`);
    assertWriteTargetAllowed(file, this.toolRuntime?.workspaceDirs ?? []);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, content, 'utf8');
    return file;
  }

  /** 把一个任务挂到某频道的串行队列尾（与该频道普通消息串行），返回任务结果。链尾异常不破坏队列。 */
  private enqueueOnChannel<T>(chanId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.channelQueues.get(chanId) ?? Promise.resolve();
    const run = prev.then(() => task());
    // 队列链保持 Promise<void> 且永不 reject（吞掉），否则后续入队会被前一个失败阻断。
    this.channelQueues.set(
      chanId,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  }
}

function chunkText(s: string, max: number): string[] {
  if (s.length <= max) return [s];
  const parts: string[] = [];
  for (let i = 0; i < s.length; i += max) parts.push(s.slice(i, i + max));
  return parts;
}

// Inter-Agent 暂停后等待发起人「继续/终止」裁决的超时（默认 60 分钟；超时保持暂停）。
const RESUME_TIMEOUT_MS = 60 * 60 * 1000;

/** 暂停原因码 → 给人看的中文说明。 */
function reasonText(state: string): string {
  switch (state) {
    case 'paused_turns': return '转交跳数已达上限';
    case 'paused_budget': return '累计成本已达上限';
    case 'paused_loop': return '检测到来回循环（A→B→A→B）';
    case 'paused_global': return '今日全局协作成本已达熔断阈值';
    default: return '触达协作护栏';
  }
}

// ============================================================
// BotManager（全局单例）
// ============================================================

class BotManager {
  private instances = new Map<string, BotInstance>();
  // 人类发起回合 → 本回合已开的协作任务 id（按 runId）。让同一回合内多次 mention_bot 复用同一条链/预算，
  // 而非每次都新建一条满额度的链（否则一回合最多可炸出 stepCount 条独立链，预算被放大 N 倍）。有界淘汰。
  private rootTaskByRun = new Map<string, string>();

  async start(botId: string): Promise<void> {
    if (this.instances.has(botId)) {
      console.log(`[manager] bot ${botId} 已运行，先停再起`);
      await this.stop(botId);
    }
    const bot = botRepo.get(botId);
    if (!bot) throw new Error(`Bot ${botId} 不存在`);
    const instance = new BotInstance(bot);
    this.instances.set(botId, instance);
    await instance.start();
  }

  async stop(botId: string): Promise<void> {
    const instance = this.instances.get(botId);
    if (!instance) return;
    await instance.stop();
    this.instances.delete(botId);
  }

  async restart(botId: string): Promise<void> {
    await this.stop(botId);
    await this.start(botId);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.instances.keys()].map((id) => this.stop(id)));
  }

  /** 从 DB 加载所有 enabled=true 的 bot，启动尚未运行的 */
  async syncFromDb(): Promise<void> {
    const enabled = botRepo.listEnabled();
    const enabledIds = new Set(enabled.map((b) => b.id));

    // 停掉已不再 enabled 的
    for (const id of [...this.instances.keys()]) {
      if (!enabledIds.has(id)) {
        await this.stop(id).catch((e) => console.error(`[manager] stop ${id} 失败`, e));
      }
    }
    // 启动新 enabled 的
    for (const bot of enabled) {
      if (!this.instances.has(bot.id)) {
        await this.start(bot.id).catch((e) => console.error(`[manager] start ${bot.id} 失败`, e));
      }
    }
  }

  getStatus(botId: string): BotRuntimeInfo {
    const instance = this.instances.get(botId);
    if (!instance) return { botId, status: 'offline' };
    return instance.getStatus();
  }

  /** 按 Discord user id 反查在线同伴 bot（id+配置名）。供把 <@id> 渲染成可读 @名字 / 可观测性归属。 */
  resolveBotByUserId(userId: string): { id: string; name: string } | undefined {
    for (const inst of this.instances.values()) {
      if (inst.userId === userId) return { id: inst.getBot().id, name: inst.getBot().name };
    }
    return undefined;
  }

  /** 按 Discord user id 反查同伴 bot 的配置名（缺省 undefined）。 */
  resolveBotName(userId: string): string | undefined {
    return this.resolveBotByUserId(userId)?.name;
  }

  listStatuses(): BotRuntimeInfo[] {
    const all = botRepo.list();
    return all.map((b) => this.getStatus(b.id));
  }

  // ============================================================
  // Inter-Agent 协作（Phase 3）：mention_bot 工具的转交编排
  // ============================================================

  /**
   * 跨 bot 转交（mention_bot 工具）：校验（同项目/在线/访问/自指/预算/循环/熔断）→ 通过则用调用方身份在频道里
   * 真实 @ 目标并登记 relay（对方 handleMessage 接力），异步即发即走；受阻则暂停 + 通知发起人裁决。
   * 全程不抛：所有失败/暂停都转成给调用方模型看的字符串（仿 delegate 的「错误：」约定）。护栏与开链逻辑由
   * authorizeAndCommitHop 承载（与「正文内联 @」共用）；本方法只负责工具路径的「发独立 @ 消息」。
   */
  /** open_claude_thread 工具回调：路由到发起 bot 实例去建帖 + 起首轮。返回给主脑转告的结果串。 */
  async openClaudeThread(ctx: DelegationContext, args: { task: string; workdir?: string }): Promise<{ ok: boolean; message: string }> {
    const inst = this.instances.get(ctx.botId);
    if (!inst) return { ok: false, message: '错误：发起 bot 已下线，无法开 Claude 帖。' };
    try {
      return await inst.openClaudeThreadFromTool(ctx, args);
    } catch (e) {
      console.error('[manager] openClaudeThread 异常（已隔离）', e);
      return { ok: false, message: '错误：开 Claude 帖时发生内部错误，请稍后重试。' };
    }
  }

  async deliverMention(fromCtx: DelegationContext, args: DeliverMentionArgs): Promise<DeliverMentionResult> {
    try {
      const now = Date.now();
      // 转交内容去掉 @ 后必须有实质内容（否则 B 侧 strip 后为空会被静默丢弃、链白白断掉）。仅工具路径需要——
      // 内联 @ 的「正文」恒非空。
      const cleanMsg = args.message.replace(/<@!?\d+>/g, '').trim();
      if (!cleanMsg)
        return { ok: false, reason: 'context_missing', message: '错误：转交内容为空（去掉 @ 后没有实际内容）。请写清要对方做什么。' };

      const auth = this.authorizeAndCommitHop(fromCtx, args.chain, args.targetName, args.message, now);
      if (!auth.ok) return { ok: false, reason: auth.reason, taskId: auth.taskId, message: auth.message };

      // 通过（hop 已提交）：用调用方身份发独立的 @ 转交消息 → 登记 relay + 回报登记；发送失败回滚该跳。
      const posted = await this.postRelay(auth.task, fromCtx, auth.hop, now);
      if (!posted) {
        interAgentRouter.rollbackHop(auth.task, auth.targetBot.id, now);
        return { ok: false, reason: 'offline', taskId: auth.task.taskId, message: `错误：向「${auth.targetBot.name}」发送转交消息失败（频道不可用？）。` };
      }
      this.recordMentionEvent(fromCtx, auth.task.taskId, 'forwarded', auth.targetBot.id, auth.targetBot.name, auth.hop.message);
      return {
        ok: true,
        taskId: auth.task.taskId,
        message:
          `已把任务转交给「${auth.targetBot.name}」（任务 #${InterAgentRouter.shortId(auth.task.taskId)}）。` +
          (auth.hop.truncated ? '⚠️ 转交内容过长，已截断，建议精简后重发。' : '') +
          'ta 会在本频道接力处理并回复，你无需等待，可以继续做别的或先答复用户已转交。',
      };
    } catch (e) {
      console.error('[manager] deliverMention 异常（已隔离）', e);
      return { ok: false, reason: 'context_missing', message: '错误：转交时发生内部错误，请稍后重试。' };
    }
  }

  /**
   * 转交护栏 + 开链 + **提交跳数**（mention_bot 工具与「正文内联 @」两条路共用，避免逻辑漂移）。成功时 hop 已
   * commit，返回目标/在线身份/hop（调用方负责：登记 relay → 发出携带 <@id> 的消息 → 回填 messageId → 回报登记）。
   * 受阻（预算/循环/熔断）会就地暂停任务 + 异步弹「继续/终止」按钮，返回 blocked=true；其余失败 blocked=false。
   * 同步、不抛（DB 调用为 better-sqlite3 同步）；异常由各调用方的 try/catch 兜成「错误：」字符串。
   */
  private authorizeAndCommitHop(
    fromCtx: DelegationContext,
    chain: MentionChainContext,
    targetName: string,
    message: string,
    now: number
  ):
    | { ok: true; task: MentionTask; targetBot: Bot; targetUserId: string; hop: PendingHop & { truncated: boolean } }
    | { ok: false; blocked: boolean; reason: DeliverMentionResult['reason']; taskId?: string; message: string } {
    const fromInst = this.instances.get(fromCtx.botId);
    if (!fromInst) return { ok: false, blocked: false, reason: 'context_missing', message: '错误：发起 bot 已下线，无法转交。' };

    // 发起方必须属于某个项目（协作范围 = 同项目）；项目预算用于开链
    const callerProjectId = fromInst.getBot().projectId;
    if (!callerProjectId)
      return { ok: false, blocked: false, reason: 'context_missing', message: '错误：你还没有加入任何项目，无法 @ 其他 bot（请把你和同伴 bot 编进同一个项目）。' };
    const project = projectRepo.get(callerProjectId);
    if (!project) return { ok: false, blocked: false, reason: 'context_missing', message: '错误：你所属的项目已不存在。' };

    // 解析任务：接力回合带 taskId；人类回合首次转交后把 taskId 写回，并按 runId 兜底去重，
    // 使同一回合内多次转交复用同一条链/预算，而非每次新建满额度链。
    const existingTaskId = chain.taskId ?? (fromCtx.runId ? this.rootTaskByRun.get(fromCtx.runId) : undefined);
    let task: MentionTask | undefined;
    if (existingTaskId) {
      task = interAgentRouter.getTask(existingTaskId);
      if (!task) return { ok: false, blocked: false, reason: 'task_inactive', message: '错误：协作任务上下文已失效，无法继续转交。' };
      if (task.state !== 'active')
        return { ok: false, blocked: false, reason: 'task_inactive', taskId: task.taskId, message: '错误：这条协作任务已暂停或结束，需发起人在频道里恢复后才能继续转交。' };
    }

    // 按名字解析目标（限定在**同项目**、enabled 的 bot 内）
    const resolved = this.resolveMentionTarget(targetName, callerProjectId);
    if (resolved === 'not_found')
      return { ok: false, blocked: false, reason: 'not_found', taskId: task?.taskId, message: `错误：没找到名为「${targetName}」的 bot（确认名称无误且对方已启用）。` };
    if (resolved === 'not_in_project')
      return { ok: false, blocked: false, reason: 'not_authorized', taskId: task?.taskId, message: `错误：「${targetName}」不在你的项目里，只能 @ 同项目的同伴 bot。` };
    const targetBot = resolved;

    // 自指
    if (targetBot.id === fromCtx.botId)
      return { ok: false, blocked: false, reason: 'self_mention', taskId: task?.taskId, message: '错误：不能 @ 你自己。' };

    // 目标在线 + 访问控制（必须接受这条链的**人类发起人**——接力回合不再校验 msg.author，这里是唯一闸门，防 confused deputy）
    const rootRequester = task?.rootRequesterId ?? chain.root?.rootRequesterId;
    if (!rootRequester) return { ok: false, blocked: false, reason: 'context_missing', message: '错误：协作上下文缺失（内部错误）。' };
    const live = this.targetLiveness(targetBot, rootRequester);
    if (!live.ok)
      return { ok: false, blocked: false, reason: live.reason, taskId: task?.taskId, message: `错误：${live.message}，无法转交。` };
    const targetUserId = live.targetUserId;

    // 校验通过后才惰性开链（人类回合首次转交），避免为不会成功的转交建任务
    if (!task) {
      const root = chain.root;
      if (!root) return { ok: false, blocked: false, reason: 'context_missing', message: '错误：协作上下文缺失（内部错误）。' };
      task = interAgentRouter.createTask({
        rootRequesterId: root.rootRequesterId,
        rootBotId: root.rootBotId,
        channelId: root.channelId,
        maxTurns: project.maxTurnsPerTask,
        maxCostUsd: project.maxCostUsd,
        now,
      });
      // 写回 taskId：chain === experimental_context.mention（同引用），本回合后续转交/委派即可复用同链预算 +
      // 让委派成本计入本任务。再按 runId 兜底（防同步并行多次调用）。
      chain.taskId = task.taskId;
      if (fromCtx.runId) {
        this.rootTaskByRun.set(fromCtx.runId, task.taskId);
        if (this.rootTaskByRun.size > 256) {
          const oldest = this.rootTaskByRun.keys().next().value;
          if (oldest !== undefined) this.rootTaskByRun.delete(oldest);
        }
      }
    }

    // 预算 / 短循环 / 全局熔断检查
    const hop = this.makeHop(fromCtx.botId, fromInst.userId ?? '', targetBot, targetUserId, message);
    const check = interAgentRouter.checkHop(task, targetBot.id, { resumed: false, now });
    if (!check.ok && check.state) {
      interAgentRouter.pauseTask(task, check.state, hop, now);
      this.recordMentionEvent(fromCtx, task.taskId, check.state, targetBot.id, targetBot.name, hop.message);
      // 异步发暂停按钮 + 通知发起人裁决（不阻塞调用方 / 不阻塞 Discord）
      void this.promptResume(task.taskId, fromCtx, check.state).catch((e) =>
        console.error('[manager] promptResume 失败（已忽略）', e)
      );
      return {
        ok: false,
        blocked: true,
        reason: check.state,
        taskId: task.taskId,
        message: `⛔ 与「${targetBot.name}」的协作触达上限（${reasonText(check.state)}），任务 #${InterAgentRouter.shortId(task.taskId)} 已暂停，已请发起人 <@${task.rootRequesterId}> 在频道里决定是否继续或终止。`,
      };
    }

    // 通过：**先提交跳数**（使对方接力时 task.hops 必含自己，消除网关/REST 时序依赖）。relay 登记 + 发送由调用方负责。
    interAgentRouter.commitHop(task, targetBot.id, now);
    return { ok: true, task, targetBot, targetUserId, hop };
  }

  /**
   * Bug2：把回复正文里「@同项目同伴名」的纯文本转成真实 <@id> 提及 + 登记转交 relay，让对方接力处理本协作任务。
   * 每个被 @ 的同伴都过同一套护栏（authorizeAndCommitHop）。返回改写后的正文 + 待回填 messageId 的 relay 列表
   * （调用方发出回复后按消息块回填 + 登记 replyAwait，使对方回报能路由回本 bot）。
   * 名字匹配：精确全名 + （唯一时）'-' 前缀别名。best-effort：异常整体兜住、原文照发；未授权/离线/未找到的 @
   * 保留原文文本、不触发，不打断回复。
   * `excludeBotId`：回报回合传入「刚给我回报的同伴 bot」——其 @ 不转发（防 PM↔worker / A↔B ping-pong），
   * 但 @ 其它同伴（=收到回报后转头派新活，PM 的典型工作流）仍照常转发。非回报回合不传，无排除。
   */
  deliverInlineMentions(
    fromCtx: DelegationContext,
    chain: MentionChainContext,
    text: string,
    now: number,
    excludeBotId?: string
  ): { text: string; pending: InlinePendingRelay[] } {
    const pending: InlinePendingRelay[] = [];
    try {
      const fromInst = this.instances.get(fromCtx.botId);
      const projectId = fromInst?.getBot().projectId;
      if (!fromInst || !projectId) return { text, pending };
      const coBots = botRepo.listByProject(projectId).filter((b) => b.id !== fromCtx.botId && b.enabled);
      const peers = computePeerHandles(coBots);
      if (peers.length === 0) return { text, pending };
      const found = scanPeerMentions(text, peers);
      if (found.size === 0) return { text, pending };
      // 规范名（= scanPeerMentions 输出键）→ botId，供 excludeBotId 在 authorizeAndCommitHop（会 commit 跳数）之前判定排除。
      const nameToId = new Map(coBots.map((b) => [b.name.trim(), b.id]));

      let outText = text;
      const notes: string[] = [];
      for (const [peerName, handles] of found) {
        // 回报回合：跳过「@ 回刚给我回报的同伴」（防 ping-pong），其 @ 保留为原文文本、不转发；其余同伴照常。
        if (excludeBotId && nameToId.get(peerName) === excludeBotId) continue;
        const auth = this.authorizeAndCommitHop(fromCtx, chain, peerName, text, now);
        if (!auth.ok) {
          // 受阻（预算/循环/熔断）：authorizeAndCommitHop 已暂停 + 异步弹按钮，正文追加一句提示；
          // 其余失败（离线/未授权/失活）静默保留原文 @ 文本，不打断回复。
          if (auth.blocked) notes.push(`（⚠️ 对「${peerName}」的转交已触达上限并暂停，已请发起人裁决；其余照常。）`);
          continue;
        }
        // 改写：把命中的 @全名/@别名 全部替换为真实 <@id>（长句柄优先，避免 @别名 命中 @全名 子串）。
        outText = rewriteHandles(outText, handles, `<@${auth.targetUserId}>`);
        // 登记 relay（FIFO，先于发送；调用方发出回复后回填 messageId）。
        const relay = interAgentRouter.registerRelay({
          taskId: auth.task.taskId,
          channelId: fromCtx.channel.id,
          targetBotId: auth.targetBot.id,
          targetUserId: auth.targetUserId,
          fromBotId: fromCtx.botId,
          fromUserId: fromInst.userId ?? '',
          now,
        });
        pending.push({ relayId: relay.relayId, targetUserId: auth.targetUserId, taskId: auth.task.taskId, attached: false });
        this.recordMentionEvent(fromCtx, auth.task.taskId, 'forwarded', auth.targetBot.id, auth.targetBot.name, auth.hop.message);
      }
      if (notes.length) outText = `${outText}\n\n${notes.join('\n')}`;
      return { text: outText, pending };
    } catch (e) {
      console.error('[manager] deliverInlineMentions 异常（已隔离，原文发出）', e);
      return { text, pending };
    }
  }

  /** 组装一跳：把转交正文裁到 Discord 单条上限内（含 @前缀），超出加截断标记并置 truncated。 */
  private makeHop(
    fromBotId: string,
    fromUserId: string,
    targetBot: Bot,
    targetUserId: string,
    message: string
  ): PendingHop & { truncated: boolean } {
    const prefixLen = targetUserId.length + 4; // "<@" + id + "> "
    const room = Math.max(1, 1990 - prefixLen);
    let body = message;
    let truncated = false;
    if (body.length > room) {
      body = body.slice(0, Math.max(1, room - 8)) + '…（已截断）';
      truncated = true;
    }
    return {
      fromBotId,
      fromUserId,
      targetBotId: targetBot.id,
      targetUserId,
      targetName: targetBot.name,
      message: body,
      truncated,
    };
  }

  /** 目标在线性 + 访问控制（接受该人类发起人）联合校验。两条路（首发 / 恢复重投）共用，避免漂移。 */
  private targetLiveness(
    targetBot: Bot,
    rootRequester: string
  ): { ok: true; targetUserId: string } | { ok: false; reason: 'offline' | 'target_denies_requester'; message: string } {
    const inst = this.instances.get(targetBot.id);
    const uid = inst?.userId;
    if (!inst || inst.getStatus().status !== 'online' || !uid)
      return { ok: false, reason: 'offline', message: `「${targetBot.name}」当前不在线` };
    if (targetBot.allowedRequesters.length > 0 && !targetBot.allowedRequesters.includes(rootRequester))
      return { ok: false, reason: 'target_denies_requester', message: `「${targetBot.name}」不接受来自当前发起人的任务` };
    return { ok: true, targetUserId: uid };
  }

  /**
   * 解析 mention_bot 工具的 bot_name → 同项目 enabled 同伴，限定在**与发起方同项目**内；同名取最早创建。
   * bot_name 可为全名 / 岗位 / 「岗位-代号」（与「正文内联 @」同口径，复用 computePeerHandles + resolvePeerByHandle），
   * 大小写不敏感——修复 bot 改短名后模型仍按岗位（@策划/@程序）转交导致 not_found 的问题。
   */
  private resolveMentionTarget(name: string, callerProjectId: string): Bot | 'not_found' | 'not_in_project' {
    const wanted = name.trim().toLowerCase();
    if (!wanted) return 'not_found';
    const enabled = botRepo.listEnabled();
    // 同项目 enabled 同伴，按创建时间排序（同名/歧义时取最早，沿用旧语义）。
    const peers = enabled
      .filter((b) => b.projectId && b.projectId === callerProjectId)
      .sort((a, b) => a.createdAt - b.createdAt);
    const resolvedName = resolvePeerByHandle(name, computePeerHandles(peers.map((b) => ({ name: b.name, role: b.role }))));
    if (resolvedName) {
      const bot = peers.find((b) => b.name === resolvedName);
      if (bot) return bot;
    }
    // 本项目内没命中：若全局存在同名 enabled bot → not_in_project（报错更准确），否则 not_found。
    const existsElsewhere = enabled.some((b) => b.name.trim().toLowerCase() === wanted);
    return existsElsewhere ? 'not_in_project' : 'not_found';
  }

  /** 登记 relay（发送前）→ 用发起 bot 的身份在频道里发 @ 消息 → 回填 messageId。成功 true，发送失败撤销登记返回 false。 */
  private async postRelay(task: MentionTask, fromCtx: DelegationContext, hop: PendingHop, now: number): Promise<boolean> {
    const relay = interAgentRouter.registerRelay({
      taskId: task.taskId,
      channelId: fromCtx.channel.id,
      targetBotId: hop.targetBotId,
      targetUserId: hop.targetUserId,
      fromBotId: hop.fromBotId,
      fromUserId: hop.fromUserId,
      now,
    });
    try {
      const content = `<@${hop.targetUserId}> ${hop.message}`.slice(0, 2000);
      const sent = await fromCtx.channel.send(content);
      interAgentRouter.attachMessageId(relay.relayId, sent.id);
      // 登记「等待接力回报」：对方接力后引用回复这条转交消息时，回报路由回发出转交的 bot（owner = hop.fromBotId）。
      // expectedSenderUserIds 限定为被 @ 的目标，杜绝其它 bot 引用回复误触发回报。
      interAgentRouter.registerReplyAwait({
        taskId: task.taskId,
        ownerBotId: hop.fromBotId,
        channelId: fromCtx.channel.id,
        messageId: sent.id,
        expectedSenderUserIds: [hop.targetUserId],
        now,
      });
      return true;
    } catch (e) {
      interAgentRouter.cancelRelay(relay.relayId);
      console.error(`[manager] 转交消息发送失败 task=#${InterAgentRouter.shortId(task.taskId)}`, e);
      return false;
    }
  }

  /** 记一条 mention 事件（挂在发起方本回合 run 下）。best-effort，runId 缺省则跳过。 */
  private recordMentionEvent(
    fromCtx: DelegationContext,
    taskId: string,
    status: string,
    toBotId: string,
    toBotName: string,
    message: string
  ): void {
    if (!fromCtx.runId) return;
    const forwarded = status === 'forwarded';
    recorder.recordEvent({
      runId: fromCtx.runId,
      sessionId: fromCtx.sessionId ?? '',
      botId: fromCtx.botId,
      type: 'mention',
      toolName: 'mention_bot',
      label: forwarded ? `🤝 转交 @${toBotName}` : `⛔ 转交受阻 @${toBotName}`,
      status,
      input: { taskId, toBotId, toBotName, message },
    });
  }

  /**
   * 任务暂停后，向发起人弹「继续/终止」按钮（fire-and-forget）。继续 → 放行被挡那一跳并重投；终止 → 标记终止。
   * prompt 自身的 AbortController 登记到 task.controllers，使「别处终止本任务」也能立刻收起这个待裁决按钮。
   */
  private async promptResume(
    taskId: string,
    fromCtx: DelegationContext,
    state: NonNullable<CheckResult['state']>
  ): Promise<void> {
    const task = interAgentRouter.getTask(taskId);
    if (!task) return;
    const short = InterAgentRouter.shortId(taskId);
    const promptAc = new AbortController();
    interAgentRouter.addController(taskId, promptAc);
    let decision: Awaited<ReturnType<typeof askResume>>;
    try {
      decision = await askResume({
        channel: fromCtx.channel,
        requesterId: task.rootRequesterId,
        signal: promptAc.signal,
        title: `任务 #${short}：${reasonText(state)}。要继续吗？`,
        detail: `协作路径：${task.hops.join(' → ')}（已用 ${task.budget.turnsUsed}/${task.budget.maxTurns} 跳）`,
        timeoutMs: RESUME_TIMEOUT_MS,
      });
    } finally {
      interAgentRouter.removeController(taskId, promptAc);
    }

    if (decision === 'resume') {
      const t = interAgentRouter.getTask(taskId);
      const pend = t?.pendingResume;
      if (!t || !pend) return;
      // 「继续」只放行预算/循环/熔断，**不**放行权限：恢复前重新校验目标在线 + 当前 allowedRequesters
      //（目标可能在暂停期间被改了访问策略；per-bot 重启不会清掉 router 的全局任务表，故必须实时复核）。
      const freshTarget = botRepo.get(pend.targetBotId);
      if (!freshTarget || !freshTarget.enabled) {
        await sendStatus(fromCtx.channel, `⚠️ 任务 #${short} 无法继续：目标 bot 已不可用。任务保持暂停。`);
        return;
      }
      const live = this.targetLiveness(freshTarget, t.rootRequesterId);
      if (!live.ok) {
        await sendStatus(fromCtx.channel, `⚠️ 任务 #${short} 无法继续：${live.message}。任务保持暂停。`);
        return;
      }
      const projId = this.instances.get(fromCtx.botId)?.getBot().projectId;
      const bumpTurns = (projId ? projectRepo.get(projId)?.maxTurnsPerTask : undefined) ?? 6;
      const hop = interAgentRouter.resumeTask(taskId, bumpTurns, Date.now());
      if (!hop) return;
      // 用实时复核拿到的 userId/name 重建这一跳（防暂停期间对方改名/重连换 user）
      const freshHop: PendingHop = { ...hop, targetUserId: live.targetUserId, targetName: freshTarget.name };
      interAgentRouter.commitHop(t, freshHop.targetBotId, Date.now());
      const posted = await this.postRelay(t, fromCtx, freshHop, Date.now());
      if (posted) {
        this.recordMentionEvent(fromCtx, taskId, 'forwarded', freshHop.targetBotId, freshHop.targetName, freshHop.message);
        await sendStatus(fromCtx.channel, `▶️ 任务 #${short} 已继续，转交给「${freshHop.targetName}」。`);
      } else {
        interAgentRouter.rollbackHop(t, freshHop.targetBotId, Date.now());
        await sendStatus(fromCtx.channel, `⚠️ 任务 #${short} 续投失败（目标频道不可用）。`);
      }
    } else if (decision === 'terminate') {
      interAgentRouter.terminateTask(taskId, Date.now());
      await sendStatus(fromCtx.channel, `⏹️ 任务 #${short} 已终止，相关在跑回合已中止。`);
    }
    // timeout / aborted：保持暂停（askResume 已禁用按钮并提示）。
  }

  /** L3 后台空闲整理：遍历在跑实例，各自整理已空闲且有新内容的会话。best-effort，单实例失败不影响其余。 */
  async consolidateIdleSessions(): Promise<void> {
    const now = Date.now();
    for (const inst of this.instances.values()) {
      try {
        await inst.consolidateIdleSessions(now);
      } catch (e) {
        console.error('[manager] 空闲整理失败（已忽略）', e);
      }
    }
  }

  /**
   * Phase 3.5：手动触发某 bot 跑一回合（Dashboard「手动触发调度 / 测试运行」用）。
   * fire-and-forget：spawn 一次合成回合，过程实时进 recorder（去监控页看结果），立即返回 ack。
   * bot 未在线 → status:'offline'。targetChannelId 有值则结果直发该频道。
   */
  async triggerBot(
    botId: string,
    opts: { prompt: string; targetChannelId?: string }
  ): Promise<ScheduleRunAck> {
    const inst = this.instances.get(botId);
    if (!inst || inst.getStatus().status !== 'online') {
      return { botId, status: 'offline', message: 'bot 未在线，请先在 Bots 页启用并等待上线。' };
    }
    try {
      const res = await inst.runSyntheticTurn(opts.prompt, { source: 'manual', targetChannelId: opts.targetChannelId });
      return { botId, ...res };
    } catch (e) {
      return { botId, status: 'error', message: (e as Error).message };
    }
  }
}

export const botManager = new BotManager();

/**
 * 启动 L3 空闲整理后台 loop：每小时扫一次（不在启动即跑，避免 boot 时对一堆空闲会话齐发 LLM）。
 * 返回停止函数（shutdown 调用）。CONV_CONSOLIDATE_ENABLED=false 时不启动。仿 observ-retention 的 unref/钳制。
 */
export function startConsolidationLoop(): () => void {
  if (!CONSOLIDATE_ENABLED) {
    console.log('[consolidation] CONV_CONSOLIDATE_ENABLED=false，自动整理已关闭');
    return () => {};
  }
  const intervalMs = 60 * 60 * 1000; // 1h
  const timer = setInterval(() => {
    void botManager.consolidateIdleSessions();
  }, intervalMs);
  timer.unref?.(); // 不应阻止进程退出
  console.log(`[consolidation] 空闲整理已启动：空闲 ${CONSOLIDATE_IDLE_HOURS}h 触发，每 1h 扫一次`);
  return () => clearInterval(timer);
}
