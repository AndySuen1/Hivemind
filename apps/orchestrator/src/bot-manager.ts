import { Client, GatewayIntentBits, Partials, type Message } from 'discord.js';
import type { LanguageModel, ModelMessage } from 'ai';
import type { Bot, BotRuntimeInfo } from '@hivemind/shared';
import { botRepo, providerRepo } from './repos.js';
import { createLlmModel, generateAgentReply } from './llm.js';
import { buildBotToolRuntime, composeSystemPrompt, type BotToolRuntime, type PromptExtras } from './tools/index.js';
import type { DelegationContext } from './claude/delegation.js';
import type { MentionExperimentalContext } from './tools/mention-bot.js';
import { interAgentRouter, InterAgentRouter, type CheckResult } from './inter-agent/router.js';
import type { DeliverMentionArgs, DeliverMentionResult, MentionChainContext, MentionTask, PendingHop } from './inter-agent/types.js';
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
      // 注入跨 bot 转交函数（mention_bot 工具用）：绑到全局 manager，能够到达其它 bot 实例。
      this.toolRuntime = buildBotToolRuntime(this.bot, (ctx, args) => botManager.deliverMention(ctx, args));
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

      await this.client.login(token);
    } catch (e) {
      this.status = 'error';
      this.errorMessage = (e as Error).message;
      console.error(`[bot:${this.bot.name}] 启动失败`, e);
      throw e;
    }
  }

  async stop(): Promise<void> {
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

    // 本回合的协作链上下文：人类回合 = undefined（首次调 mention_bot 才惰性开链）；接力回合 = { taskId }。
    let relayChain: MentionChainContext | undefined;
    // 访问控制 / 可观测性归属的「发起人」：人类回合 = 消息作者；接力回合 = 链的人类发起人。
    let requesterId = msg.author.id;

    if (msg.author.bot) {
      // 「真实 @mention 转发」下，每个 bot 都会看到 A 发的 @ 消息。只接力「我方 Inter-Agent Router 登记过的
      // 合法转交」——consumeRelay 命中才处理；其余 bot/webhook 闲聊一律在此丢弃，杜绝全队循环。
      const relay = interAgentRouter.consumeRelay({
        messageId: msg.id,
        channelId: msg.channel.id,
        targetBotId: this.bot.id,
        authorId: msg.author.id,
        now: Date.now(),
      });
      if (!relay) return;
      const task = interAgentRouter.getTask(relay.taskId);
      if (!task || task.state === 'terminated') return; // 任务已被发起人终止，不再接力
      relayChain = { taskId: task.taskId };
      requesterId = task.rootRequesterId;
    } else {
      const isDM = msg.channel.isDMBased();
      const isMentioned = me ? msg.mentions.has(me) : false;
      if (!isDM && !isMentioned) return;

      if (this.bot.allowedRequesters.length > 0 && !this.bot.allowedRequesters.includes(msg.author.id)) {
        console.log(`[bot:${this.bot.name}] 忽略非白名单 ${msg.author.tag} (${msg.author.id})`);
        return;
      }
    }

    const userText = msg.content.replace(/<@!?\d+>/g, '').trim();
    if (!userText) return;

    await this.processTurn(msg, userText, requesterId, relayChain);
  }

  /**
   * 处理一回合（人类消息或跨 bot 转交接力共用）：L1 复原 → 开会话/回合 → 组装 prompt（含协作链上下文）→
   * 跑工具循环 → 回复 → 收尾 → L3 触发。relayChain 非空表示这是接力回合（按发起人做归属、回复不再 @ 转发者）。
   */
  private async processTurn(
    msg: Message,
    userText: string,
    requesterId: string,
    relayChain: MentionChainContext | undefined
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
        label: '🤝 收到转交',
        status: 'received',
        input: {
          taskId: relayChain.taskId,
          fromBotId: hops.length >= 2 ? hops[hops.length - 2] : undefined,
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
        }
      : undefined;

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

      // 记 assistant 消息（生成即记，无论 Discord 投递是否成功）
      recorder.recordMessage({ sessionId, runId, botId: this.bot.id, role: 'assistant', content: replyText });

      // 接力回合回复对方的转交消息，但不再 @ 回转发它的 bot（避免互相 ping 噪声 / 误触发）。
      for (const chunk of chunkText(replyText, 1900)) {
        await msg.reply(relayChain ? { content: chunk, allowedMentions: { repliedUser: false } } : chunk);
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

  listStatuses(): BotRuntimeInfo[] {
    const all = botRepo.list();
    return all.map((b) => this.getStatus(b.id));
  }

  // ============================================================
  // Inter-Agent 协作（Phase 3）：mention_bot 工具的转交编排
  // ============================================================

  /**
   * 跨 bot 转交：A 的 mention_bot 调用 → 校验（白名单/在线/访问/自指/预算/循环/熔断）→ 通过则用 A 的身份
   * 在频道里真实 @ 目标并登记 relay（对方的 handleMessage 接力），异步即发即走；受阻则暂停 + 通知发起人裁决。
   * 全程不抛：所有失败/暂停都转成给调用方模型看的字符串（仿 delegate 的「错误：」约定）。
   */
  async deliverMention(fromCtx: DelegationContext, args: DeliverMentionArgs): Promise<DeliverMentionResult> {
    // 全程不抛：DB 查询（resolveMentionTarget→botRepo.listEnabled）等可能 throw，整体兜成「错误：」字符串，
    // 与 delegate / recorder 的 never-throw 纪律一致（AI-SDK 虽有 tool-error 兜底，但要回可读中文提示）。
    try {
      const now = Date.now();
      const fromInst = this.instances.get(fromCtx.botId);
      if (!fromInst) return { ok: false, reason: 'context_missing', message: '错误：发起 bot 已下线，无法转交。' };
      const cfg = fromInst.getBot().tools.mentionBot;

      // 0) 转交内容去掉 @ 后必须有实质内容（否则 B 侧 strip 后为空会被静默丢弃、链白白断掉）
      const cleanMsg = args.message.replace(/<@!?\d+>/g, '').trim();
      if (!cleanMsg)
        return { ok: false, reason: 'context_missing', message: '错误：转交内容为空（去掉 @ 后没有实际内容）。请写清要对方做什么。' };

      // 1) 解析任务：接力回合带 taskId；人类回合首次转交后把 taskId 写回（见下），并按 runId 兜底去重，
      //    使同一回合内多次 mention_bot 复用同一条链/预算，而非每次新建满额度链。
      const existingTaskId = args.chain.taskId ?? (fromCtx.runId ? this.rootTaskByRun.get(fromCtx.runId) : undefined);
      let task: MentionTask | undefined;
      if (existingTaskId) {
        task = interAgentRouter.getTask(existingTaskId);
        if (!task) return { ok: false, reason: 'task_inactive', message: '错误：协作任务上下文已失效，无法继续转交。' };
        if (task.state !== 'active')
          return { ok: false, reason: 'task_inactive', taskId: task.taskId, message: '错误：这条协作任务已暂停或结束，需发起人在频道里恢复后才能继续转交。' };
      }

      // 2) 按名字解析目标（限定在 caller 的 canMention 白名单内、enabled）
      const resolved = this.resolveMentionTarget(args.targetName, cfg.canMention);
      if (resolved === 'not_found')
        return { ok: false, reason: 'not_found', taskId: task?.taskId, message: `错误：没找到名为「${args.targetName}」的可协作 bot（确认名称无误、对方在你的协作授权名单内且已启用）。` };
      if (resolved === 'not_authorized')
        return { ok: false, reason: 'not_authorized', taskId: task?.taskId, message: `错误：你没有被授权 @「${args.targetName}」协作。` };
      const targetBot = resolved;

      // 3) 自指
      if (targetBot.id === fromCtx.botId)
        return { ok: false, reason: 'self_mention', taskId: task?.taskId, message: '错误：不能 @ 你自己。' };

      // 4+5) 目标在线 + 访问控制（必须接受这条链的**人类发起人**——接力回合 B 不再校验 msg.author，
      //      这里是唯一闸门，防「confused deputy」）。
      const rootRequester = task?.rootRequesterId ?? args.chain.root?.rootRequesterId;
      if (!rootRequester) return { ok: false, reason: 'context_missing', message: '错误：协作上下文缺失（内部错误）。' };
      const live = this.targetLiveness(targetBot, rootRequester);
      if (!live.ok)
        return { ok: false, reason: live.reason, taskId: task?.taskId, message: `错误：${live.message}，无法转交。` };
      const targetUserId = live.targetUserId;

      // 校验通过后才惰性开链（人类回合首次转交），避免为不会成功的转交建任务
      if (!task) {
        const root = args.chain.root;
        if (!root) return { ok: false, reason: 'context_missing', message: '错误：协作上下文缺失（内部错误）。' };
        task = interAgentRouter.createTask({
          rootRequesterId: root.rootRequesterId,
          rootBotId: root.rootBotId,
          channelId: root.channelId,
          maxTurns: cfg.maxTurnsPerTask,
          maxCostUsd: cfg.maxCostUsd,
          now,
        });
        // 写回 taskId：args.chain === experimental_context.mention（同引用），本回合后续 mention_bot/delegate
        // 即可读到 taskId，复用同一条链预算 + 让委派成本计入本任务。再按 runId 兜底（防同步并行多次调用）。
        args.chain.taskId = task.taskId;
        if (fromCtx.runId) {
          this.rootTaskByRun.set(fromCtx.runId, task.taskId);
          if (this.rootTaskByRun.size > 256) {
            const oldest = this.rootTaskByRun.keys().next().value;
            if (oldest !== undefined) this.rootTaskByRun.delete(oldest);
          }
        }
      }

      // 6) 预算 / 短循环 / 全局熔断检查
      const hop = this.makeHop(fromCtx.botId, fromInst.userId ?? '', targetBot, targetUserId, args.message);
      const check = interAgentRouter.checkHop(task, targetBot.id, { resumed: false, now });
      if (!check.ok && check.state) {
        interAgentRouter.pauseTask(task, check.state, hop, now);
        this.recordMentionEvent(fromCtx, task.taskId, check.state, targetBot.id, targetBot.name, hop.message);
        // 异步发暂停按钮 + 通知发起人裁决（不阻塞 A 的工具调用 / 不阻塞 Discord）
        void this.promptResume(task.taskId, fromCtx, check.state).catch((e) =>
          console.error('[manager] promptResume 失败（已忽略）', e)
        );
        return {
          ok: false,
          reason: check.state,
          taskId: task.taskId,
          message: `⛔ 与「${targetBot.name}」的协作触达上限（${reasonText(check.state)}），任务 #${InterAgentRouter.shortId(task.taskId)} 已暂停，已请发起人 <@${task.rootRequesterId}> 在频道里决定是否继续或终止。`,
        };
      }

      // 7) 通过：**先提交跳数**（使对方接力时 task.hops 必含自己，消除网关/REST 时序依赖）→ 登记+发 @ 消息 →
      //    记 forwarded；发送失败回滚该跳。
      interAgentRouter.commitHop(task, targetBot.id, now);
      const posted = await this.postRelay(task, fromCtx, hop, now);
      if (!posted) {
        interAgentRouter.rollbackHop(task, targetBot.id, now);
        return { ok: false, reason: 'offline', taskId: task.taskId, message: `错误：向「${targetBot.name}」发送转交消息失败（频道不可用？）。` };
      }
      this.recordMentionEvent(fromCtx, task.taskId, 'forwarded', targetBot.id, targetBot.name, hop.message);
      return {
        ok: true,
        taskId: task.taskId,
        message:
          `已把任务转交给「${targetBot.name}」（任务 #${InterAgentRouter.shortId(task.taskId)}）。` +
          (hop.truncated ? '⚠️ 转交内容过长，已截断，建议精简后重发。' : '') +
          'ta 会在本频道接力处理并回复，你无需等待，可以继续做别的或先答复用户已转交。',
      };
    } catch (e) {
      console.error('[manager] deliverMention 异常（已隔离）', e);
      return { ok: false, reason: 'context_missing', message: '错误：转交时发生内部错误，请稍后重试。' };
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

  /** 按名字（大小写不敏感）在 enabled bot 中解析目标，限定在 caller 的 canMention 白名单内；同名取最早创建。 */
  private resolveMentionTarget(name: string, canMention: string[]): Bot | 'not_found' | 'not_authorized' {
    const wanted = name.trim().toLowerCase();
    const matches = botRepo.listEnabled().filter((b) => b.name.trim().toLowerCase() === wanted);
    if (matches.length === 0) return 'not_found';
    matches.sort((a, b) => a.createdAt - b.createdAt);
    const allowed = matches.filter((b) => canMention.includes(b.id));
    if (allowed.length === 0) return 'not_authorized';
    return allowed[0]!;
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
      const bumpTurns = this.instances.get(fromCtx.botId)?.getBot().tools.mentionBot.maxTurnsPerTask ?? 6;
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
