import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ChipTone = 'violet' | 'blue' | 'green' | 'amber' | 'red' | 'gray';

const TONE: Record<ChipTone, string> = {
  violet: 'bg-primary-soft text-primary',
  blue: 'bg-info-soft text-info-fg',
  green: 'bg-success-soft text-success-fg',
  amber: 'bg-warning-soft text-warning-fg',
  red: 'bg-danger-soft text-danger-fg',
  gray: 'bg-bg-hover text-fg-muted',
};

/** 软色圆角图标块（参考图统计卡/快捷操作的彩色图标）。 */
export function IconChip({
  icon: Icon,
  tone = 'violet',
  className,
}: {
  icon: LucideIcon;
  tone?: ChipTone;
  className?: string;
}) {
  return (
    <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', TONE[tone], className)}>
      <Icon className="size-[18px]" strokeWidth={2} />
    </span>
  );
}
