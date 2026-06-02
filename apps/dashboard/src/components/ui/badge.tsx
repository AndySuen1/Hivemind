import { cn } from '@/lib/utils';
import {
  BOT_STATUS_COLOR,
  runStatusColor,
  runStatusLabel,
  statusDotColor,
} from '@/lib/observ-ui';
import type { BotRuntimeStatus } from '@hivemind/shared';

type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

const TONE: Record<Tone, string> = {
  neutral: 'bg-bg-subtle text-fg-muted',
  primary: 'bg-primary-soft text-primary-strong',
  success: 'bg-success-soft text-success-fg',
  warning: 'bg-warning-soft text-warning-fg',
  danger: 'bg-danger-soft text-danger-fg',
  info: 'bg-info-soft text-info-fg',
};

export interface BadgeProps {
  tone?: Tone;
  className?: string;
  children: React.ReactNode;
}
export function Badge({ tone = 'neutral', className, children }: BadgeProps) {
  return (
    <span
      className={cn('inline-flex items-center rounded-sm px-2 py-0.5 text-xs font-medium', TONE[tone], className)}
    >
      {children}
    </span>
  );
}

const BOT_STATUS_LABEL: Record<BotRuntimeStatus, string> = {
  online: '在线',
  connecting: '连接中',
  offline: '离线',
  error: '错误',
};

/** 直接消费 observ-ui 的状态色映射（已改语义 token）。 */
export function StatusPill({
  status,
  kind = 'run',
  label,
  className,
}: {
  status: string;
  kind?: 'run' | 'bot';
  label?: string;
  className?: string;
}) {
  const color =
    kind === 'bot'
      ? BOT_STATUS_COLOR[status as BotRuntimeStatus] ?? 'bg-bg-subtle text-fg-muted'
      : runStatusColor(status);
  const text =
    label ?? (kind === 'bot' ? BOT_STATUS_LABEL[status as BotRuntimeStatus] ?? status : runStatusLabel(status));
  return (
    <span className={cn('inline-flex items-center rounded-sm px-2 py-0.5 text-xs font-medium', color, className)}>
      {text}
    </span>
  );
}

export function StatusDot({ status, className }: { status?: string; className?: string }) {
  return <span className={cn('inline-block size-2 rounded-full', statusDotColor(status), className)} />;
}
