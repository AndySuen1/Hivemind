'use client';

import { cn } from '@/lib/utils';

/**
 * 纯 CSS 高度展开/折叠（grid-template-rows: 0fr ↔ 1fr 技巧，免 framer）。
 * CSS 原生过渡 height:auto 做不到，grid-rows 是标准解法。
 */
export function Collapse({
  open,
  children,
  className,
}: {
  open: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows] duration-slow ease-notion',
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        className,
      )}
    >
      <div className={cn('overflow-hidden transition-opacity duration-fast', open ? 'opacity-100' : 'opacity-0')}>
        {children}
      </div>
    </div>
  );
}
