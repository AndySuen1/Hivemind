import { cn } from '@/lib/utils';

export interface PageContainerProps {
  size?: 'narrow' | 'default' | 'wide';
  className?: string;
  children: React.ReactNode;
}

// 全站统一三档内容宽度，一律居中（消除各页 max-w 不一 + 左靠跳动）。
const SIZE: Record<NonNullable<PageContainerProps['size']>, string> = {
  narrow: 'max-w-2xl', // 表单/设置类
  default: 'max-w-4xl', // 列表类
  wide: 'max-w-6xl', // 仪表盘/多栏
};

/** 页面级内容容器：固定宽度档 + mx-auto 居中。各页根 div 统一换成它。 */
export function PageContainer({ size = 'default', className, children }: PageContainerProps) {
  return <div className={cn('mx-auto w-full', SIZE[size], className)}>{children}</div>;
}
