'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { BotAvatar } from './BotAvatar';

export interface AvatarStackMember {
  id: string;
  name: string;
  avatar?: string;
}

export interface AvatarStackProps {
  members: AvatarStackMember[];
  /** 头像边长（px），默认 28。 */
  size?: number;
  className?: string;
}

const OVERLAP = 8; // 相邻头像重叠像素

/**
 * 重叠头像排 + 响应式「+N」溢出指示。
 * 测量容器宽度，算出一排能放下几个；放不下时末尾加一个「+N」chip（N = 未显示的成员数）。
 * 每个头像套 ring 与背景同色做分隔；空成员给灰字占位保持行高稳定。
 */
export function AvatarStack({ members, size = 28, className }: AvatarStackProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w != null) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = members.length;
  const stride = size - OVERLAP;

  // 取舍：能全放下就全放；否则留出 chip 的位置，至少显示 1 个头像。
  let visibleCount = n;
  let hiddenCount = 0;
  if (width != null && n > 0) {
    const fullWidth = size + (n - 1) * stride;
    if (fullWidth > width) {
      // 解 size + v*stride <= width（v 个头像 + 末尾 chip）
      visibleCount = Math.max(1, Math.floor((width - size) / stride));
      visibleCount = Math.min(visibleCount, n - 1); // 有 chip 才有意义
      hiddenCount = n - visibleCount;
    }
  }

  if (n === 0) {
    return (
      <div ref={ref} className={cn('flex items-center', className)} style={{ height: size }}>
        <span className="text-xs text-fg-subtle">暂无成员（至少加 2 个才能互相 @）</span>
      </div>
    );
  }

  const shown = members.slice(0, visibleCount);

  return (
    <div
      ref={ref}
      className={cn('relative flex items-center overflow-hidden', className)}
      style={{ height: size, visibility: width === null ? 'hidden' : 'visible' }}
    >
      {shown.map((m, i) => (
        <span key={m.id} className="shrink-0" style={{ marginLeft: i === 0 ? 0 : -OVERLAP }}>
          <BotAvatar name={m.name} avatar={m.avatar} id={m.id} size={size} rounded="full" className="ring-2 ring-bg-card" />
        </span>
      ))}
      {hiddenCount > 0 && (
        <span
          className="grid shrink-0 select-none place-items-center rounded-full bg-bg-subtle font-medium leading-none text-fg-muted ring-2 ring-bg-card"
          style={{ width: size, height: size, marginLeft: -OVERLAP, fontSize: Math.round(size * 0.36) }}
          aria-label={`还有 ${hiddenCount} 个成员`}
          title={`还有 ${hiddenCount} 个成员`}
        >
          +{hiddenCount}
        </span>
      )}
    </div>
  );
}
