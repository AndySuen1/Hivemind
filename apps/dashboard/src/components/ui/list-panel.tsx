import { cn } from '@/lib/utils';

export interface ListPanelProps {
  title: React.ReactNode;
  count?: number;
  subtitle?: React.ReactNode;
  className?: string; // 调宽度/外层（如 w-full lg:w-60）
  bodyClassName?: string; // 调滚动区限高（默认 max-h-panel-sm lg:max-h-panel）
  children: React.ReactNode;
}

/**
 * 左侧列表面板统一外壳：计数标题条 + 可滚动限高 body。
 * 宽度/限高由调用方经 className/bodyClassName 注入，列表行/skeleton/empty 作 children 传入。
 */
export function ListPanel({ title, count, subtitle, className, bodyClassName, children }: ListPanelProps) {
  return (
    <div className={cn('flex shrink-0 flex-col overflow-hidden rounded border border-border bg-bg-card', className)}>
      <div className="border-b border-border px-3 py-2 text-xs font-medium text-fg-muted">
        {title}
        {count != null && `（${count}）`}
        {subtitle && <> · {subtitle}</>}
      </div>
      <div className={cn('overflow-y-auto max-h-panel-sm lg:max-h-panel', bodyClassName)}>{children}</div>
    </div>
  );
}
