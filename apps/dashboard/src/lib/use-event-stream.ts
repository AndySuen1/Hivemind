'use client';

import { useEffect, useRef } from 'react';
import type { ObservRecord } from '@discord-agent-hub/shared';
import { API_BASE } from './api';

export interface StreamFilter {
  botId?: string;
  sessionId?: string;
  runId?: string;
}

/**
 * 订阅 orchestrator 的 SSE 实时流（/api/stream），按 botId/sessionId/runId 过滤。
 * EventSource 原生自动重连；filter 变化时重连。onRecord 用 ref 持有，避免每次渲染重连。
 * enabled=false 时不连接（如某 tab 未激活）。
 */
export function useEventStream(
  filter: StreamFilter,
  onRecord: (rec: ObservRecord) => void,
  enabled = true
): void {
  const cbRef = useRef(onRecord);
  cbRef.current = onRecord;

  const key = `${enabled ? 1 : 0}|${filter.botId ?? ''}|${filter.sessionId ?? ''}|${filter.runId ?? ''}`;

  useEffect(() => {
    if (!enabled) return;
    const sp = new URLSearchParams();
    if (filter.botId) sp.set('botId', filter.botId);
    if (filter.sessionId) sp.set('sessionId', filter.sessionId);
    if (filter.runId) sp.set('runId', filter.runId);

    const es = new EventSource(`${API_BASE}/api/stream?${sp.toString()}`);
    es.onmessage = (e) => {
      try {
        cbRef.current(JSON.parse(e.data) as ObservRecord);
      } catch {
        /* 忽略坏帧 */
      }
    };
    // 出错时 EventSource 会自动重连；这里不主动 close，交给 cleanup。
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
