'use client';

import { cn } from '@/lib/utils';

// 静态字面量 token 对（soft 底 + fg 文字），保证 Tailwind JIT 能扫到——禁止用变量拼类名。
const PALETTE: readonly (readonly [string, string])[] = [
  ['bg-primary-soft', 'text-primary'],
  ['bg-info-soft', 'text-info-fg'],
  ['bg-success-soft', 'text-success-fg'],
  ['bg-warning-soft', 'text-warning-fg'],
  ['bg-danger-soft', 'text-danger-fg'],
];

const RADIUS: Record<NonNullable<BotAvatarProps['rounded']>, string> = {
  full: 'rounded-full',
  lg: 'rounded-lg',
  xl: 'rounded-xl',
  '2xl': 'rounded-2xl',
};

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** 名字首字 initials：CJK 等非 ASCII 取第一个字；否则取前两个单词首字母（大写）。 */
function initialsOf(name: string): string {
  const t = name.trim();
  if (!t) return '?';
  if (t.charCodeAt(0) > 127) return t[0]; // 中日韩等：取第一个字符
  const words = t.split(/[\s\-_]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return t.slice(0, 2).toUpperCase();
}

export interface BotAvatarProps {
  name: string;
  avatar?: string;
  id?: string;
  /** 固定像素边长（与 fill 二选一）。 */
  size?: number;
  /** 铺满父容器：尺寸交给 className（如 w-full aspect-square），initials 用响应式字号。 */
  fill?: boolean;
  /** 形状圆角：默认圆形；网格头像块用 2xl 圆角方形（借鉴 Discord 应用图标）。 */
  rounded?: 'full' | 'lg' | 'xl' | '2xl';
  className?: string;
}

/**
 * Bot 头像：有 avatar（data URL）就渲染图片，否则用名字首字生成 initials 占位，
 * 背景色由 id||name 哈希到固定调色板（同一 bot 永远同色）。
 */
export function BotAvatar({ name, avatar, id, size = 40, fill, rounded = 'full', className }: BotAvatarProps) {
  const radius = RADIUS[rounded];
  const sizeStyle = fill ? undefined : { width: size, height: size };
  const sizeCls = fill ? 'h-full w-full' : '';
  if (avatar) {
    // eslint-disable-next-line @next/next/no-img-element -- data URL 头像不走 next/image
    return (
      <img
        src={avatar}
        alt={name}
        style={sizeStyle}
        className={cn('shrink-0 bg-bg-subtle object-cover', radius, sizeCls, className)}
      />
    );
  }
  const [bg, fg] = PALETTE[hashStr(id || name) % PALETTE.length];
  return (
    <span
      style={{ ...sizeStyle, ...(fill ? undefined : { fontSize: Math.round(size * 0.4) }) }}
      className={cn(
        'grid shrink-0 select-none place-items-center font-semibold leading-none',
        fill && 'text-4xl',
        radius,
        bg,
        fg,
        sizeCls,
        className,
      )}
      aria-label={name}
    >
      {initialsOf(name)}
    </span>
  );
}
