import type { LucideIcon } from 'lucide-react';
import { Card } from './card';
import { IconChip, type ChipTone } from './icon-chip';
import { Sparkline } from './sparkline';
import { cn } from '@/lib/utils';

export interface StatCardProps {
  label: React.ReactNode;
  value: React.ReactNode;
  icon: LucideIcon;
  tone?: ChipTone;
  /** 底部小字（如「运行中 18」或「较昨日 +2」）。 */
  sub?: React.ReactNode;
  subTone?: 'muted' | 'up' | 'down';
  spark?: number[];
}

const SUB: Record<NonNullable<StatCardProps['subTone']>, string> = {
  muted: 'text-fg-subtle',
  up: 'text-success-fg',
  down: 'text-danger-fg',
};

const SPARK_COLOR: Record<ChipTone, string> = {
  violet: 'text-primary',
  blue: 'text-info',
  green: 'text-success',
  amber: 'text-warning',
  red: 'text-danger',
  gray: 'text-fg-subtle',
};

export function StatCard({ label, value, icon, tone = 'violet', sub, subTone = 'muted', spark }: StatCardProps) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm text-fg-muted">{label}</div>
          <div className="mt-2 text-3xl font-semibold tracking-tight text-fg">{value}</div>
        </div>
        <IconChip icon={icon} tone={tone} className="size-10" />
      </div>
      <div className="mt-3 flex items-end justify-between gap-2">
        <span className={cn('text-xs', SUB[subTone])}>{sub}</span>
        {spark && <Sparkline data={spark} className={SPARK_COLOR[tone]} />}
      </div>
    </Card>
  );
}
