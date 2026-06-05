'use client';

// 日志系统视图（监控页「日志」tab）：原始运行日志的实时尾随 + 历史游标分页 + level/source/关键词过滤。
// 仿 bot 详情页 MessagesView 的「去重合并 + 粘底 + 加载更早」套路；实时流经 useLogStream，
// 洪峰下用 100ms 批量 setState 避免渲染风暴。等宽字体单行，点击展开全文。

import { useCallback, useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { LogEntry, LogLevel, LogSource, LogCursor } from '@hivemind/shared';
import { logsApi } from '@/lib/api';
import { useLogStream } from '@/lib/use-log-stream';
import { fmtClock } from '@/lib/observ-ui';
import { Button, EmptyState, Skeleton, useConfirm, useToast } from '@/components/ui';

const MAX_ENTRIES = 5000; // 内存上限（超出丢最旧），防实时流无界增长
const FETCH_LIMIT = 100;

const LEVELS: { value: '' | LogLevel; label: string }[] = [
  { value: '', label: '全部级别' },
  { value: 'debug', label: 'DEBUG' },
  { value: 'info', label: 'INFO' },
  { value: 'warn', label: 'WARN' },
  { value: 'error', label: 'ERROR' },
];
const SOURCES: { value: '' | LogSource; label: string }[] = [
  { value: '', label: '全部来源' },
  { value: 'orchestrator', label: 'orchestrator' },
  { value: 'dashboard', label: 'dashboard' },
  { value: 'launcher', label: 'launcher' },
];

const LEVEL_STYLE: Record<LogLevel, string> = {
  debug: 'bg-bg-subtle text-fg-muted',
  info: 'bg-info-soft text-info-fg',
  warn: 'bg-warning-soft text-warning-fg',
  error: 'bg-danger-soft text-danger-fg',
};
const SOURCE_STYLE: Record<LogSource, string> = {
  orchestrator: 'bg-primary-soft text-primary',
  dashboard: 'bg-info-soft text-info-fg',
  launcher: 'bg-bg-subtle text-fg-muted',
};

const selectCls =
  'rounded border border-border bg-bg-card px-2 py-1 text-xs text-fg focus:border-border-strong focus:outline-none';

export function LogsView() {
  const [entries, setEntries] = useState<LogEntry[]>([]); // 升序（旧→新）
  const [olderCursor, setOlderCursor] = useState<LogCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [level, setLevel] = useState<'' | LogLevel>('');
  const [source, setSource] = useState<'' | LogSource>('');
  const [q, setQ] = useState('');
  const [qDebounced, setQDebounced] = useState('');

  const confirm = useConfirm();
  const { toast } = useToast();

  const seen = useRef<Set<string>>(new Set());
  const pending = useRef<LogEntry[]>([]); // 实时流缓冲，100ms 批量 flush
  const stickBottom = useRef(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const qRef = useRef('');
  qRef.current = qDebounced;

  // 去重 + 升序合并 + 上限裁剪。fetch 历史与实时流都走这里。
  const addEntries = useCallback((list: LogEntry[], stick = true) => {
    const fresh = list.filter((e) => !seen.current.has(e.id));
    if (fresh.length === 0) return;
    for (const e of fresh) seen.current.add(e.id);
    stickBottom.current = stick;
    setEntries((prev) => {
      const merged = [...prev, ...fresh].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (merged.length > MAX_ENTRIES) {
        const drop = merged.slice(0, merged.length - MAX_ENTRIES);
        for (const e of drop) seen.current.delete(e.id);
        return merged.slice(merged.length - MAX_ENTRIES);
      }
      return merged;
    });
  }, []);

  // 关键词去抖（仅驱动历史拉取；实时流的关键词过滤在 onLog 里本地做）。
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  // 过滤条件变 → 清空重新拉历史。
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    seen.current.clear();
    pending.current = [];
    setEntries([]);
    stickBottom.current = true;
    logsApi
      .list({ level: level || undefined, source: source || undefined, q: qDebounced || undefined, limit: FETCH_LIMIT })
      .then((p) => {
        if (!alive) return;
        addEntries([...p.items].reverse()); // 接口 DESC → 反转为升序
        setOlderCursor(p.nextCursor);
      })
      .catch((e) => alive && setErr((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [level, source, qDebounced, addEntries]);

  // 实时流：level/source 服务端过滤（变了重连）；关键词本地过滤（不重连）。
  const onLog = useCallback((entry: LogEntry) => {
    const needle = qRef.current.toLowerCase();
    if (needle && !(entry.message + ' ' + (entry.tag ?? '')).toLowerCase().includes(needle)) return;
    pending.current.push(entry);
  }, []);
  useLogStream({ level: level || undefined, source: source || undefined }, onLog);

  // 100ms 批量把缓冲并入列表，避免每条日志一次 setState。
  useEffect(() => {
    const t = setInterval(() => {
      if (pending.current.length === 0) return;
      const batch = pending.current;
      pending.current = [];
      addEntries(batch);
    }, 100);
    return () => clearInterval(t);
  }, [addEntries]);

  // 提交后粘底（仅初始/实时新增时滚底；加载更早不滚）。
  useEffect(() => {
    if (stickBottom.current) {
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      bottomRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
    }
  }, [entries]);

  const loadOlder = async () => {
    if (olderCursor == null) return;
    try {
      const p = await logsApi.list({
        level: level || undefined,
        source: source || undefined,
        q: qDebounced || undefined,
        before: olderCursor.ts,
        beforeId: olderCursor.id,
        limit: FETCH_LIMIT,
      });
      addEntries([...p.items].reverse(), false); // 插到顶部，不滚底
      setOlderCursor(p.nextCursor);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const clearAll = async () => {
    const ok = await confirm({
      title: '清空全部日志？',
      description: '将删除已落库的全部运行日志（内存缓冲也清空），不可撤销。',
      confirmText: '清空',
      danger: true,
    });
    if (!ok) return;
    try {
      await logsApi.clear();
      seen.current.clear();
      pending.current = [];
      setEntries([]);
      setOlderCursor(null);
      toast('已清空日志');
    } catch (e) {
      toast(`清空失败：${(e as Error).message}`, { tone: 'danger' });
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectCls} value={level} onChange={(e) => setLevel(e.target.value as '' | LogLevel)}>
          {LEVELS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select className={selectCls} value={source} onChange={(e) => setSource(e.target.value as '' | LogSource)}>
          {SOURCES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索日志内容…"
          className={`${selectCls} min-w-[180px] flex-1`}
        />
        <span className="text-[11px] text-fg-subtle">{entries.length} 条</span>
        <Button size="sm" variant="ghost" leftIcon={<Trash2 className="size-3.5" />} onClick={clearAll}>
          清空
        </Button>
      </div>

      {err && <div className="rounded bg-danger-soft p-3 text-sm text-danger-fg">{err}（orchestrator 在跑吗？:3001）</div>}

      <div className="flex h-[68vh] flex-col rounded-lg border border-border bg-bg-card">
        <div className="flex-1 overflow-y-auto p-2 font-mono text-[12px] leading-relaxed">
          {olderCursor != null && !loading && (
            <button
              onClick={loadOlder}
              className="mx-auto mb-2 block rounded border border-border px-3 py-1 text-xs text-fg-muted hover:bg-bg-hover"
            >
              ↑ 加载更早
            </button>
          )}
          {loading ? (
            <div className="space-y-1.5 p-2">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-5 rounded" />
              ))}
            </div>
          ) : entries.length === 0 ? (
            <EmptyState title="暂无日志" description="还没有匹配的运行日志。orchestrator 一有输出即会实时出现在这里。" />
          ) : (
            entries.map((e) => <LogRow key={e.id} entry={e} />)
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      onClick={() => setOpen((o) => !o)}
      className="flex w-full items-start gap-2 rounded px-2 py-0.5 text-left hover:bg-bg-hover"
    >
      <span className="shrink-0 tabular-nums text-fg-subtle">{fmtClock(entry.ts)}</span>
      <span className={`shrink-0 rounded px-1 text-[10px] font-medium uppercase ${LEVEL_STYLE[entry.level]}`}>
        {entry.level}
      </span>
      <span className={`shrink-0 rounded px-1 text-[10px] ${SOURCE_STYLE[entry.source]}`}>{entry.source}</span>
      {entry.tag && <span className="shrink-0 text-[10px] text-fg-subtle">[{entry.tag}]</span>}
      <span className={`min-w-0 flex-1 text-fg ${open ? 'whitespace-pre-wrap break-words' : 'truncate'}`}>
        {entry.message}
      </span>
    </button>
  );
}
