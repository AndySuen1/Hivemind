'use client';

import { Check } from 'lucide-react';
import type { BotWithRuntime } from '@/lib/api';
import { BotAvatar } from '@/components/bot/BotAvatar';
import { cn } from '@/lib/utils';

export interface MemberPickerProps {
  bots: BotWithRuntime[];
  /** 已选 bot id 列表。 */
  selected: string[];
  /** 勾选切换：传 bot id 与目标选中态。 */
  onToggle: (botId: string, checked: boolean) => void;
  /**
   * 该 bot 当前所属的「其他项目」名（用于提示「勾选将移过来」）；返回 null 表示无需提示。
   * 由调用方注入——新建弹窗与配置页对「其他项目」的判定不同（配置页要排除自己）。
   */
  otherProjectOf?: (botId: string) => string | null;
  /** 滚动区限高类（默认 max-h-72；新建弹窗用 max-h-52）。 */
  maxHeightClass?: string;
  className?: string;
}

/**
 * 去线框的成员选择器：软色凹槽容器 + 可选瓷砖。
 * - 未选 = 白瓷砖 + shadow-xs 浮起，hover 转 bg-hover；
 * - 选中 = primary-soft 浅 blurple 底 + ring-primary/30 软描边 + 右端 Check。
 * 原生 checkbox 用 `sr-only` 藏起、保留键盘与可访问语义。
 * 由新建项目弹窗与项目配置页共用，替代原先两份 `rounded border` 的裸 checkbox 清单。
 */
export function MemberPicker({
  bots,
  selected,
  onToggle,
  otherProjectOf,
  maxHeightClass = 'max-h-72',
  className,
}: MemberPickerProps) {
  if (bots.length === 0) {
    return <div className="text-[11px] text-fg-subtle">还没有 bot——先去「Bots」创建几个再来编组。</div>;
  }
  return (
    <div className={cn('overflow-y-auto rounded-lg bg-bg-subtle p-1.5', maxHeightClass, className)}>
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        {bots.map((b) => {
          const checked = selected.includes(b.id);
          const other = otherProjectOf?.(b.id) ?? null;
          return (
            <label
              key={b.id}
              className={cn(
                'group flex cursor-pointer items-center gap-2 rounded-lg p-2 text-sm transition duration-fast ease-notion',
                'focus-within:ring-2 focus-within:ring-ring/50',
                checked ? 'bg-primary-soft ring-1 ring-primary/30' : 'bg-bg-card shadow-xs hover:bg-bg-hover',
              )}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={checked}
                onChange={(e) => onToggle(b.id, e.target.checked)}
              />
              <BotAvatar name={b.name} avatar={b.avatar} id={b.id} size={20} rounded="full" />
              <span className="min-w-0 flex-1 truncate text-fg">{b.name}</span>
              {other && (
                <span className="shrink-0 text-[10px] text-warning-fg" title={`当前在「${other}」，勾选将移过来`}>
                  在「{other}」
                </span>
              )}
              {checked ? (
                <Check className="size-4 shrink-0 text-primary" aria-hidden />
              ) : (
                <code className="shrink-0 text-[10px] text-fg-subtle">{b.id.slice(0, 8)}</code>
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}
