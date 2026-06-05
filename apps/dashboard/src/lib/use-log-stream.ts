'use client';

import { useEffect, useRef } from 'react';
import type { LogEntry } from '@hivemind/shared';
import { API_BASE } from './api';

export interface LogStreamFilter {
  level?: string;
  source?: string;
}

/**
 * 订阅 orchestrator 的日志 SSE 流（/api/logs/stream），按 level/source 过滤（关键词 q 在前端本地过滤，
 * 避免每次输入都重连）。EventSource 原生自动重连；filter 变化时重连。onLog 用 ref 持有避免重连。
 * enabled=false（如非「日志」tab）时不连接。
 */
export function useLogStream(filter: LogStreamFilter, onLog: (entry: LogEntry) => void, enabled = true): void {
  const cbRef = useRef(onLog);
  cbRef.current = onLog;

  const key = `${enabled ? 1 : 0}|${filter.level ?? ''}|${filter.source ?? ''}`;

  useEffect(() => {
    if (!enabled) return;
    const sp = new URLSearchParams();
    if (filter.level) sp.set('level', filter.level);
    if (filter.source) sp.set('source', filter.source);

    const es = new EventSource(`${API_BASE}/api/logs/stream?${sp.toString()}`);
    es.onmessage = (e) => {
      try {
        cbRef.current(JSON.parse(e.data) as LogEntry);
      } catch {
        /* 忽略坏帧 */
      }
    };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
