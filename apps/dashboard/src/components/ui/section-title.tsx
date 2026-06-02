import { cn } from '@/lib/utils';

export interface SectionTitleProps {
  as?: 'h1' | 'h2' | 'h3';
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode; // 右侧操作（如「+新建」）
  className?: string;
}

/**
 * 分区小标题：卡片内 / Tab 内分组用。页面级标题请用 PageHeader。
 * （早期曾兼任页面级标题，现统一降级为更小的 h3 级，避免与页头打架。）
 */
export function SectionTitle({ as: Tag = 'h3', title, description, action, className }: SectionTitleProps) {
  return (
    <div className={cn('mb-3 flex items-start justify-between gap-4', className)}>
      <div>
        <Tag className="text-base font-semibold tracking-tight text-fg">{title}</Tag>
        {description && <p className="mt-1 text-xs text-fg-muted">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
