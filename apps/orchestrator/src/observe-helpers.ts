// 可观测性纯辅助函数（P2）。从 bot-manager 抽出以便单测、并与 Discord 耦合的管理器分离。
// 仅依赖：discord.js 的 Message 类型（type-only，运行期擦除）+ recorder 的 previewFsWrite。

import type { Message } from 'discord.js';
import { previewFsWrite } from './recorder.js';

/** 从 Discord 消息提取会话元信息（best-effort）。 */
export function sessionMetaFromMessage(msg: Message): {
  channelId: string;
  channelType: string;
  channelName?: string;
  guildId?: string;
} {
  const ch = msg.channel;
  const channelName =
    'name' in ch && typeof (ch as { name?: unknown }).name === 'string'
      ? (ch as { name: string }).name
      : undefined;
  return {
    channelId: ch.id,
    channelType: ch.isDMBased() ? 'dm' : 'guild',
    channelName,
    guildId: msg.guildId ?? undefined,
  };
}

/** 本地工具名 → 给用户看的友好标签（与 delegation.ts 的 Claude 工具标签分属两套命名空间）。 */
export function localToolLabel(name: string): string {
  switch (name) {
    case 'read_file':
    case 'list_dir':
    case 'grep':
      return '🔎 读取/搜索文件';
    case 'write_file':
    case 'edit_file':
      return '✏️ 写入/编辑文件';
    case 'run_command':
      return '🔧 执行命令';
    case 'web_search':
      return '🌐 联网搜索';
    case 'delegate_to_claude':
      return '🤖 委派 Claude Code'; // P3 会补 delegate_start/step/end 细粒度事件
    default:
      if (name.startsWith('memory_')) return '🧠 记忆';
      return `🔧 ${name}`;
  }
}

/** 入参整形：fs 写入类工具的大字段只留 ~2KB 预览，避免把整文件灌进事件库（见方案）。 */
export function shapeToolInput(toolName: string, input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const o = input as Record<string, unknown>;
  if (toolName === 'write_file' && typeof o.content === 'string') {
    return { ...o, content: previewFsWrite(o.content).text };
  }
  if (toolName === 'edit_file') {
    const out: Record<string, unknown> = { ...o };
    if (typeof o.old === 'string') out.old = previewFsWrite(o.old).text;
    if (typeof o.new === 'string') out.new = previewFsWrite(o.new).text;
    return out;
  }
  return input;
}

/** 工具输出是否为错误（本地工具约定以「错误：」开头返回，不抛异常）。 */
export function isToolError(output: unknown): boolean {
  return typeof output === 'string' && output.startsWith('错误：');
}
