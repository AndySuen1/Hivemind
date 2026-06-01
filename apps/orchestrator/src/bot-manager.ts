import { Client, GatewayIntentBits, Partials, type Message } from 'discord.js';
import type { LanguageModel, ModelMessage } from 'ai';
import type { Bot, BotRuntimeInfo } from '@discord-agent-hub/shared';
import { botRepo, providerRepo } from './repos.js';
import { createLlmModel, generateAgentReply } from './llm.js';
import { buildBotToolRuntime, composeSystemPrompt, type BotToolRuntime } from './tools/index.js';
import type { DelegateExperimentalContext } from './tools/delegate.js';
import { recorder } from './recorder.js';
import { sessionMetaFromMessage, localToolLabel, shapeToolInput, isToolError } from './observe-helpers.js';

const MAX_HISTORY_TURNS = 10;

class BotInstance {
  private client: Client;
  private model: LanguageModel | null = null;
  private toolRuntime: BotToolRuntime | null = null;
  private history = new Map<string, ModelMessage[]>();
  // 在跑的消息处理的 AbortController 集合：bot 停机时全部 abort，中止在跑的 Claude 委派
  private active = new Set<AbortController>();
  public status: BotRuntimeInfo['status'] = 'offline';
  public errorMessage?: string;
  public connectedAt?: number;

  constructor(private bot: Bot) {
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

    this.client.on('messageCreate', (msg) => this.handleMessage(msg));
  }

  async start(): Promise<void> {
    this.status = 'connecting';
    try {
      const token = await botRepo.getDiscordToken(this.bot.id);
      if (!token) throw new Error('Discord token 未配置');

      const provider = providerRepo.get(this.bot.providerId);
      if (!provider) throw new Error(`Provider ${this.bot.providerId} 不存在`);

      this.model = await createLlmModel(provider, provider.model);
      this.toolRuntime = buildBotToolRuntime(this.bot);
      const toolNames = Object.keys(this.toolRuntime.tools);
      if (toolNames.length) console.log(`[bot:${this.bot.name}] 工具：${toolNames.join(', ')}`);

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
    if (msg.author.bot) return;
    if (!this.model || !this.toolRuntime) return;

    const me = this.client.user;
    const isDM = msg.channel.isDMBased();
    const isMentioned = me ? msg.mentions.has(me) : false;
    if (!isDM && !isMentioned) return;

    if (this.bot.allowedRequesters.length > 0 && !this.bot.allowedRequesters.includes(msg.author.id)) {
      console.log(`[bot:${this.bot.name}] 忽略非白名单 ${msg.author.tag} (${msg.author.id})`);
      return;
    }

    const userText = msg.content.replace(/<@!?\d+>/g, '').trim();
    if (!userText) return;

    const chanId = msg.channel.id;
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
    const runId = recorder.startRun({ sessionId, botId: this.bot.id, requesterId: msg.author.id });
    recorder.recordMessage({
      sessionId,
      runId,
      botId: this.bot.id,
      role: 'user',
      content: userText,
      authorId: msg.author.id,
      authorName: msg.author.username,
    });

    // 频道可发送时，构造委派用的 Discord 上下文（delegate_to_claude 经 experimental_context 取用）
    const channel = msg.channel;
    const experimentalContext: DelegateExperimentalContext | undefined = channel.isSendable()
      ? {
          discord: {
            botId: this.bot.id,
            botName: this.bot.name,
            requesterId: msg.author.id,
            channel,
            signal: ac.signal,
            // 串联可观测性：委派内的 delegate_*/权限/反问事件挂在本回合 run 下
            runId,
            sessionId,
          },
        }
      : undefined;

    try {
      if ('sendTyping' in msg.channel && typeof msg.channel.sendTyping === 'function') {
        await msg.channel.sendTyping();
      }
      const systemPrompt = composeSystemPrompt(this.bot, this.toolRuntime);
      const { text, usage, toolCallCount, finishReason } = await generateAgentReply({
        model: this.model,
        systemPrompt,
        history: prev,
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
      this.history.set(chanId, newHistory.slice(-MAX_HISTORY_TURNS * 2));

      // 记 assistant 消息（生成即记，无论 Discord 投递是否成功）
      recorder.recordMessage({ sessionId, runId, botId: this.bot.id, role: 'assistant', content: replyText });

      for (const chunk of chunkText(replyText, 1900)) {
        await msg.reply(chunk);
      }

      // 收尾回合（投递成功后）。finishReason 记录是否因步数/长度截断。
      recorder.endRun(runId, { status: 'ok', finishReason, toolCallCount, usage });

      console.log(
        `[bot:${this.bot.name}] ${msg.author.tag} -> ${userText.slice(0, 60)}${userText.length > 60 ? '…' : ''} | tools: ${toolCallCount} | usage: ${JSON.stringify(usage)}`
      );
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
}

function chunkText(s: string, max: number): string[] {
  if (s.length <= max) return [s];
  const parts: string[] = [];
  for (let i = 0; i < s.length; i += max) parts.push(s.slice(i, i + max));
  return parts;
}

// ============================================================
// BotManager（全局单例）
// ============================================================

class BotManager {
  private instances = new Map<string, BotInstance>();

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
}

export const botManager = new BotManager();
