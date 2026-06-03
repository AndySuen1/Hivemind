'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Boxes, Bot, FolderKanban, Puzzle, Activity, Settings, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/', label: '概览', icon: LayoutDashboard },
  { href: '/providers', label: 'Providers', icon: Boxes },
  { href: '/bots', label: 'Bots', icon: Bot },
  { href: '/projects', label: '项目', icon: FolderKanban },
  { href: '/skills', label: '技能', icon: Puzzle },
  { href: '/observability', label: '监控', icon: Activity },
  { href: '/settings', label: '设置', icon: Settings },
];

export function SideNav() {
  const pathname = usePathname();
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-bg-subtle px-3 py-5">
      {/* 品牌：蜂巢六边形 logo + 名称 */}
      <Link href="/" className="group mb-7 flex items-center gap-2.5 px-2">
        <span className="relative grid size-9 place-items-center">
          <svg
            viewBox="0 0 24 24"
            className="absolute inset-0 size-full text-fg transition-transform duration-slow ease-notion group-hover:rotate-[30deg]"
            aria-hidden="true"
          >
            <polygon points="12,1.2 21.4,6.6 21.4,17.4 12,22.8 2.6,17.4 2.6,6.6" fill="currentColor" />
          </svg>
          <span className="relative text-sm font-bold text-bg">H</span>
        </span>
        <div className="leading-tight">
          <div className="text-[15px] font-semibold tracking-tight text-fg">Hivemind</div>
          <div className="text-[11px] text-fg-subtle">控制台</div>
        </div>
      </Link>

      {/* 分组标签 */}
      <div className="mb-1.5 px-3 text-[11px] font-medium uppercase tracking-wider text-fg-subtle">管理</div>

      {/* 导航 */}
      <nav className="space-y-0.5">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors duration-fast',
                active
                  ? 'bg-primary-soft font-medium text-primary'
                  : 'text-fg-muted hover:bg-bg-hover hover:text-fg',
              )}
            >
              <Icon
                className={cn('size-[18px] transition-colors', active ? 'text-primary' : 'text-fg-subtle group-hover:text-fg')}
                strokeWidth={active ? 2 : 1.75}
              />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* 底部：本地实例状态 */}
      <div className="mt-auto rounded-xl border border-border bg-bg-card p-3 shadow-xs">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary-soft text-xs font-semibold text-primary">
            HM
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-fg">本地实例</div>
            <div className="mt-0.5 flex items-center gap-1 text-[11px] text-fg-subtle">
              <span className="size-1.5 rounded-full bg-success" />
              DeepSeek · Claude
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
