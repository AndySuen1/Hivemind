// 可观测性 UI 的纯展示辅助：时间格式、状态/事件配色与图标、值预览。无 JSX。

import type { ObservEventType, ObservRunStatus, BotRuntimeStatus } from '@hivemind/shared';

/** 绝对时间（本地，秒级）。 */
export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/** 时钟（HH:MM:SS），用于时间线行首。 */
export function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

/** 相对时间（粗粒度）。 */
export function fmtAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}小时前`;
  return `${Math.round(h / 24)}天前`;
}

export function fmtDuration(ms?: number): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export const BOT_STATUS_COLOR: Record<BotRuntimeStatus, string> = {
  online: 'bg-green-100 text-green-800',
  connecting: 'bg-amber-100 text-amber-800',
  offline: 'bg-zinc-100 text-zinc-600',
  error: 'bg-red-100 text-red-800',
};

export const RUN_STATUS_COLOR: Record<ObservRunStatus, string> = {
  running: 'bg-blue-100 text-blue-800',
  ok: 'bg-green-100 text-green-800',
  error: 'bg-red-100 text-red-800',
  aborted: 'bg-zinc-200 text-zinc-700',
};

export const RUN_STATUS_LABEL: Record<ObservRunStatus, string> = {
  running: '进行中',
  ok: '完成',
  error: '出错',
  aborted: '已中止',
};

// 带兜底的取值（status 理论上受 DB CHECK 约束，但 SSE/未来新状态可能越界，避免渲染 undefined）。
export function runStatusLabel(s: string): string {
  return RUN_STATUS_LABEL[s as ObservRunStatus] ?? s;
}
export function runStatusColor(s: string): string {
  return RUN_STATUS_COLOR[s as ObservRunStatus] ?? 'bg-zinc-100 text-zinc-600';
}

interface EventMeta {
  icon: string;
  label: string;
  color: string; // tailwind 文本/边框基调
}
export const EVENT_META: Record<ObservEventType, EventMeta> = {
  tool_call: { icon: '🔧', label: '工具调用', color: 'text-zinc-700' },
  delegate_start: { icon: '🤖', label: '委派开始', color: 'text-indigo-700' },
  delegate_step: { icon: '▸', label: '委派步', color: 'text-indigo-600' },
  delegate_end: { icon: '🤖', label: '委派结束', color: 'text-indigo-700' },
  permission_request: { icon: '🔐', label: '权限请求', color: 'text-amber-700' },
  permission_decision: { icon: '🔐', label: '权限裁决', color: 'text-amber-700' },
  ask_question: { icon: '❓', label: '反问', color: 'text-purple-700' },
  error: { icon: '⚠️', label: '错误', color: 'text-red-700' },
  rate_limit: { icon: '⏳', label: '限流', color: 'text-orange-700' },
};

export function eventMeta(type: string): EventMeta {
  return EVENT_META[type as ObservEventType] ?? { icon: '•', label: type, color: 'text-zinc-700' };
}

/** 把任意值（已是脱敏/截断后的）转成简短可读字符串供 UI 预览。 */
export function preview(v: unknown, max = 2000): string {
  if (v == null) return '';
  let s: string;
  if (typeof v === 'string') s = v;
  else {
    try {
      s = JSON.stringify(v, null, 2);
    } catch {
      s = String(v);
    }
  }
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function statusDotColor(status?: string): string {
  switch (status) {
    case 'ok':
    case 'allow':
    case 'answered':
      return 'bg-green-500';
    case 'error':
    case 'deny':
      return 'bg-red-500';
    case 'running':
    case 'pending':
      return 'bg-blue-500';
    case 'timeout':
    case 'aborted':
      return 'bg-zinc-400';
    default:
      return 'bg-zinc-300';
  }
}
