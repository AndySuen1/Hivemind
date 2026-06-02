'use client';

import { useId } from 'react';
import { Modal } from './modal';
import { Button } from './button';

export interface FormModalProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** 内部已 preventDefault，回调里只管业务（成功后自行 onClose + refresh）。 */
  onSubmit: (e: React.FormEvent) => void | Promise<void>;
  submitting?: boolean;
  submitText?: string;
  error?: string | null;
  /** 打开时聚焦的元素（一般传第一个输入框 ref）。不传则 Modal 聚焦面板。 */
  initialFocusRef?: React.RefObject<HTMLElement>;
  children: React.ReactNode;
}

/**
 * Modal + form 的统一范式：按钮放 Modal footer，用 form={formId} 跨节点关联提交；
 * 顶部错误条；不自动关闭（成功与否由调用方在 onSubmit 内决定）。
 */
export function FormModal({
  open,
  onClose,
  title,
  size = 'md',
  onSubmit,
  submitting = false,
  submitText = '保存',
  error,
  initialFocusRef,
  children,
}: FormModalProps) {
  const formId = useId();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size={size}
      initialFocusRef={initialFocusRef}
      footer={
        <>
          <Button type="button" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={submitting}>
            {submitting ? '保存中…' : submitText}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit(e);
        }}
        className="space-y-3"
      >
        {error && <div className="mb-3 rounded bg-danger-soft p-2 text-xs text-danger-fg">{error}</div>}
        {children}
      </form>
    </Modal>
  );
}
