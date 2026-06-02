import { cn } from '@/lib/utils';

export interface PageHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode; // 右操作区（搜索/主按钮等）
  breadcrumb?: React.ReactNode; // 标题上方面包屑（如 bot 详情：可观测 / bot）
  className?: string;
}

/** 页头：唯一页面级标题原语。左标题/副标题 + 右操作区，可选 breadcrumb。 */
export function PageHeader({ title, subtitle, actions, breadcrumb, className }: PageHeaderProps) {
  return (
    <div className={cn('mb-7', className)}>
      {breadcrumb && <nav className="mb-1.5 text-xs text-fg-subtle">{breadcrumb}</nav>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-fg-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
