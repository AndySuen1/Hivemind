'use client';

import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Modal } from './modal';
import { Button } from './button';

export interface ConfirmOptions {
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface State extends ConfirmOptions {
  open: boolean;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>({ open: false, title: '' });
  const resolver = useRef<(v: boolean) => void>();
  const cancelRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    setState({ ...opts, open: true });
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = useCallback((v: boolean) => {
    resolver.current?.(v);
    resolver.current = undefined;
    setState((s) => ({ ...s, open: false }));
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={state.open}
        onClose={() => settle(false)}
        title={state.title}
        size="sm"
        initialFocusRef={cancelRef}
        footer={
          <>
            <Button ref={cancelRef} variant="secondary" size="sm" onClick={() => settle(false)}>
              {state.cancelText ?? '取消'}
            </Button>
            <Button
              variant={state.danger ? 'danger' : 'primary'}
              size="sm"
              onClick={() => settle(true)}
            >
              {state.confirmText ?? '确认'}
            </Button>
          </>
        }
      >
        {state.description && <p className="text-sm text-fg-muted">{state.description}</p>}
      </Modal>
    </ConfirmContext.Provider>
  );
}

/** 返回 confirm(opts):Promise<boolean>，替换原生 window.confirm。 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm 必须在 <ConfirmProvider> 内使用');
  return ctx;
}
