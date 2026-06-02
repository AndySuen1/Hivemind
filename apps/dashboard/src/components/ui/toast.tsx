'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

type ToastTone = 'success' | 'danger' | 'info' | 'warning';

export interface ToastOptions {
  tone?: ToastTone;
  duration?: number;
}

interface ToastItem {
  id: number;
  message: React.ReactNode;
  tone: ToastTone;
}

interface ToastApi {
  toast: (message: React.ReactNode, opts?: ToastOptions) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TONE_BAR: Record<ToastTone, string> = {
  success: 'bg-success',
  danger: 'bg-danger',
  info: 'bg-info',
  warning: 'bg-warning',
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const remove = useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id));
    const tm = timers.current.get(id);
    if (tm) {
      clearTimeout(tm);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback<ToastApi['toast']>((message, opts) => {
    const id = ++seq.current;
    setItems((list) => [...list, { id, message, tone: opts?.tone ?? 'info' }]);
    const tm = setTimeout(() => remove(id), opts?.duration ?? 4000);
    timers.current.set(id, tm);
  }, [remove]);

  // 卸载时清掉所有定时器（StrictMode 双调用安全）
  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((tm) => clearTimeout(tm));
      map.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            className="pointer-events-auto flex animate-slide-up-in items-start gap-2 overflow-hidden rounded-lg border border-border bg-bg-card px-3 py-2 text-sm text-fg shadow-md"
          >
            <span className={cn('mt-0.5 h-full w-1 shrink-0 self-stretch rounded-full', TONE_BAR[t.tone])} />
            <span className="flex-1 break-words">{t.message}</span>
            <button
              onClick={() => remove(t.id)}
              className="shrink-0 rounded px-1 text-fg-subtle transition-colors hover:text-fg"
              aria-label="关闭通知"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** 返回 { toast }，替换散落的 alert / 内联 ✅ 提示。 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast 必须在 <ToastProvider> 内使用');
  return ctx;
}
