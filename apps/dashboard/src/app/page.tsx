'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Activity, ArrowRight, ArrowUpRight, Bot, Boxes, Plus, Settings, type LucideIcon } from 'lucide-react';
import type { LiveOverview } from '@hivemind/shared';
import { observApi } from '@/lib/api';
import { fmtAgo } from '@/lib/observ-ui';
import { EmptyState, IconChip, PageContainer, StatusPill, type ChipTone } from '@/components/ui';

export default function Home() {
  const [data, setData] = useState<LiveOverview | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      observApi
        .liveOverview()
        .then((d) => {
          if (alive) {
            setData(d);
            setNow(Date.now());
          }
        })
        .catch(() => {});
    refresh();
    const t = setInterval(refresh, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const bots = data?.bots ?? [];
  const online = bots.filter((b) => b.status === 'online').length;
  const sessions = bots.reduce((a, b) => a + b.sessions, 0);
  const runs = bots.reduce((a, b) => a + b.runs, 0);
  const running = bots.reduce((a, b) => a + b.runningRuns, 0);
  const v = (n: number) => (data ? n.toLocaleString() : '—');

  return (
    <PageContainer size="wide" className="space-y-10">
      {/* —— Hero —— */}
      <section
        className="animate-slide-up-in relative overflow-hidden rounded-2xl border border-border [animation-fill-mode:both]"
        style={{
          background:
            'radial-gradient(135% 120% at 100% 0%, hsl(var(--info-soft)) 0%, transparent 56%),' +
            'radial-gradient(120% 120% at 0% 0%, hsl(var(--primary-soft)) 0%, transparent 52%),' +
            'hsl(var(--bg-card))',
        }}
      >
        <HiveMark className="pointer-events-none absolute -right-6 -top-10 h-64 w-72 text-fg/[0.04]" />
        <div className="relative p-8 md:p-9">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-fg-subtle">
            <span className="grid size-5 place-items-center rounded bg-fg text-[10px] font-bold text-bg">H</span>
            Hivemind 控制台
            {running > 0 && (
              <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium normal-case tracking-normal text-success-fg">
                <span className="size-1.5 animate-pulse rounded-full bg-success" />
                {running} 回合进行中
              </span>
            )}
          </div>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-fg md:text-4xl">欢迎回来</h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-fg-muted">
            DeepSeek 主脑负责对话与调度，遇到真正要写代码的活儿就委派 Claude 工人。
            在这里管理你的模型供应商、bot 与实时运行。
          </p>
          <div className="mt-6 flex flex-wrap gap-2.5">
            <Link
              href="/bots"
              className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-primary-strong px-4 text-sm font-medium text-primary-fg shadow-xs transition-all duration-fast ease-notion hover:bg-primary-hover active:scale-[0.98]"
            >
              <Plus className="size-4" strokeWidth={2.25} />
              新建 Bot
            </Link>
            <Link
              href="/observability"
              className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-border bg-bg-card/70 px-4 text-sm font-medium text-fg backdrop-blur-sm transition-all duration-fast ease-notion hover:bg-bg-card active:scale-[0.98]"
            >
              <Activity className="size-4" strokeWidth={2} />
              查看运行
            </Link>
          </div>

          {/* 内嵌统计：克制、内容前置，不另起一排卡片 */}
          <div className="mt-8 grid max-w-2xl grid-cols-2 gap-x-8 gap-y-5 border-t border-border/70 pt-6 sm:grid-cols-4">
            <HeroStat label="总 Bot 数" value={v(bots.length)} />
            <HeroStat label="在线" value={v(online)} accent={online > 0} />
            <HeroStat label="累计会话" value={v(sessions)} />
            <HeroStat label="累计回合" value={v(runs)} />
          </div>
        </div>
      </section>

      {/* —— 你的 Bots —— */}
      <section className="animate-slide-up-in [animation-delay:80ms] [animation-fill-mode:both]">
        <SectionLabel title="你的 Bots" hint={bots.length > 0 ? `${online} / ${bots.length} 在线` : undefined} href="/observability" linkText="全部运行" />
        {bots.length === 0 ? (
          <div className="rounded-xl border border-border bg-bg-card">
            <EmptyState
              icon={<Bot className="size-7" strokeWidth={1.5} />}
              title={data ? '还没有 Bot' : '加载中…'}
              description="先在 Providers 配一个模型供应商，再到 Bots 创建并启用一个 Discord bot。"
              action={
                <Link
                  href="/bots"
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary-strong px-3.5 text-sm font-medium text-primary-fg transition-colors hover:bg-primary-hover"
                >
                  <Plus className="size-4" strokeWidth={2.25} />
                  创建 Bot
                </Link>
              }
            />
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {bots.slice(0, 6).map((b) => (
              <Link
                key={b.botId}
                href={`/bots/${b.botId}`}
                className="group flex items-center gap-3.5 rounded-xl border border-border bg-bg-card p-4 transition-all duration-fast ease-notion hover:border-border-strong hover:shadow-sm"
              >
                <IconChip icon={Bot} tone="violet" className="size-10 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-fg">{b.name}</span>
                    <StatusPill kind="bot" status={b.status} className="shrink-0" />
                  </div>
                  <div className="mt-0.5 truncate text-xs text-fg-subtle">
                    {b.sessions} 会话 · {b.runs} 回合 · {b.lastActiveAt ? fmtAgo(b.lastActiveAt, now || Date.now()) : '暂无活动'}
                  </div>
                </div>
                <ArrowRight className="size-4 shrink-0 -translate-x-1 text-fg-subtle opacity-0 transition-all duration-fast group-hover:translate-x-0 group-hover:opacity-100" />
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* —— 快速开始 —— */}
      <section className="animate-slide-up-in [animation-delay:160ms] [animation-fill-mode:both]">
        <SectionLabel title="快速开始" hint="四步把一个 bot 跑起来" />
        <div className="grid gap-3 sm:grid-cols-2">
          <FeatureCard
            href="/providers"
            tone="violet"
            icon={Boxes}
            step="1"
            title="配置 Provider"
            desc="接入 DeepSeek 等 OpenAI 兼容模型。模型由 Provider 决定，想换模型就新建一个。"
          />
          <FeatureCard
            href="/bots"
            tone="blue"
            icon={Bot}
            step="2"
            title="创建 Bot"
            desc="填 Discord Token、挑 Provider、配人格与工具，启用即连上 Discord。"
          />
          <FeatureCard
            href="/observability"
            tone="green"
            icon={Activity}
            step="3"
            title="查看运行"
            desc="实时活动流、聊天记录与逐步执行追踪，掌握每个 bot 在干什么。"
          />
          <FeatureCard
            href="/settings"
            tone="amber"
            icon={Settings}
            step="4"
            title="系统设置"
            desc="端口、开机自启、服务启停，以及在机器间搬运配置的导出 / 导入。"
          />
        </div>
      </section>
    </PageContainer>
  );
}

function HeroStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className={`text-2xl font-semibold tracking-tight ${accent ? 'text-success-fg' : 'text-fg'}`}>{value}</div>
      <div className="mt-0.5 text-xs text-fg-muted">{label}</div>
    </div>
  );
}

function SectionLabel({
  title,
  hint,
  href,
  linkText,
}: {
  title: string;
  hint?: string;
  href?: string;
  linkText?: string;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-3">
      <div className="flex items-baseline gap-2.5">
        <h2 className="text-lg font-semibold tracking-tight text-fg">{title}</h2>
        {hint && <span className="text-xs text-fg-subtle">{hint}</span>}
      </div>
      {href && linkText && (
        <Link href={href} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
          {linkText} <ArrowRight className="size-3.5" />
        </Link>
      )}
    </div>
  );
}

const PANEL_GRADIENT: Record<ChipTone, string> = {
  violet: 'from-primary-soft via-primary-soft/40 to-bg-card text-primary-strong',
  blue: 'from-info-soft via-info-soft/40 to-bg-card text-info-fg',
  green: 'from-success-soft via-success-soft/40 to-bg-card text-success-fg',
  amber: 'from-warning-soft via-warning-soft/40 to-bg-card text-warning-fg',
  red: 'from-danger-soft via-danger-soft/40 to-bg-card text-danger-fg',
  gray: 'from-bg-subtle via-bg-subtle/40 to-bg-card text-fg-muted',
};

function FeatureCard({
  href,
  tone,
  icon: Icon,
  step,
  title,
  desc,
}: {
  href: string;
  tone: ChipTone;
  icon: LucideIcon;
  step: string;
  title: string;
  desc: string;
}) {
  return (
    <Link
      href={href}
      className="group flex overflow-hidden rounded-xl border border-border bg-bg-card transition-all duration-fast ease-notion hover:border-border-strong hover:shadow-md"
    >
      <div className={`relative grid w-24 shrink-0 place-items-center bg-gradient-to-br ${PANEL_GRADIENT[tone]}`}>
        <Icon className="size-7 transition-transform duration-200 ease-notion group-hover:scale-110" strokeWidth={1.75} />
        <span className="absolute left-2.5 top-2 text-[11px] font-semibold tabular-nums opacity-50">{step}</span>
      </div>
      <div className="min-w-0 flex-1 p-5">
        <div className="flex items-center gap-1.5">
          <h3 className="font-semibold text-fg">{title}</h3>
          <ArrowUpRight className="size-3.5 -translate-x-0.5 text-fg-subtle opacity-0 transition-all duration-fast group-hover:translate-x-0 group-hover:opacity-100" />
        </div>
        <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{desc}</p>
      </div>
    </Link>
  );
}

/** 蜂巢母题装饰：一簇点顶六边形，低不透明度铺在 Hero 角落。 */
function HiveMark({ className }: { className?: string }) {
  const hex = (cx: number, cy: number, r: number) => {
    const pts = [
      [0, -1],
      [0.866, -0.5],
      [0.866, 0.5],
      [0, 1],
      [-0.866, 0.5],
      [-0.866, -0.5],
    ]
      .map(([x, y]) => `${(cx + x * r).toFixed(1)},${(cy + y * r).toFixed(1)}`)
      .join(' ');
    return <polygon points={pts} fill="none" stroke="currentColor" strokeWidth={1.5} />;
  };
  const r = 30;
  const dx = 0.866 * r;
  const dy = 1.5 * r;
  return (
    <svg viewBox="0 0 220 200" className={className} aria-hidden="true">
      {hex(120, 55, r)}
      {hex(120 + 2 * dx, 55, r)}
      {hex(120 + dx, 55 + dy, r)}
      {hex(120 + 3 * dx, 55 + dy, r)}
      {hex(120 + 2 * dx, 55 + 2 * dy, r)}
    </svg>
  );
}
