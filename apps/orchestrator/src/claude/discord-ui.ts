// Discord 交互组件封装：委派 Claude 期间用来发状态、弹「同意/拒绝」按钮、弹澄清问题 select 菜单。
//
// 三条铁律：
// 1) 只接受**原 requester** 的点击（按 user id 过滤），杜绝旁人替你点同意。
// 2) 每个等待都有**超时**与**外部 abort**（bot 停机/委派超时）双重退出，绝不无限挂起。
// 3) 拿到结果后**禁用组件**，且在 finally 里停掉 collector + 移除 abort 监听器，杜绝孤儿 collector / listener 泄漏。

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type Message,
  type MessageComponentInteraction,
  type SendableChannels,
  type StringSelectMenuInteraction,
} from 'discord.js';

const DISCORD_MAX_CONTENT = 1900; // 留余量给前缀，Discord 硬上限 2000
const OPT_LABEL_MAX = 100;
const OPT_DESC_MAX = 100;

function clamp(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/** 发一条状态/请求消息，返回可后续编辑的 Message。 */
export async function sendStatus(channel: SendableChannels, content: string): Promise<Message> {
  return channel.send(clamp(content, DISCORD_MAX_CONTENT));
}

/** 编辑一条已发消息；失败（被删等）只记日志不抛，避免拖垮委派流程。 */
export async function editStatus(msg: Message, content: string): Promise<void> {
  try {
    await msg.edit(clamp(content, DISCORD_MAX_CONTENT));
  } catch (e) {
    console.warn('[discord-ui] editStatus 失败（忽略）：', (e as Error).message);
  }
}

type CollectOutcome =
  | { kind: 'collected'; interaction: MessageComponentInteraction }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

/**
 * 等 msg 上的一个组件交互（只收原 requester、只收一个）。手动管理 collector 生命周期：
 * - 超时由 collector 自带 time 触发；
 * - 外部 abort 时主动 collector.stop('aborted')；
 * - finally 里移除 abort 监听器并确保 collector 已停（无孤儿 collector / listener 泄漏）。
 * 该 msg 上只挂一种组件，故不限定 componentType。
 */
async function awaitOneComponent(
  msg: Message,
  requesterId: string,
  signal: AbortSignal,
  timeoutMs: number
): Promise<CollectOutcome> {
  if (signal.aborted) return { kind: 'aborted' };

  const collector = msg.createMessageComponentCollector({
    filter: (i) => i.user.id === requesterId,
    time: timeoutMs,
    max: 1,
  });

  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<CollectOutcome>((resolve) => {
      collector.on('collect', (i) => resolve({ kind: 'collected', interaction: i }));
      collector.on('end', (collected) => {
        // 若已 collect，上面已 resolve（Promise 只认首次）；这里收尾超时 / abort
        if (collected.size > 0) {
          const first = collected.first();
          if (first) resolve({ kind: 'collected', interaction: first });
          else resolve({ kind: 'timeout' });
        } else {
          resolve(signal.aborted ? { kind: 'aborted' } : { kind: 'timeout' });
        }
      });
      onAbort = (): void => collector.stop('aborted');
      signal.addEventListener('abort', onAbort, { once: true });
    });
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (!collector.ended) collector.stop();
  }
}

export type PermissionDecision = 'allow' | 'deny' | 'timeout' | 'aborted';

/** 弹「✅ 同意 / ❌ 拒绝」按钮，等原 requester 决定。超时/abort 都有兜底。 */
export async function askPermission(params: {
  channel: SendableChannels;
  requesterId: string;
  signal: AbortSignal;
  title: string;
  detail?: string;
  timeoutMs: number;
}): Promise<PermissionDecision> {
  const { channel, requesterId, signal, title, detail, timeoutMs } = params;
  const minutes = Math.round(timeoutMs / 60000);
  const body =
    `🔐 **需要你的批准**\n${title}` +
    (detail ? `\n\`\`\`\n${clamp(detail, 1500)}\n\`\`\`` : '') +
    `\n（${minutes} 分钟内未响应将默认拒绝）`;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('perm_allow').setLabel('同意').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId('perm_deny').setLabel('拒绝').setStyle(ButtonStyle.Danger).setEmoji('❌')
  );

  const msg = await channel.send({ content: clamp(body, DISCORD_MAX_CONTENT), components: [row] });

  const outcome = await awaitOneComponent(msg, requesterId, signal, timeoutMs);
  if (outcome.kind === 'aborted') {
    await disable(msg, '⏹️ 已中止（任务被取消）');
    return 'aborted';
  }
  if (outcome.kind === 'timeout') {
    await disable(msg, '⌛ 超时未响应，已默认**拒绝**');
    return 'timeout';
  }
  const interaction = outcome.interaction as ButtonInteraction;
  const allowed = interaction.customId === 'perm_allow';
  try {
    await interaction.update({
      content: allowed ? '✅ 你已**同意**该操作' : '❌ 你已**拒绝**该操作',
      components: [],
    });
  } catch (e) {
    console.warn('[discord-ui] 更新权限交互失败（忽略）：', (e as Error).message);
  }
  return allowed ? 'allow' : 'deny';
}

export type ResumeDecision = 'resume' | 'terminate' | 'timeout' | 'aborted';

/**
 * Inter-Agent 任务暂停时弹「▶️ 继续 / ⏹️ 终止」按钮，等**发起人**裁决。超时/abort 都有兜底（默认保持暂停）。
 * 复用 askPermission 同款 collector 生命周期管理（只收 requesterId、单次、超时与 abort 双退出、收尾禁用组件）。
 */
export async function askResume(params: {
  channel: SendableChannels;
  requesterId: string;
  signal: AbortSignal;
  title: string;
  detail?: string;
  timeoutMs: number;
}): Promise<ResumeDecision> {
  const { channel, requesterId, signal, title, detail, timeoutMs } = params;
  const minutes = Math.round(timeoutMs / 60000);
  const body =
    `⏸️ **协作任务已暂停**\n${title}` +
    (detail ? `\n\`\`\`\n${clamp(detail, 1500)}\n\`\`\`` : '') +
    `\n（${minutes} 分钟内未响应将保持暂停）`;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('mention_resume').setLabel('继续').setStyle(ButtonStyle.Success).setEmoji('▶️'),
    new ButtonBuilder().setCustomId('mention_terminate').setLabel('终止').setStyle(ButtonStyle.Danger).setEmoji('⏹️')
  );

  const msg = await channel.send({ content: clamp(body, DISCORD_MAX_CONTENT), components: [row] });

  const outcome = await awaitOneComponent(msg, requesterId, signal, timeoutMs);
  if (outcome.kind === 'aborted') {
    await disable(msg, '⏹️ 任务已终止');
    return 'aborted';
  }
  if (outcome.kind === 'timeout') {
    await disable(msg, '⌛ 超时未响应，任务保持暂停');
    return 'timeout';
  }
  const interaction = outcome.interaction as ButtonInteraction;
  const resume = interaction.customId === 'mention_resume';
  try {
    await interaction.update({
      content: resume ? '▶️ 已选择**继续**该协作任务' : '⏹️ 已选择**终止**该协作任务',
      components: [],
    });
  } catch (e) {
    console.warn('[discord-ui] 更新恢复交互失败（忽略）：', (e as Error).message);
  }
  return resume ? 'resume' : 'terminate';
}

/**
 * 弹一个 select 菜单收集单/多选答案。返回选中的 label 数组；超时/abort/无可选项返回 null。
 */
export async function askChoice(params: {
  channel: SendableChannels;
  requesterId: string;
  signal: AbortSignal;
  prompt: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
  timeoutMs: number;
}): Promise<string[] | null> {
  const { channel, requesterId, signal, prompt, options, multiSelect, timeoutMs } = params;
  const opts = options.filter((o) => o.label.trim()).slice(0, 25);
  if (opts.length === 0) return null; // 无可选项无法渲染菜单，交回上层按超时处理
  const minutes = Math.round(timeoutMs / 60000);

  const menu = new StringSelectMenuBuilder()
    .setCustomId('ask_choice')
    .setPlaceholder(multiSelect ? '可多选…' : '选一个…')
    .setMinValues(1)
    .setMaxValues(multiSelect ? Math.max(1, opts.length) : 1)
    .addOptions(
      opts.map((o, idx) => ({
        // value 用下标，避免 label 含特殊字符 / 超长导致映射失败
        label: clamp(o.label, OPT_LABEL_MAX),
        value: String(idx),
        ...(o.description ? { description: clamp(o.description, OPT_DESC_MAX) } : {}),
      }))
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  const body = `❓ **Claude 想问你**\n${prompt}\n（${minutes} 分钟内未选将放弃本次提问）`;
  const msg = await channel.send({ content: clamp(body, DISCORD_MAX_CONTENT), components: [row] });

  const outcome = await awaitOneComponent(msg, requesterId, signal, timeoutMs);
  if (outcome.kind === 'aborted') {
    await disable(msg, '⏹️ 已中止（任务被取消）');
    return null;
  }
  if (outcome.kind === 'timeout') {
    await disable(msg, '⌛ 超时未选择');
    return null;
  }
  const interaction = outcome.interaction as StringSelectMenuInteraction;
  const chosen = interaction.values
    .map((v) => opts[Number(v)]?.label)
    .filter((l): l is string => typeof l === 'string');
  try {
    await interaction.update({ content: `✅ 你选了：${chosen.join('、') || '(空)'}`, components: [] });
  } catch (e) {
    console.warn('[discord-ui] 更新选择交互失败（忽略）：', (e as Error).message);
  }
  return chosen;
}

/** 禁用消息上的组件并改文案（best-effort）。 */
async function disable(msg: Message, content: string): Promise<void> {
  try {
    await msg.edit({ content: clamp(content, DISCORD_MAX_CONTENT), components: [] });
  } catch {
    /* 消息可能已被删，忽略 */
  }
}
