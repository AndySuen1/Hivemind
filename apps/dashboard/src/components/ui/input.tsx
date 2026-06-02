import { forwardRef } from 'react';
import { cn } from '@/lib/utils';

const BASE =
  'w-full rounded border border-border bg-bg-card px-3 py-2 text-sm text-fg placeholder:text-fg-subtle ' +
  'transition-colors duration-fast focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 ' +
  'disabled:opacity-50';
const INVALID = 'border-danger focus:border-danger focus:ring-danger/30';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, className, ...props },
  ref,
) {
  return <input ref={ref} className={cn(BASE, invalid && INVALID, className)} {...props} />;
});

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, className, ...props },
  ref,
) {
  return <textarea ref={ref} className={cn(BASE, invalid && INVALID, className)} {...props} />;
});

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { invalid, className, children, ...props },
  ref,
) {
  return (
    <select ref={ref} className={cn(BASE, 'cursor-pointer', invalid && INVALID, className)} {...props}>
      {children}
    </select>
  );
});
