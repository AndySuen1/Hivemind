'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import type { BotRuntimeStatus, Provider } from '@hivemind/shared';
import { botsApi, providersApi, projectsApi, type BotWithRuntime, type ProjectWithMembers } from '@/lib/api';
import { Button, EmptyState, PageContainer, PageHeader, Select, Skeleton } from '@/components/ui';
import { listEq } from '@/lib/shallow-eq';
import { cn } from '@/lib/utils';
import { BotAvatar } from '@/components/bot/BotAvatar';
import { NewBotModal } from '@/components/bot/NewBotModal';

// 头像角标小圆点配色，按运行态（与 observ-ui 的 BOT_STATUS_COLOR 同义）。
const BOT_DOT: Record<BotRuntimeStatus, string> = {
  online: 'bg-success',
  connecting: 'bg-warning',
  offline: 'bg-fg-subtle',
  error: 'bg-danger',
};

export default function BotsPage() {
  const [bots, setBots] = useState<BotWithRuntime[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [projects, setProjects] = useState<ProjectWithMembers[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  // 项目筛选：'__all' 全部 · '__none' 未分组 · 其余为项目 id
  const [projectFilter, setProjectFilter] = useState('__all');

  const refresh = async () => {
    try {
      const [b, p, pr] = await Promise.all([botsApi.list(), providersApi.list(), projectsApi.list()]);
      // 内容相等短路：3s 轮询内容没变就不 setState，避免无谓重渲染/闪烁。
      // key 含 name/role/avatar，使详情页改了配置后网格能刷新。
      setBots((prev) =>
        listEq(prev, b, (x) => [
          x.id,
          x.runtime.status,
          x.enabled,
          x.runtime.errorMessage ?? '',
          x.projectId ?? '',
          x.name,
          x.role,
          x.avatar ?? '',
        ])
          ? prev
          : b,
      );
      setProviders((prev) => (listEq(prev, p, (x) => [x.id, x.name, x.model]) ? prev : p));
      setProjects((prev) => (listEq(prev, pr, (x) => [x.id, x.name]) ? prev : pr));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, []);

  const visibleBots = bots.filter((b) =>
    projectFilter === '__all'
      ? true
      : projectFilter === '__none'
        ? !b.projectId
        : b.projectId === projectFilter,
  );

  return (
    <PageContainer size="wide">
      <PageHeader
        title="Bots"
        subtitle="管理连接到 Discord 的 bot：头像、岗位、工具、技能与监控。"
        actions={
          <Button
            variant="primary"
            size="lg"
            leftIcon={<Plus className="size-[18px]" />}
            disabled={providers.length === 0}
            title={providers.length === 0 ? '请先创建至少一个 Provider' : ''}
            onClick={() => setShowNew(true)}
          >
            新建 Bot
          </Button>
        }
      />

      {err && <div className="mb-4 rounded bg-danger-soft p-3 text-sm text-danger-fg">{err}</div>}
      {providers.length === 0 && (
        <div className="mb-4 rounded bg-warning-soft p-3 text-sm text-warning-fg">
          ⚠️ 还没有 Provider，请先去{' '}
          <a href="/providers" className="underline">
            Providers
          </a>{' '}
          创建一个
        </div>
      )}

      {/* 项目筛选工具栏：有 bot 就显示（无项目时下拉仅「全部 / 未分组」） */}
      {!loading && bots.length > 0 && (
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <label htmlFor="proj-filter" className="text-sm font-medium text-fg-muted">
            项目筛选
          </label>
          <Select
            id="proj-filter"
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="h-10 w-52 rounded-lg"
          >
            <option value="__all">全部项目</option>
            <option value="__none">未分组</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <span className="text-sm text-fg-subtle">共 {visibleBots.length} 个</span>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-4">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex flex-col items-center gap-2.5 rounded-2xl bg-bg-hover p-3">
              <Skeleton className="aspect-square w-full rounded-xl" />
              <Skeleton className="h-4 w-2/3 rounded" />
            </div>
          ))}
        </div>
      ) : bots.length === 0 ? (
        <EmptyState
          title="还没有 bot"
          description="创建一个 bot 并启用，连接到 Discord。"
          action={
            <Button variant="primary" leftIcon={<Plus className="size-4" />} disabled={providers.length === 0} onClick={() => setShowNew(true)}>
              新建 Bot
            </Button>
          }
        />
      ) : visibleBots.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-fg-muted">
          该项目下暂无 bot。
          <button type="button" className="ml-1 text-primary-strong underline" onClick={() => setProjectFilter('__all')}>
            查看全部
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-4">
          {visibleBots.map((b) => (
            <Link
              key={b.id}
              href={`/bots/${b.id}`}
              className="group flex flex-col items-center gap-2.5 rounded-2xl bg-bg-hover p-3 text-center shadow-xs transition duration-fast hover:-translate-y-0.5 hover:shadow-md hover:ring-1 hover:ring-border-strong"
            >
              <div className="relative w-full">
                <BotAvatar name={b.name} avatar={b.avatar} id={b.id} fill rounded="xl" className="aspect-square w-full" />
                {/* 连接态绿点（在线=绿）取代「已启用」文字 */}
                <span
                  className={cn('absolute bottom-1.5 right-1.5 size-3.5 rounded-full ring-2 ring-bg-card', BOT_DOT[b.runtime.status])}
                  title={b.runtime.status}
                />
              </div>
              <div className="min-w-0 w-full">
                <div className="truncate text-sm font-medium text-fg">{b.name}</div>
                {b.role && <div className="truncate text-xs text-fg-muted">{b.role}</div>}
              </div>
            </Link>
          ))}
        </div>
      )}

      <NewBotModal open={showNew} providers={providers} projects={projects} onClose={() => setShowNew(false)} />
    </PageContainer>
  );
}
