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
} from '@hivemind/shared';
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
import {
  Button,
  ListPanel,
  PageContainer,
  PageHeader,
  Skeleton,
  Tabs,
  useConfirm,
  useTabs,
  useToast,
  type TabItem,
} from '@/components/ui';
import { listEq } from '@/lib/shallow-eq';
import { Activity, Brain, ListTree, MessageSquare, Trash2 } from 'lucide-react';

const TABS: TabItem[] = [
  { key: 'live', label: '实时', icon: Activity },
  { key: 'chat', label: '聊天', icon: MessageSquare },
  { key: 'trace', label: '执行追踪', icon: ListTree },
  { key: 'memory', label: '记忆', icon: Brain },
];

export default function BotDetailPage({ params }: { params: { id: string } }) {
  const botId = params.id;
  const { value: tab, tabProps } = useTabs(TABS, { defaultKey: 'live', queryKey: 'tab' });
  const [bot, setBot] = useState<BotWithRuntime | null>(null);
  // 清空全部历史后自增：作为各 tab 的 key，强制重挂以清掉其内部缓存的会话/回合/feed 选择。
  const [reloadKey, setReloadKey] = useState(0);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const confirm = useConfirm();

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      botsApi
        .get(botId)
        .then((b) => {
          if (!alive) return;
          // 内容相等短路：3s 轮询只关心运行态变化，避免无谓重渲染
          setBot((prev) =>
            prev &&
            prev.runtime.status === b.runtime.status &&
            prev.runtime.errorMessage === b.runtime.errorMessage &&
            prev.enabled === b.enabled
              ? prev
              : b,
          );
        })
        .catch(() => {});
    refresh();
    const t = setInterval(refresh, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [botId]);

  const clearAll = async () => {
    const ok = await confirm({
      title: `清空 bot「${bot?.name ?? botId}」的全部历史？`,
      description: '全部会话 / 回合 / 消息 / 事件将被删除，此操作不可撤销。',
      confirmText: '清空',
      danger: true,
    });
    if (!ok) return;
    setActionErr(null);
    try {
      await observApi.deleteBotHistory(botId);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setActionErr((e as Error).message);
    }
  };

  return (
    <PageContainer size="wide">
      <PageHeader
        breadcrumb={
          <>
            <Link href="/observability" className="hover:underline">
              监控
            </Link>{' '}
            / bot
          </>
        }
        title={bot ? bot.name : <Skeleton className="h-8 w-48" />}
        actions={
          <>
            {bot && (
              <span className={`rounded px-2 py-0.5 text-xs ${BOT_STATUS_COLOR[bot.runtime.status]}`}>
                {bot.runtime.status}
              </span>
            )}
            <code className="text-[10px] text-fg-subtle">{botId}</code>
            <Button
              variant="danger"
              size="sm"
              leftIcon={<Trash2 className="size-4" />}
              onClick={clearAll}
              title="删除该 bot 的全部监控历史（会话 / 回合 / 消息 / 事件）"
            >
              清空全部历史
            </Button>
          </>
        }
      />
      {actionErr && <div className="mb-3 rounded bg-danger-soft p-2 text-xs text-danger-fg">清空失败：{actionErr}</div>}

      <Tabs {...tabProps} className="mb-4" />

      {tab === 'live' && <LiveTab key={reloadKey} botId={botId} />}
      {tab === 'chat' && <ChatTab key={reloadKey} botId={botId} />}
      {tab === 'trace' && <TraceTab key={reloadKey} botId={botId} />}
      {tab === 'memory' && <MemoryTab botId={botId} />}
    </PageContainer>
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
  const confirm = useConfirm();
  const { toast } = useToast();

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const p = await observApi.sessions(botId, { limit: 100 });
        if (alive)
          setSessions((prev) =>
            listEq(prev, p.items, (s) => [s.id, s.title ?? '', s.channelName ?? '', Math.floor(s.lastActiveAt / 60000)])
              ? prev
              : p.items,
          );
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
    const ok = await confirm({
      title: `清空会话「${s.title || s.channelName || s.channelId}」？`,
      description: '该会话的全部消息 / 回合 / 事件将被删除，不可撤销。',
      confirmText: '清空',
      danger: true,
    });
    if (!ok) return;
    try {
      await observApi.deleteSession(s.id);
      setSessions((prev) => prev.filter((x) => x.id !== s.id));
      onDeleted?.(s.id);
    } catch (e) {
      toast(`删除失败：${(e as Error).message}`, { tone: 'danger' });
    }
  };

  return (
    <ListPanel title="会话" count={sessions.length} className="w-full lg:w-60">
      {loading ? (
        <div className="space-y-1 p-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-11 rounded" />
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <div className="p-3 text-xs text-fg-subtle">暂无会话</div>
      ) : (
        sessions.map((s) => (
          <div
            key={s.id}
            className={`group flex items-stretch border-b border-border ${selectedId === s.id ? 'bg-primary-soft' : ''}`}
          >
            <button onClick={() => onSelect(s)} className="min-w-0 flex-1 px-3 py-2 text-left text-xs hover:bg-bg-hover">
              <div className="truncate font-medium text-fg">{s.title || s.channelName || s.channelId}</div>
              <div className="mt-0.5 flex items-center justify-between text-[10px] text-fg-subtle">
                <span>{s.channelType ?? '?'}</span>
                <span>{fmtTime(s.lastActiveAt)}</span>
              </div>
            </button>
            <button
              onClick={() => handleDelete(s)}
              title="清空此会话"
              className="px-2 text-fg-subtle opacity-0 transition group-hover:opacity-100 hover:text-danger"
            >
              ✕
            </button>
          </div>
        ))
      )}
    </ListPanel>
  );
}

// ============================================================
// 聊天 tab
// ============================================================
function ChatTab({ botId }: { botId: string }) {
  const [session, setSession] = useState<ObservSession | null>(null);
  return (
    <div className="flex flex-col gap-3 lg:flex-row">
      <SessionList
        botId={botId}
        selectedId={session?.id ?? null}
        onSelect={setSession}
        onDeleted={(id) => setSession((cur) => (cur?.id === id ? null : cur))}
      />
      <div className="min-w-0 flex-1">
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
  // SSE 进场：独立 animatedIds(render 只读、effect 标记，StrictMode 安全)+ ready(首屏历史不播)
  const animatedIds = useRef<Set<string>>(new Set());
  const ready = useRef(false);

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
        for (const m of p.items) animatedIds.current.add(m.id); // 首屏历史不播进场
        ready.current = true;
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
    if (stickBottom.current) {
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      bottomRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
    }
    for (const m of msgs) animatedIds.current.add(m.id); // 提交后标记，下次不再播
  }, [msgs]);

  const loadOlder = async () => {
    if (olderCursor == null) return;
    try {
      const p = await observApi.messages(sessionId, { before: olderCursor.ts, beforeId: olderCursor.id, limit: 50 });
      for (const m of p.items) animatedIds.current.add(m.id); // 加载更早的历史不播进场
      addMessages([...p.items].reverse(), false); // 历史插到顶部，不触发滚底
      setOlderCursor(p.nextCursor);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="flex h-[60vh] flex-col rounded border border-border bg-bg-card lg:h-panel">
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {olderCursor != null && (
          <button onClick={loadOlder} className="mx-auto block rounded border border-border px-3 py-1 text-xs text-fg-muted hover:bg-bg-hover">
            ↑ 加载更早
          </button>
        )}
        {loading ? (
          <div className="space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className={`flex ${i % 2 === 0 ? 'justify-end' : 'justify-start'}`}>
                <Skeleton className="h-12 w-[60%] rounded-lg" />
              </div>
            ))}
          </div>
        ) : err ? (
          <div className="p-3 text-xs text-danger">{err}</div>
        ) : msgs.length === 0 ? (
          <Empty text="暂无消息" />
        ) : null}
        {!loading &&
          msgs.map((m) => {
            const fresh = ready.current && !animatedIds.current.has(m.id);
            return (
              <div
                key={m.id}
                className={`${fresh ? 'animate-slide-up-in ' : ''}flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${m.role === 'user' ? 'bg-primary-strong text-white' : 'bg-bg-subtle text-fg'}`}
                >
                  <div className={`mb-0.5 text-[10px] ${m.role === 'user' ? 'text-primary-fg' : 'text-fg-subtle'}`}>
                    {m.role === 'user' ? m.authorName || '用户' : '助手'} · {fmtClock(m.createdAt)}
                    {m.truncated && ' · 已截断'}
                  </div>
                  <div className="whitespace-pre-wrap break-words">{m.content}</div>
                </div>
              </div>
            );
          })}
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
    <div className="flex flex-col gap-3 lg:flex-row">
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
        <div className="flex-1">
          <Empty text="选择一个会话" />
        </div>
      )}
      <div className="min-w-0 flex-1">
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
  const animatedIds = useRef<Set<string>>(new Set());
  const ready = useRef(false);

  const apply = useCallback((list: ObservRun[]) => {
    for (const r of list) byId.current.set(r.id, r);
    setRuns([...byId.current.values()].sort((a, b) => b.startedAt - a.startedAt));
  }, []);

  useEffect(() => {
    let alive = true;
    byId.current = new Map();
    animatedIds.current = new Set();
    ready.current = false;
    setRuns([]);
    setLoading(true);
    setErr(null);
    observApi
      .runs(sessionId, { limit: 50 })
      .then((p) => {
        if (!alive) return;
        for (const r of p.items) animatedIds.current.add(r.id); // 首屏历史不播进场
        apply(p.items);
        ready.current = true;
      })
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

  // 提交后标记已见（同一 run 状态更新不重播；新 run 才播）
  useEffect(() => {
    for (const r of runs) animatedIds.current.add(r.id);
  }, [runs]);

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
    <ListPanel title="回合" count={runs.length} className="w-full lg:w-56">
      {loading ? (
        <div className="space-y-1 p-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 rounded" />
          ))}
        </div>
      ) : err ? (
        <div className="p-3 text-xs text-danger">{err}</div>
      ) : runs.length === 0 ? (
        <div className="p-3 text-xs text-fg-subtle">暂无回合</div>
      ) : (
        runs.map((r) => {
          const fresh = ready.current && !animatedIds.current.has(r.id);
          return (
            <div key={r.id} className={fresh ? 'animate-enter-row' : ''}>
              <button
                onClick={() => onSelect(r)}
                className={`block w-full border-b border-border px-3 py-2 text-left text-xs hover:bg-bg-hover ${
                  selectedRunId === r.id ? 'bg-primary-soft' : ''
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] ${runStatusColor(r.status)}`}>{runStatusLabel(r.status)}</span>
                  <span className="text-[10px] text-fg-subtle">{fmtClock(r.startedAt)}</span>
                </div>
                <div className="mt-1 text-[10px] text-fg-subtle">
                  {r.toolCallCount} 个工具{r.usage?.totalTokens != null ? ` · ${r.usage.totalTokens} tok` : ''}
                </div>
              </button>
            </div>
          );
        })
      )}
    </ListPanel>
  );
}

function EventsTimeline({ run }: { run: ObservRun }) {
  const [events, setEvents] = useState<ObservEvent[]>([]); // 升序 seq
  const [after, setAfter] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const seen = useRef<Set<string>>(new Set());
  const animatedIds = useRef<Set<string>>(new Set());
  const ready = useRef(false);

  const addAsc = useCallback((list: ObservEvent[]) => {
    const fresh = list.filter((e) => !seen.current.has(e.id));
    if (fresh.length === 0) return;
    for (const e of fresh) seen.current.add(e.id);
    setEvents((prev) => [...prev, ...fresh].sort((a, b) => a.seq - b.seq));
  }, []);

  useEffect(() => {
    let alive = true;
    seen.current = new Set();
    animatedIds.current = new Set();
    ready.current = false;
    setEvents([]);
    setLoading(true);
    setErr(null);
    observApi
      .events(run.id, { limit: 200 })
      .then((p) => {
        if (!alive) return;
        for (const e of p.items) animatedIds.current.add(e.id); // 首屏历史不播进场
        addAsc(p.items);
        setAfter(p.nextCursor);
        ready.current = true;
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

  // 提交后标记已见
  useEffect(() => {
    for (const e of events) animatedIds.current.add(e.id);
  }, [events]);

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
      for (const e of p.items) animatedIds.current.add(e.id); // 加载更多历史不播
      addAsc(p.items);
      setAfter(p.nextCursor);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="max-h-panel overflow-y-auto rounded border border-border bg-bg-card p-3">
      <div className="mb-2 flex items-center gap-2 border-b border-border pb-2 text-xs text-fg-muted">
        <span className={`rounded px-1.5 py-0.5 ${runStatusColor(run.status)}`}>{runStatusLabel(run.status)}</span>
        <span>{run.toolCallCount} 个工具调用</span>
        {run.finishReason && <span>· {run.finishReason}</span>}
        {run.usage?.totalTokens != null && <span>· {run.usage.totalTokens} tokens</span>}
        {run.error && <span className="text-danger">· {run.error}</span>}
      </div>
      {loading ? (
        <div className="space-y-1.5">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-7 rounded" />
          ))}
        </div>
      ) : err ? (
        <div className="p-3 text-xs text-danger">{err}</div>
      ) : topLevel.length === 0 ? (
        <Empty text="本回合暂无事件（纯对话、无工具调用）" />
      ) : (
        <div className="space-y-1">
          {topLevel.map((e) => {
            const fresh = ready.current && !animatedIds.current.has(e.id);
            return (
              <div key={e.id} className={fresh ? 'animate-enter-row rounded' : ''}>
                {e.type === 'delegate_start' ? (
                  <DelegateGroup start={e} children={childrenOf.get(e.id) ?? []} />
                ) : (
                  <EventRow event={e} />
                )}
              </div>
            );
          })}
        </div>
      )}
      {after != null && (
        <button onClick={loadMore} className="mt-2 block w-full rounded border border-border px-3 py-1 text-xs text-fg-muted hover:bg-bg-hover">
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
    <div className="rounded border border-info/30 bg-info-soft/40">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs">
        <span className="text-[10px] text-fg-subtle">{fmtClock(start.createdAt)}</span>
        <span>{meta.icon}</span>
        <span className="font-medium text-info-fg">委派 Claude Code</span>
        <span className="text-fg-muted">（{children.filter((c) => c.type === 'delegate_step').length} 步{out.costUsd != null ? ` · ~$${out.costUsd.toFixed(3)}` : ''}）</span>
        {end && <span className={`ml-auto h-2 w-2 rounded-full ${statusDotColor(end.status)}`} title={end.status} />}
        <span className="text-fg-subtle">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="space-y-1 border-t border-info/30 px-2 py-1.5">
          {children
            .slice()
            .sort((a, b) => a.seq - b.seq)
            .map((c) => (
              <EventRow key={c.id} event={c} nested />
            ))}
          {steps === 0 && <div className="text-[11px] text-fg-subtle">（无步骤记录）</div>}
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
        className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs ${hasDetail ? 'hover:bg-bg-hover' : 'cursor-default'}`}
      >
        <span className="text-[10px] text-fg-subtle">{fmtClock(event.createdAt)}</span>
        <span>{meta.icon}</span>
        <span className={`font-medium ${meta.color}`}>{event.label || meta.label}</span>
        {event.toolName && <code className="rounded bg-bg-subtle px-1 text-[10px] text-fg">{event.toolName}</code>}
        {event.status && <span className={`h-2 w-2 rounded-full ${statusDotColor(event.status)}`} title={event.status} />}
        {event.durationMs != null && <span className="text-[10px] text-fg-subtle">{fmtDuration(event.durationMs)}</span>}
        {hasDetail && <span className="ml-auto text-fg-subtle">{open ? '▾' : '▸'}</span>}
      </button>
      {open && hasDetail && (
        <div className="ml-6 mb-1 space-y-1">
          {event.input !== undefined && (
            <pre className="overflow-x-auto rounded bg-bg-subtle p-2 text-[11px] text-fg">入参 {preview(event.input)}</pre>
          )}
          {event.output !== undefined && (
            <pre className="overflow-x-auto rounded bg-bg-subtle p-2 text-[11px] text-fg">出参 {preview(event.output)}</pre>
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
  const animatedKeys = useRef<Set<number>>(new Set());
  const onRec = useCallback((rec: ObservRecord) => {
    setFeed((prev) => [{ key: counter.current++, rec }, ...prev].slice(0, 300));
  }, []);
  useEventStream({ botId }, onRec);

  // 提交后标记：仅新前插的项播进场（纯 SSE 流，无首屏历史）
  useEffect(() => {
    for (const e of feed) animatedKeys.current.add(e.key);
  }, [feed]);

  return (
    <div className="rounded border border-border bg-bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <span className="text-sm font-medium text-fg">实时活动流</span>
        <span className="flex items-center gap-1.5 text-xs text-fg-subtle">
          <span className="h-2 w-2 animate-pulse rounded-full bg-success" /> 实时（SSE）
        </span>
      </div>
      <div className="max-h-panel overflow-y-auto p-2">
        {feed.length === 0 ? (
          <Empty text="等待活动…（在 Discord 给这个 bot 发消息试试）" />
        ) : (
          <div className="space-y-0.5">
            {feed.map((entry) => {
              const fresh = !animatedKeys.current.has(entry.key);
              return (
                <div key={entry.key} className={fresh ? 'animate-enter-row rounded' : ''}>
                  <LiveRow rec={entry.rec} />
                </div>
              );
            })}
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
    <div className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-bg-hover">
      <span className="text-[10px] text-fg-subtle">{fmtClock(ts)}</span>
      <span>{icon}</span>
      <span className="truncate text-fg">{line}</span>
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
    <div className="flex flex-col gap-3 lg:flex-row">
      <ListPanel title="记忆" count={list.length} subtitle="只读" className="w-full lg:w-64">
        {loading ? (
          <div className="space-y-1 p-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-12 rounded" />
            ))}
          </div>
        ) : err ? (
          <div className="p-3 text-xs text-danger">{err}</div>
        ) : list.length === 0 ? (
          <div className="p-3 text-xs text-fg-subtle">该 bot 暂无长期记忆</div>
        ) : (
          list.map((m) => (
            <button
              key={m.file}
              onClick={() => openFile(m.file)}
              className={`block w-full border-b border-border px-3 py-2 text-left text-xs hover:bg-bg-hover ${sel === m.file ? 'bg-primary-soft' : ''}`}
            >
              <div className="flex items-center gap-1">
                <span className="truncate font-medium text-fg">{m.name}</span>
                <span className="ml-auto rounded bg-bg-subtle px-1 text-[9px] text-fg-muted">{m.type}</span>
              </div>
              <div className="mt-0.5 truncate text-[10px] text-fg-subtle">{m.description}</div>
            </button>
          ))
        )}
      </ListPanel>
      <div className="min-w-0 flex-1">
        {sel ? (
          <pre className="max-h-panel overflow-auto rounded border border-border bg-bg-card p-4 text-xs text-fg">
            {content}
          </pre>
        ) : indexText ? (
          <div>
            <div className="mb-2 text-xs text-fg-subtle">MEMORY.md 索引（点左侧条目看详情）</div>
            <pre className="max-h-panel overflow-auto rounded border border-border bg-bg-card p-4 text-xs text-fg">
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
  return <div className="rounded border border-dashed border-border bg-bg-card p-8 text-center text-sm text-fg-subtle">{text}</div>;
}
