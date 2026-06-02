'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { useCallbackRef } from './use-callback-ref';

type Size = 'sm' | 'md' | 'lg';
const SIZE: Record<Size, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
};

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  size?: Size;
  footer?: React.ReactNode;
  closeOnOverlay?: boolean;
  closeOnEsc?: boolean;
  /** 打开时默认聚焦的元素（危险操作应传「取消」钮 ref）。 */
  initialFocusRef?: React.RefObject<HTMLElement>;
  children: React.ReactNode;
}

export function Modal({
  open,
  onClose,
  title,
  size = 'md',
  footer,
  closeOnOverlay = true,
  closeOnEsc = true,
  initialFocusRef,
  children,
}: ModalProps) {
  const onCloseRef = useCallbackRef(onClose);
  const panelRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  const [rendered, setRendered] = useState(open);
  const [show, setShow] = useState(false);
  const titleId = useId();

  // 进出场：open → 挂载后下一帧切 show；close → 切 show 后延迟卸载
  useEffect(() => {
    if (open) {
      setRendered(true);
      const r = requestAnimationFrame(() => setShow(true));
      return () => cancelAnimationFrame(r);
    }
    setShow(false);
    const t = setTimeout(() => setRendered(false), 200);
    return () => clearTimeout(t);
  }, [open]);

  // 焦点管理 + body 滚动锁
  useEffect(() => {
    if (!rendered || !open) return;
    prevFocus.current = document.activeElement as HTMLElement | null;
    const focusTarget = initialFocusRef?.current ?? panelRef.current;
    focusTarget?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      prevFocus.current?.focus?.();
    };
  }, [rendered, open, initialFocusRef]);

  // 键盘：Esc 关闭 + Tab 焦点循环
  useEffect(() => {
    if (!rendered || !open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && closeOnEsc) {
        e.stopPropagation();
        onCloseRef();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [rendered, open, closeOnEsc, onCloseRef]);

  if (!rendered || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation">
      <div
        className={cn('absolute inset-0 bg-black/30 transition-opacity duration-200', show ? 'opacity-100' : 'opacity-0')}
        onClick={closeOnOverlay ? onClose : undefined}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={cn(
          'relative w-full rounded-xl bg-bg-card shadow-popover outline-none transition-all duration-200 ease-notion',
          show ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-2 scale-[0.97] opacity-0',
          SIZE[size],
        )}
      >
        {title && (
          <div className="border-b border-border px-5 py-3">
            <h2 id={titleId} className="text-lg font-semibold text-fg">
              {title}
            </h2>
          </div>
        )}
        <div className="px-5 py-4 text-sm text-fg">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
