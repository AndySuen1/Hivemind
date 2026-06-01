'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { LiveOverview } from '@discord-agent-hub/shared';
import { observApi } from '@/lib/api';
import { BOT_STATUS_COLOR, fmtAgo } from '@/lib/observ-ui';

export default function ObservabilityPage() {
  const [data, setData] = useState<LiveOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [purging, setPurging] = useState(false);
  const [purgeMsg, setPurgeMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const d = await observApi.liveOverview();
        if (alive) {
          setData(d);
          setNow(Date.now());
          setErr(null);
        }
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
    if (!window.confirm('立即按配置的保留天数清理过期会话？早于保留期的会话及其消息 / 回合 / 事件将被删除，不可撤销。')) return;
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
    <div className="max-w-5xl">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="text-2xl font-bold">可观测 · Live 总览</h2>
        <div className="flex items-center gap-3">
          {purgeMsg && <span className="text-xs text-zinc-500">{purgeMsg}</span>}
          <button
            onClick={runRetention}
            disabled={purging}
            title="按 OBSERV_RETENTION_DAYS 删除过期会话"
            className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50 disabled:opacity-50"
          >
            {purging ? '清理中…' : '清理过期数据'}
          </button>
          <span className="text-xs text-zinc-400">每 3 秒刷新</span>
        </div>
      </div>
      <p className="mb-6 text-sm text-zinc-500">各 bot 的运行状态与活动量。点卡片进入详情，查看聊天 / 执行追踪 / 记忆。</p>

      {err && <div className="mb-4 rounded bg-red-50 p-3 text-sm text-red-700">{err}（orchestrator 在跑吗？:3001）</div>}

      {!data ? (
        <div className="text-zinc-500">加载中…</div>
      ) : bots.length === 0 ? (
        <div className="rounded border border-dashed border-zinc-300 bg-white p-8 text-center text-zinc-500">
          还没有 bot。去 <Link href="/bots" className="text-blue-600 underline">Bots</Link> 创建一个。
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {bots.map((b) => (
            <Link
              key={b.botId}
              href={`/bots/${b.botId}`}
              className="block rounded border border-zinc-200 bg-white p-4 transition hover:border-blue-300 hover:shadow-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-semibold">{b.name}</span>
                <span className={`shrink-0 rounded px-2 py-0.5 text-xs ${BOT_STATUS_COLOR[b.status]}`}>{b.status}</span>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <Stat label="会话" value={b.sessions} />
                <Stat label="回合" value={b.runs} />
                <Stat label="进行中" value={b.runningRuns} highlight={b.runningRuns > 0} />
              </div>
              <div className="mt-3 text-[11px] text-zinc-400">
                {b.lastActiveAt ? `最近活跃：${fmtAgo(b.lastActiveAt, now || Date.now())}` : '暂无活动'}
              </div>
              {b.errorMessage && (
                <div className="mt-2 truncate rounded bg-red-50 px-2 py-1 text-[11px] text-red-700" title={b.errorMessage}>
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
    <div className="rounded bg-zinc-50 py-2">
      <div className={`text-lg font-semibold ${highlight ? 'text-blue-600' : 'text-zinc-800'}`}>{value}</div>
      <div className="text-[10px] text-zinc-400">{label}</div>
    </div>
  );
}
