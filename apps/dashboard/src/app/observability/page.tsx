'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Activity, ScrollText } from 'lucide-react';
import type { LiveOverview } from '@hivemind/shared';
import { observApi } from '@/lib/api';
import { fmtAgo } from '@/lib/observ-ui';
import { Button, EmptyState, PageContainer, PageHeader, Skeleton, StatusPill, Tabs, useConfirm, useTabs } from '@/components/ui';
import { listEq } from '@/lib/shallow-eq';
import { LogsView } from '@/components/observ/LogsView';

const TABS = [
  { key: 'overview', label: '概览', icon: Activity },
  { key: 'logs', label: '日志', icon: ScrollText },
];

export default function ObservabilityPage() {
  const { value, tabProps } = useTabs(TABS, { defaultKey: 'overview', queryKey: 'tab' });

  return (
    <PageContainer size="wide">
      <PageHeader
        title="监控"
        subtitle="各 bot 运行状态与活动量 · 原始运行日志实时流"
      />
      <Tabs {...tabProps} className="mb-4" />
      {value === 'overview' ? <OverviewTab /> : <LogsView />}
    </PageContainer>
  );
}

// ============================================================
// 概览 tab：各 bot 运行状态与活动量网格（每 3 秒轮询 + listEq 短路）
// ============================================================
function OverviewTab() {
  const [data, setData] = useState<LiveOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [purging, setPurging] = useState(false);
  const [purgeMsg, setPurgeMsg] = useState<string | null>(null);
  const confirm = useConfirm();
  const prevRef = useRef<LiveOverview | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const d = await observApi.liveOverview();
        if (!alive) return;
        // 内容相等短路：排除 lastActiveAt 秒级抖动（按分钟取整），并把 now 解耦到只在真变时更新
        const prev = prevRef.current;
        const same =
          prev &&
          listEq(prev.bots, d.bots, (b) => [
            b.botId,
            b.status,
            b.sessions,
            b.runs,
            b.runningRuns,
            b.errorMessage ?? '',
            Math.floor((b.lastActiveAt ?? 0) / 60000),
          ]);
        if (!same) {
          prevRef.current = d;
          setData(d);
          setNow(Date.now());
        }
        setErr(null);
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    };
    refresh();
    const t = setInterval(refresh, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const bots = data?.bots ?? [];

  const runRetention = async () => {
    const ok = await confirm({
      title: '立即清理过期数据？',
      description: '按配置的保留天数清理：早于保留期的会话及其消息 / 回合 / 事件将被删除，不可撤销。',
      confirmText: '清理',
      danger: true,
    });
    if (!ok) return;
    setPurging(true);
    setPurgeMsg(null);
    try {
      const r = await observApi.runRetention();
      setPurgeMsg(r.days > 0 ? `已清理 ${r.sessions} 个过期会话（保留 ${r.days} 天）` : '自动清理已关闭（保留天数为 0），未删除任何数据');
    } catch (e) {
      setPurgeMsg(`清理失败：${(e as Error).message}`);
    } finally {
      setPurging(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-3">
        {purgeMsg && <span className="text-xs text-fg-muted">{purgeMsg}</span>}
        <Button size="sm" onClick={runRetention} loading={purging} title="按 OBSERV_RETENTION_DAYS 删除过期会话">
          {purging ? '清理中…' : '清理过期数据'}
        </Button>
      </div>

      {err && <div className="rounded bg-danger-soft p-3 text-sm text-danger-fg">{err}（orchestrator 在跑吗？:3001）</div>}

      {!data ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-40 rounded-lg" />
          ))}
        </div>
      ) : bots.length === 0 ? (
        <EmptyState
          title="还没有 bot"
          description={
            <>
              去{' '}
              <Link href="/bots" className="text-primary-strong underline">
                Bots
              </Link>{' '}
              创建一个。
            </>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {bots.map((b) => (
            <Link
              key={b.botId}
              href={`/bots/${b.botId}`}
              className="group block rounded-lg border border-border bg-bg-card p-4 transition-colors duration-fast hover:border-border-strong"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-semibold text-fg">{b.name}</span>
                <StatusPill kind="bot" status={b.status} className="shrink-0" />
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <Stat label="会话" value={b.sessions} />
                <Stat label="回合" value={b.runs} />
                <Stat label="进行中" value={b.runningRuns} highlight={b.runningRuns > 0} />
              </div>
              <div className="mt-3 flex items-center justify-between text-[11px] text-fg-subtle">
                <span>{b.lastActiveAt ? `最近活跃：${fmtAgo(b.lastActiveAt, now || Date.now())}` : '暂无活动'}</span>
                <span className="flex items-center gap-0.5 text-primary opacity-0 transition-opacity group-hover:opacity-100">
                  查看详情 <ArrowRight className="size-3" />
                </span>
              </div>
              {b.errorMessage && (
                <div className="mt-2 truncate rounded bg-danger-soft px-2 py-1 text-[11px] text-danger-fg" title={b.errorMessage}>
                  ⚠️ {b.errorMessage}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className="rounded bg-bg-subtle py-2">
      <div className={`text-lg font-semibold ${highlight ? 'text-primary-strong' : 'text-fg'}`}>{value}</div>
      <div className="text-[10px] text-fg-subtle">{label}</div>
    </div>
  );
}
