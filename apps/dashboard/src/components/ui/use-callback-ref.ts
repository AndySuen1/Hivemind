'use client';

import { useEffect, useMemo, useRef } from 'react';

/** 把回调存进 ref 并始终指向最新值，返回一个稳定的调用器（避免 effect 因回调身份变化反复重订阅）。 */
export function useCallbackRef<T extends (...args: never[]) => unknown>(callback: T | undefined): T {
  const ref = useRef(callback);
  useEffect(() => {
    ref.current = callback;
  });
  return useMemo(() => ((...args: never[]) => ref.current?.(...args)) as T, []);
}
