import { cn } from '@/lib/utils';

export interface FieldProps {
  label: React.ReactNode;
  hint?: React.ReactNode; // 次级说明
  error?: string; // 红字校验提示
  required?: boolean;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}

export function Field({ label, hint, error, required, htmlFor, className, children }: FieldProps) {
  return (
    <div className={cn('block', className)}>
      <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-fg">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </label>
      {children}
      {hint && !error && <p className="mt-1 text-xs text-fg-subtle">{hint}</p>}
      {error && <p className="mt-1 animate-slide-down text-xs text-danger-fg">{error}</p>}
    </div>
  );
}
