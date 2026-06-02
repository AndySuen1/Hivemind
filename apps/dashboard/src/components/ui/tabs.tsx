'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface TabItem {
  key: string;
  label: React.ReactNode;
  icon?: LucideIcon;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (key: string) => void;
  className?: string;
}

/**
 * 标签栏：受控（value/onChange）。roving tabindex + 方向键/Home/End 切换，
 * CSS-first（仅 border-color 过渡）。视觉沿用 bot 详情页原手写值，零回归。
 */
export function Tabs({ items, value, onChange, className }: TabsProps) {
  const baseId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const idx = items.findIndex((t) => t.key === value);
    if (idx < 0) return;
    let next = idx;
    if (e.key === 'ArrowRight') next = (idx + 1) % items.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else return;
    e.preventDefault();
    onChange(items[next].key);
    refs.current[next]?.focus();
  };

  return (
    <div role="tablist" className={cn('flex gap-1 border-b border-border', className)} onKeyDown={onKeyDown}>
      {items.map((t, i) => {
        const active = t.key === value;
        const Icon = t.icon;
        return (
          <button
            key={t.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="tab"
            type="button"
            id={`${baseId}-tab-${t.key}`}
            aria-selected={active}
            aria-controls={`${baseId}-panel-${t.key}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.key)}
            className={cn(
              '-mb-px flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
              active
                ? 'border-primary-strong font-medium text-primary-strong'
                : 'border-transparent text-fg-muted hover:text-fg',
            )}
          >
            {Icon && <Icon className="size-4" strokeWidth={1.75} />}
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/** 条件挂载式面板：activeKey !== tabKey 时返回 null（保留各页 panel 重挂语义）。 */
export function TabPanel({
  tabKey,
  activeKey,
  className,
  children,
}: {
  tabKey: string;
  activeKey: string;
  className?: string;
  children: React.ReactNode;
}) {
  if (tabKey !== activeKey) return null;
  return (
    <div role="tabpanel" className={className}>
      {children}
    </div>
  );
}

export interface UseTabsOptions {
  defaultKey?: string;
  queryKey?: string;
}

/**
 * 受控/URL 同步胶水。给了 queryKey 则用 window.location + history.replaceState 同步 ?key=
 * —— 刻意不用 next/navigation 的 useSearchParams，避免 'use client' 顶层组件触发
 * next build 的 CSR-bailout 报错。不传 queryKey 则纯本地 state。
 */
export function useTabs(items: TabItem[], opts: UseTabsOptions = {}) {
  const { defaultKey, queryKey } = opts;
  const [value, setValue] = useState(defaultKey ?? items[0]?.key ?? '');

  // 挂载后读 URL 初值（SSR 无 window，故放 effect；仅跑一次）
  useEffect(() => {
    if (!queryKey || typeof window === 'undefined') return;
    const fromUrl = new URLSearchParams(window.location.search).get(queryKey);
    if (fromUrl && items.some((t) => t.key === fromUrl)) setValue(fromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = useCallback(
    (key: string) => {
      setValue(key);
      if (queryKey && typeof window !== 'undefined') {
        const url = new URL(window.location.href);
        url.searchParams.set(queryKey, key);
        window.history.replaceState(null, '', url);
      }
    },
    [queryKey],
  );

  return { value, setValue: set, tabProps: { items, value, onChange: set } };
}
