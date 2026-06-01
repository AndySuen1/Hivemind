'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type {
  ObservSession,
  ObservRun,
  ObservMessage,
  ObservEvent,
  ObservCursor,
  ObservMemoryEntry,
  ObservRecord,
} from '@discord-agent-hub/shared';
import { observApi, botsApi, type BotWithRuntime } from '@/lib/api';
import { useEventStream } from '@/lib/use-event-stream';
import {
  fmtTime,
  fmtClock,
  fmtDuration,
  runStatusColor,
  runStatusLabel,
  BOT_STATUS_COLOR,
  eventMeta,
  preview,
  statusDotColor,
} from '@/lib/observ-ui';

type Tab = 'live' | 'chat' | 'trace' | 'memory';
const TABS: { key: Tab; label: string }[] = [
  { key: 'live', label: '实时' },
  { key: 'chat', label: '聊天' },
  { key: 'trace', label: '执行追踪' },
  { key: 'memory', label: '记忆' },
];

export default function BotDetailPage({ params }: { params: { id: string } }) {
  const botId = params.id;
  const [tab, setTab] = useState<Tab>('live');
  const [bot, setBot] = useState<BotWithRuntime | null>(null);
  // 清空全部历史后自增：作为各 tab 的 key，强制重挂以清掉其内部缓存的会话/回合/feed 选择。
  const [reloadKey, setReloadKey] = useState(0);
  const [actionErr, setActionErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = () => botsApi.get(botId).then((b) => alive && setBot(b)).catch(() => {});
    refresh();
    const t = setInterval(refresh, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [botId]);

  const clearAll = async () => {
    if (!window.confirm(`清空 bot「${bot?.name ?? botId}」的全部会话 / 回合 / 消息 / 事件？此操作不可撤销。`)) return;
    setActionErr(null);
    try {
      await observApi.deleteBotHistory(botId);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setActionErr((e as Error).message);
    }
  };

  return (
    <div className="max-w-5xl">
      <div className="mb-1 text-xs text-zinc-400">
        <Link href="/observability" className="hover:underline">可观测</Link> / bot
      </div>
      <div className="mb-4 flex items-center gap-3">
        <h2 className="text-2xl font-bold">{bot?.name ?? botId}</h2>
        {bot && <span className={`rounded px-2 py-0.5 text-xs ${BOT_STATUS_COLOR[bot.runtime.status]}`}>{bot.runtime.status}</span>}
        <code className="text-[10px] text-zinc-400">{botId}</code>
        <button
          onClick={clearAll}
          title="删除该 bot 的全部可观测历史"
          className="ml-auto rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
        >
          🗑 清空全部历史
        </button>
      </div>
      {actionErr && <div className="mb-3 rounded bg-red-50 p-2 text-xs text-red-700">清空失败：{actionErr}</div>}

      <div className="mb-4 flex gap-1 border-b border-zinc-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm ${
              tab === t.key ? 'border-blue-600 font-medium text-blue-700' : 'border-transparent text-zinc-500 hover:text-zinc-800'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'live' && <LiveTab key={reloadKey} botId={botId} />}
      {tab === 'chat' && <ChatTab key={reloadKey} botId={botId} />}
      {tab === 'trace' && <TraceTab key={reloadKey} botId={botId} />}
      {tab === 'memory' && <MemoryTab botId={botId} />}
    </div>
  );
}

// ============================================================
// 会话列表（聊天 / 执行追踪 共用）
// ============================================================
function SessionList({
  botId,
  selectedId,
  onSelect,
  onDeleted,
}: {
  botId: string;
  selectedId: string | null;
  onSelect: (s: ObservSession) => void;
  onDeleted?: (id: string) => void;
}) {
  const [sessions, setSessions] = useState<ObservSession[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const p = await observApi.sessions(botId, { limit: 100 });
        if (alive) setSessions(p.items);
      } catch {
        /* ignore */
      } finally {
        if (alive) setLoading(false);
      }
    };
    refresh();
    const t = setInterval(refresh, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [botId]);

  // 自动选中首个
  useEffect(() => {
    if (!selectedId && sessions.length > 0) onSelect(sessions[0]!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, selectedId]);

  const handleDelete = async (s: ObservSession) => {
    if (!window.confirm(`清空会话「${s.title || s.channelName || s.channelId}」的全部消息 / 回合 / 事件？不可撤销。`)) return;
    try {
      await observApi.deleteSession(s.id);
      setSessions((prev) => prev.filter((x) => x.id !== s.id));
      onDeleted?.(s.id);
    } catch (e) {
      alert(`删除失败：${(e as Error).message}`);
    }
  };

  return (
    <div className="w-60 shrink-0 overflow-y-auto rounded border border-zinc-200 bg-white" style={{ maxHeight: '70vh' }}>
      <div className="border-b border-zinc-100 px-3 py-2 text-xs font-medium text-zinc-500">会话（{sessions.length}）</div>
      {loading ? (
        <div className="p-3 text-xs text-zinc-400">加载中…</div>
      ) : sessions.length === 0 ? (
        <div className="p-3 text-xs text-zinc-400">暂无会话</div>
      ) : (
        sessions.map((s) => (
          <div
            key={s.id}
            className={`group flex items-stretch border-b border-zinc-50 ${selectedId === s.id ? 'bg-blue-50' : ''}`}
          >
            <button onClick={() => onSelect(s)} className="min-w-0 flex-1 px-3 py-2 text-left text-xs hover:bg-zinc-50">
              <div className="truncate font-medium text-zinc-700">{s.title || s.channelName || s.channelId}</div>
              <div className="mt-0.5 flex items-center justify-between text-[10px] text-zinc-400">
                <span>{s.channelType ?? '?'}</span>
                <span>{fmtTime(s.lastActiveAt)}</span>
              </div>
            </button>
            <button
              onClick={() => handleDelete(s)}
              title="清空此会话"
              className="px-2 text-zinc-300 opacity-0 transition group-hover:opacity-100 hover:text-red-600"
            >
              ✕
            </button>
          </div>
        ))
      )}
    </div>
  );
}

// ============================================================
// 聊天 tab
// ============================================================
function ChatTab({ botId }: { botId: string }) {
  const [session, setSession] = useState<ObservSession | null>(null);
  return (
    <div className="flex gap-3">
      <SessionList
        botId={botId}
        selectedId={session?.id ?? null}
        onSelect={setSession}
        onDeleted={(id) => setSession((cur) => (cur?.id === id ? null : cur))}
      />
      <div className="flex-1 min-w-0">
        {session ? <MessagesView key={session.id} sessionId={session.id} /> : <Empty text="选择一个会话查看聊天记录" />}
      </div>
    </div>
  );
}

function MessagesView({ sessionId }: { sessionId: string }) {
  const [msgs, setMsgs] = useState<ObservMessage[]>([]); // 升序（旧→新）
  const [olderCursor, setOlderCursor] = useState<ObservCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const seen = useRef<Set<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);
  // 仅初始加载 / SSE 新消息时滚到底部；「加载更早」(stick=false) 不滚，否则旧消息一插入就被滚底拉走、功能形同虚设。
  const stickBottom = useRef(true);

  // 统一入口：去重 + 按时间升序合并。fetch 历史与 SSE 实时都走这里，避免裸替换覆盖竞态先到的消息。
  const addMessages = useCallback((list: ObservMessage[], stick = true) => {
    const fresh = list.filter((m) => !seen.current.has(m.id));
    if (fresh.length === 0) return;
    for (const m of fresh) seen.current.add(m.id);
    stickBottom.current = stick;
    setMsgs((prev) => [...prev, ...fresh].sort((a, b) => a.createdAt - b.createdAt));
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    observApi
      .messages(sessionId, { limit: 50 })
      .then((p) => {
        if (!alive) return;
        addMessages([...p.items].reverse());
        setOlderCursor(p.nextCursor);
      })
      .catch((e) => alive && setErr((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [sessionId, addMessages]);

  // 实时新消息：合并去重后追加
  const onRec = useCallback(
    (rec: ObservRecord) => {
      if (rec.kind === 'message') addMessages([rec.row]);
    },
    [addMessages]
  );
  useEventStream({ sessionId }, onRec);

  useEffect(() => {
    if (stickBottom.current) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs.length]);

  const loadOlder = async () => {
    if (olderCursor == null) return;
    try {
      const p = await observApi.messages(sessionId, { before: olderCursor.ts, beforeId: olderCursor.id, limit: 50 });
      addMessages([...p.items].reverse(), false); // 历史插到顶部，不触发滚底
      setOlderCursor(p.nextCursor);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="flex flex-col rounded border border-zinc-200 bg-white" style={{ height: '70vh' }}>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {olderCursor != null && (
          <button onClick={loadOlder} className="mx-auto block rounded border border-zinc-200 px-3 py-1 text-xs text-zinc-500 hover:bg-zinc-50">
            ↑ 加载更早
          </button>
        )}
        {loading ? (
          <div className="p-4 text-xs text-zinc-400">加载中…</div>
        ) : err ? (
          <div className="p-3 text-xs text-red-600">{err}</div>
        ) : msgs.length === 0 ? (
          <Empty text="暂无消息" />
        ) : null}
        {msgs.map((m) => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${m.role === 'user' ? 'bg-blue-600 text-white' : 'bg-zinc-100 text-zinc-800'}`}>
              <div className={`mb-0.5 text-[10px] ${m.role === 'user' ? 'text-blue-100' : 'text-zinc-400'}`}>
                {m.role === 'user' ? m.authorName || '用户' : '助手'} · {fmtClock(m.createdAt)}
                {m.truncated && ' · 已截断'}
              </div>
              <div className="whitespace-pre-wrap break-words">{m.content}</div>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ============================================================
// 执行追踪 tab
// ============================================================
function TraceTab({ botId }: { botId: string }) {
  const [session, setSession] = useState<ObservSession | null>(null);
  const [run, setRun] = useState<ObservRun | null>(null);
  return (
    <div className="flex gap-3">
      <SessionList
        botId={botId}
        selectedId={session?.id ?? null}
        onSelect={(s) => {
          setSession(s);
          setRun(null);
        }}
        onDeleted={(id) =>
          setSession((cur) => {
            if (cur?.id === id) {
              setRun(null);
              return null;
            }
            return cur;
          })
        }
      />
      {session ? (
        <RunsColumn key={session.id} sessionId={session.id} selectedRunId={run?.id ?? null} onSelect={setRun} />
      ) : (
        <div className="flex-1"><Empty text="选择一个会话" /></div>
      )}
      <div className="flex-1 min-w-0">
        {run ? <EventsTimeline key={run.id} run={run} /> : <Empty text="选择一个回合查看事件时间线" />}
      </div>
    </div>
  );
}

function RunsColumn({
  sessionId,
  selectedRunId,
  onSelect,
}: {
  sessionId: string;
  selectedRunId: string | null;
  onSelect: (r: ObservRun) => void;
}) {
  const [runs, setRuns] = useState<ObservRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const byId = useRef<Map<string, ObservRun>>(new Map());

  const apply = useCallback((list: ObservRun[]) => {
    for (const r of list) byId.current.set(r.id, r);
    setRuns([...byId.current.values()].sort((a, b) => b.startedAt - a.startedAt));
  }, []);

  useEffect(() => {
    let alive = true;
    byId.current = new Map();
    setRuns([]);
    setLoading(true);
    setErr(null);
    observApi
      .runs(sessionId, { limit: 50 })
      .then((p) => alive && apply(p.items))
      .catch((e) => alive && setErr((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [sessionId, apply]);

  // 自动选中首个回合（与 SessionList 对称，省去一次手点）
  useEffect(() => {
    if (!selectedRunId && runs.length > 0) onSelect(runs[0]!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs, selectedRunId]);

  // 实时：新回合 / 回合状态更新
  useEventStream(
    { sessionId },
    useCallback(
      (rec: ObservRecord) => {
        if (rec.kind === 'run') apply([rec.row]);
      },
      [apply]
    )
  );

  return (
    <div className="w-56 shrink-0 overflow-y-auto rounded border border-zinc-200 bg-white" style={{ maxHeight: '70vh' }}>
      <div className="border-b border-zinc-100 px-3 py-2 text-xs font-medium text-zinc-500">回合（{runs.length}）</div>
      {loading ? (
        <div className="p-3 text-xs text-zinc-400">加载中…</div>
      ) : err ? (
        <div className="p-3 text-xs text-red-600">{err}</div>
      ) : runs.length === 0 ? (
        <div className="p-3 text-xs text-zinc-400">暂无回合</div>
      ) : (
        runs.map((r) => (
          <button
            key={r.id}
            onClick={() => onSelect(r)}
            className={`block w-full border-b border-zinc-50 px-3 py-2 text-left text-xs hover:bg-zinc-50 ${
              selectedRunId === r.id ? 'bg-blue-50' : ''
            }`}
          >
            <div className="flex items-center justify-between">
              <span className={`rounded px-1.5 py-0.5 text-[10px] ${runStatusColor(r.status)}`}>{runStatusLabel(r.status)}</span>
              <span className="text-[10px] text-zinc-400">{fmtClock(r.startedAt)}</span>
            </div>
            <div className="mt-1 text-[10px] text-zinc-400">
              {r.toolCallCount} 个工具{r.usage?.totalTokens != null ? ` · ${r.usage.totalTokens} tok` : ''}
            </div>
          </button>
        ))
      )}
    </div>
  );
}

function EventsTimeline({ run }: { run: ObservRun }) {
  const [events, setEvents] = useState<ObservEvent[]>([]); // 升序 seq
  const [after, setAfter] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const seen = useRef<Set<string>>(new Set());

  const addAsc = useCallback((list: ObservEvent[]) => {
    const fresh = list.filter((e) => !seen.current.has(e.id));
    if (fresh.length === 0) return;
    for (const e of fresh) seen.current.add(e.id);
    setEvents((prev) => [...prev, ...fresh].sort((a, b) => a.seq - b.seq));
  }, []);

  useEffect(() => {
    let alive = true;
    seen.current = new Set();
    setEvents([]);
    setLoading(true);
    setErr(null);
    observApi
      .events(run.id, { limit: 200 })
      .then((p) => {
        if (!alive) return;
        addAsc(p.items);
        setAfter(p.nextCursor);
      })
      .catch((e) => alive && setErr((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [run.id, addAsc]);

  useEventStream(
    { runId: run.id },
    useCallback(
      (rec: ObservRecord) => {
        if (rec.kind === 'event') addAsc([rec.row]);
      },
      [addAsc]
    )
  );

  const { topLevel, childrenOf } = useMemo(() => {
    const childrenOf = new Map<string, ObservEvent[]>();
    const topLevel: ObservEvent[] = [];
    for (const e of events) {
      if (e.parentEventId) {
        const arr = childrenOf.get(e.parentEventId) ?? [];
        arr.push(e);
        childrenOf.set(e.parentEventId, arr);
      } else {
        topLevel.push(e);
      }
    }
    return { topLevel, childrenOf };
  }, [events]);

  const loadMore = async () => {
    if (after == null) return;
    try {
      const p = await observApi.events(run.id, { after, limit: 200 });
      addAsc(p.items);
      setAfter(p.nextCursor);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="overflow-y-auto rounded border border-zinc-200 bg-white p-3" style={{ maxHeight: '70vh' }}>
      <div className="mb-2 flex items-center gap-2 border-b border-zinc-100 pb-2 text-xs text-zinc-500">
        <span className={`rounded px-1.5 py-0.5 ${runStatusColor(run.status)}`}>{runStatusLabel(run.status)}</span>
        <span>{run.toolCallCount} 个工具调用</span>
        {run.finishReason && <span>· {run.finishReason}</span>}
        {run.usage?.totalTokens != null && <span>· {run.usage.totalTokens} tokens</span>}
        {run.error && <span className="text-red-600">· {run.error}</span>}
      </div>
      {loading ? (
        <div className="p-3 text-xs text-zinc-400">加载中…</div>
      ) : err ? (
        <div className="p-3 text-xs text-red-600">{err}</div>
      ) : topLevel.length === 0 ? (
        <Empty text="本回合暂无事件（纯对话、无工具调用）" />
      ) : (
        <div className="space-y-1">
          {topLevel.map((e) =>
            e.type === 'delegate_start' ? (
              <DelegateGroup key={e.id} start={e} children={childrenOf.get(e.id) ?? []} />
            ) : (
              <EventRow key={e.id} event={e} />
            )
          )}
        </div>
      )}
      {after != null && (
        <button onClick={loadMore} className="mt-2 block w-full rounded border border-zinc-200 px-3 py-1 text-xs text-zinc-500 hover:bg-zinc-50">
          ↓ 加载更多事件
        </button>
      )}
    </div>
  );
}

function DelegateGroup({ start, children }: { start: ObservEvent; children: ObservEvent[] }) {
  const [open, setOpen] = useState(false);
  const end = children.find((c) => c.type === 'delegate_end');
  const steps = children.filter((c) => c.type === 'delegate_step').length;
  const out = (end?.output ?? {}) as { numTurns?: number; costUsd?: number; summary?: string };
  const meta = eventMeta('delegate_start');
  return (
    <div className="rounded border border-indigo-100 bg-indigo-50/40">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs">
        <span className="text-[10px] text-zinc-400">{fmtClock(start.createdAt)}</span>
        <span>{meta.icon}</span>
        <span className="font-medium text-indigo-700">委派 Claude Code</span>
        <span className="text-zinc-500">（{children.filter((c) => c.type === 'delegate_step').length} 步{out.costUsd != null ? ` · ~$${out.costUsd.toFixed(3)}` : ''}）</span>
        {end && <span className={`ml-auto h-2 w-2 rounded-full ${statusDotColor(end.status)}`} title={end.status} />}
        <span className="text-zinc-400">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="space-y-1 border-t border-indigo-100 px-2 py-1.5">
          {children
            .slice()
            .sort((a, b) => a.seq - b.seq)
            .map((c) => (
              <EventRow key={c.id} event={c} nested />
            ))}
          {steps === 0 && <div className="text-[11px] text-zinc-400">（无步骤记录）</div>}
        </div>
      )}
    </div>
  );
}

function EventRow({ event, nested }: { event: ObservEvent; nested?: boolean }) {
  const [open, setOpen] = useState(false);
  const meta = eventMeta(event.type);
  const hasDetail = event.input !== undefined || event.output !== undefined;
  return (
    <div className={nested ? 'pl-2' : ''}>
      <button
        onClick={() => hasDetail && setOpen((o) => !o)}
        className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs ${hasDetail ? 'hover:bg-zinc-50' : 'cursor-default'}`}
      >
        <span className="text-[10px] text-zinc-400">{fmtClock(event.createdAt)}</span>
        <span>{meta.icon}</span>
        <span className={`font-medium ${meta.color}`}>{event.label || meta.label}</span>
        {event.toolName && <code className="rounded bg-zinc-100 px-1 text-[10px] text-zinc-600">{event.toolName}</code>}
        {event.status && <span className={`h-2 w-2 rounded-full ${statusDotColor(event.status)}`} title={event.status} />}
        {event.durationMs != null && <span className="text-[10px] text-zinc-400">{fmtDuration(event.durationMs)}</span>}
        {hasDetail && <span className="ml-auto text-zinc-300">{open ? '▾' : '▸'}</span>}
      </button>
      {open && hasDetail && (
        <div className="ml-6 mb-1 space-y-1">
          {event.input !== undefined && (
            <pre className="overflow-x-auto rounded bg-zinc-50 p-2 text-[11px] text-zinc-700">入参 {preview(event.input)}</pre>
          )}
          {event.output !== undefined && (
            <pre className="overflow-x-auto rounded bg-zinc-50 p-2 text-[11px] text-zinc-700">出参 {preview(event.output)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// 实时 tab：本 bot 的事件 live tail
// ============================================================
function LiveTab({ botId }: { botId: string }) {
  // 每条 feed 项配一个自增稳定 key：前插不改既有项 key（避免全列表重挂），
  // 且能区分同一 row.id 的多条记录（如 run 的 start 与 end）。
  const [feed, setFeed] = useState<{ key: number; rec: ObservRecord }[]>([]);
  const counter = useRef(0);
  const onRec = useCallback((rec: ObservRecord) => {
    setFeed((prev) => [{ key: counter.current++, rec }, ...prev].slice(0, 300));
  }, []);
  useEventStream({ botId }, onRec);

  return (
    <div className="rounded border border-zinc-200 bg-white">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-2">
        <span className="text-sm font-medium text-zinc-700">实时活动流</span>
        <span className="flex items-center gap-1.5 text-xs text-zinc-400">
          <span className="h-2 w-2 animate-pulse rounded-full bg-green-500" /> 实时（SSE）
        </span>
      </div>
      <div className="overflow-y-auto p-2" style={{ maxHeight: '70vh' }}>
        {feed.length === 0 ? (
          <Empty text="等待活动…（在 Discord 给这个 bot 发消息试试）" />
        ) : (
          <div className="space-y-0.5">
            {feed.map((entry) => (
              <LiveRow key={entry.key} rec={entry.rec} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function LiveRow({ rec }: { rec: ObservRecord }) {
  let line: string;
  let icon = '•';
  let ts = 0;
  if (rec.kind === 'session') {
    icon = '💬';
    ts = rec.row.lastActiveAt;
    line = `会话 ${rec.row.title || rec.row.channelName || rec.row.channelId}`;
  } else if (rec.kind === 'run') {
    icon = '▶';
    ts = rec.row.endedAt ?? rec.row.startedAt;
    line = `回合 ${runStatusLabel(rec.row.status)}${rec.row.toolCallCount ? ` · ${rec.row.toolCallCount} 工具` : ''}`;
  } else if (rec.kind === 'message') {
    icon = rec.row.role === 'user' ? '🧑' : '🤖';
    ts = rec.row.createdAt;
    line = `${rec.row.role === 'user' ? '用户' : '助手'}：${rec.row.content.slice(0, 80)}`;
  } else {
    const m = eventMeta(rec.row.type);
    icon = m.icon;
    ts = rec.row.createdAt;
    line = `${rec.row.label || m.label}${rec.row.toolName ? ` · ${rec.row.toolName}` : ''}`;
  }
  return (
    <div className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-zinc-50">
      <span className="text-[10px] text-zinc-400">{fmtClock(ts)}</span>
      <span>{icon}</span>
      <span className="truncate text-zinc-700">{line}</span>
    </div>
  );
}

// ============================================================
// 记忆 tab
// ============================================================
function MemoryTab({ botId }: { botId: string }) {
  const [list, setList] = useState<ObservMemoryEntry[]>([]);
  const [indexText, setIndexText] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    observApi
      .memory(botId)
      .then((d) => {
        if (!alive) return;
        setList(d.memories);
        setIndexText(d.indexText);
        setErr(null);
      })
      .catch((e) => alive && setErr((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [botId]);

  const openFile = async (file: string) => {
    setSel(file);
    setContent('加载中…');
    try {
      const d = await observApi.memoryFile(botId, file);
      setContent(d.content);
    } catch (e) {
      setContent(`错误：${(e as Error).message}`);
    }
  };

  return (
    <div className="flex gap-3">
      <div className="w-64 shrink-0 overflow-y-auto rounded border border-zinc-200 bg-white" style={{ maxHeight: '70vh' }}>
        <div className="border-b border-zinc-100 px-3 py-2 text-xs font-medium text-zinc-500">记忆（{list.length}）· 只读</div>
        {loading ? (
          <div className="p-3 text-xs text-zinc-400">加载中…</div>
        ) : err ? (
          <div className="p-3 text-xs text-red-600">{err}</div>
        ) : list.length === 0 ? (
          <div className="p-3 text-xs text-zinc-400">该 bot 暂无长期记忆</div>
        ) : (
          list.map((m) => (
            <button
              key={m.file}
              onClick={() => openFile(m.file)}
              className={`block w-full border-b border-zinc-50 px-3 py-2 text-left text-xs hover:bg-zinc-50 ${sel === m.file ? 'bg-blue-50' : ''}`}
            >
              <div className="flex items-center gap-1">
                <span className="truncate font-medium text-zinc-700">{m.name}</span>
                <span className="ml-auto rounded bg-zinc-100 px-1 text-[9px] text-zinc-500">{m.type}</span>
              </div>
              <div className="mt-0.5 truncate text-[10px] text-zinc-400">{m.description}</div>
            </button>
          ))
        )}
      </div>
      <div className="flex-1 min-w-0">
        {sel ? (
          <pre className="overflow-auto rounded border border-zinc-200 bg-white p-4 text-xs text-zinc-800" style={{ maxHeight: '70vh' }}>
            {content}
          </pre>
        ) : indexText ? (
          <div>
            <div className="mb-2 text-xs text-zinc-400">MEMORY.md 索引（点左侧条目看详情）</div>
            <pre className="overflow-auto rounded border border-zinc-200 bg-white p-4 text-xs text-zinc-700" style={{ maxHeight: '70vh' }}>
              {indexText}
            </pre>
          </div>
        ) : (
          <Empty text="选择一条记忆查看内容" />
        )}
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="rounded border border-dashed border-zinc-200 bg-white p-8 text-center text-sm text-zinc-400">{text}</div>;
}
