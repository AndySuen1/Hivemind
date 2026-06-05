import { forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { Spinner } from './spinner';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leftIcon?: React.ReactNode;
}

// primary 用 primary-strong 保证「蓝底白字」达 WCAG AA。
const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-primary-strong text-primary-fg hover:bg-primary-hover',
  secondary: 'border border-border bg-bg-card text-fg hover:bg-bg-hover',
  danger: 'border border-danger/40 text-danger-fg hover:bg-danger-soft',
  ghost: 'text-fg-muted hover:bg-bg-hover hover:text-fg',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1 px-2.5 text-xs',
  md: 'h-9 gap-1.5 px-3.5 text-sm',
  lg: 'h-10 gap-2 px-4 text-[15px]',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, leftIcon, disabled, className, children, type, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center rounded-lg font-medium transition duration-fast ease-notion',
        'active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-ring/40',
        'disabled:pointer-events-none disabled:opacity-50',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...props}
    >
      {loading ? <Spinner className="size-3.5" /> : leftIcon}
      {children}
    </button>
  );
});
