'use client';

import { useEffect, useRef, useState } from 'react';
import {
  launcherApi,
  launcherAvailable,
  type LauncherSettings,
  type LauncherStatus,
  type ServiceState,
} from '@/lib/launcher-api';
import { configApi } from '@/lib/api';
import { Badge, Button, Card, Field, Input, PageContainer, PageHeader, SectionTitle, Skeleton } from '@/components/ui';

export default function SettingsPage() {
  const [available] = useState(launcherAvailable);
  const [settings, setSettings] = useState<LauncherSettings | null>(null);
  const [status, setStatus] = useState<LauncherStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // 表单本地态
  const [apiPort, setApiPort] = useState(3001);
  const [dashboardPort, setDashboardPort] = useState(3000);
  const [autoStartService, setAutoStartService] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const applyBundle = (s: LauncherSettings, st: LauncherStatus) => {
    setSettings(s);
    setStatus(st);
    setApiPort(s.apiPort);
    setDashboardPort(s.dashboardPort);
    setAutoStartService(s.autoStartService);
  };

  useEffect(() => {
    if (!available) {
      setLoading(false);
      return;
    }
    launcherApi
      .getSettings()
      .then((b) => applyBundle(b.settings, b.status))
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
  }, [available]);

  // 轮询服务状态（仅在启动器环境）
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!available) return;
    pollRef.current = setInterval(() => {
      launcherApi
        .getStatus()
        .then((st) => setStatus((prev) => (prev && JSON.stringify(prev) === JSON.stringify(st) ? prev : st)))
        .catch(() => {});
    }, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [available]);

  const portsChanged = settings && (apiPort !== settings.apiPort || dashboardPort !== settings.dashboardPort);
  const dashPortChanged = settings && dashboardPort !== settings.dashboardPort;

  const onSave = async () => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const b = await launcherApi.updateSettings({ apiPort, dashboardPort, autoStartService });
      applyBundle(b.settings, b.status);
      setMsg(
        dashPortChanged
          ? '✅ 已保存。dashboard 端口已更改，服务正在用新端口重启——请通过托盘「打开管理网站」重新进入。'
          : portsChanged
            ? '✅ 已保存，服务已用新端口重启。'
            : '✅ 已保存。',
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onToggleAutoLaunch = async () => {
    if (!status) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const b = await launcherApi.updateSettings({ openLoginItem: !status.autoLaunch });
      applyBundle(b.settings, b.status);
      setMsg('✅ 开机自启已更新');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const svcAction = async (fn: () => Promise<LauncherStatus>) => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      setStatus(await fn());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageContainer size="narrow">
      <PageHeader title="系统设置" subtitle="端口 / 开机自启 / 服务启停 / 配置迁移" />

      {err && <div className="mb-4 rounded bg-danger-soft p-3 text-sm text-danger-fg">{err}</div>}
      {msg && <div className="mb-4 rounded bg-success-soft p-3 text-sm text-success-fg">{msg}</div>}

      {!available ? (
        <div className="mb-6 rounded-lg border border-warning/30 bg-warning-soft p-4 text-sm text-warning-fg">
          <div className="mb-1 font-semibold">端口 / 开机自启 / 服务启停 仅在启动器中可用</div>
          你当前是手动 <code className="rounded bg-bg-card px-1">pnpm dev</code> 运行的 dashboard。 用桌面托盘启动器打开本页面即可管理这些系统级设置。下面的「配置迁移」无论是否在启动器中都可用。
        </div>
      ) : loading ? (
        <div className="mb-6 space-y-6">
          {['h-28', 'h-56', 'h-24'].map((h, i) => (
            <Skeleton key={i} className={`${h} rounded-lg`} />
          ))}
        </div>
      ) : (
        <div className="mb-6 space-y-6">
          {/* 服务状态 */}
          <Card>
            <SectionTitle as="h3" title="服务状态" />
            <div className="space-y-1 text-sm">
              <StatusRow label="orchestrator（后端 API）" state={status?.orchestrator} port={status?.apiPort} />
              <StatusRow label="dashboard（管理网站）" state={status?.dashboard} port={status?.dashboardPort} />
            </div>
            {status?.lastError && (
              <div className="mt-2 rounded bg-danger-soft p-2 text-xs text-danger-fg">最近错误：{status.lastError}</div>
            )}
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="primary" onClick={() => svcAction(launcherApi.start)} disabled={busy}>
                启动
              </Button>
              <Button size="sm" onClick={() => svcAction(launcherApi.stop)} disabled={busy}>
                停止
              </Button>
              <Button size="sm" onClick={() => svcAction(launcherApi.restart)} disabled={busy}>
                重启
              </Button>
            </div>
          </Card>

          {/* 端口与启动行为 */}
          <Card className="space-y-3">
            <SectionTitle as="h3" title="端口与启动" className="mb-0" />
            <Field label="后端 API 端口（orchestrator，API_PORT）">
              <Input
                type="number"
                min={1}
                max={65535}
                value={apiPort}
                onChange={(e) => setApiPort(Number(e.target.value))}
                className="w-40"
              />
            </Field>
            <Field label="管理网站端口（dashboard）">
              <Input
                type="number"
                min={1}
                max={65535}
                value={dashboardPort}
                onChange={(e) => setDashboardPort(Number(e.target.value))}
                className="w-40"
              />
            </Field>
            <label className="flex items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                className="accent-primary-strong"
                checked={autoStartService}
                onChange={(e) => setAutoStartService(e.target.checked)}
              />
              启动器打开后自动拉起服务
            </label>
            {portsChanged && (
              <div className="rounded bg-warning-soft p-2 text-xs text-warning-fg">
                改了端口，保存后服务会重启以生效
                {dashPortChanged ? '；且本页面所在端口会变，请稍后通过托盘重新打开。' : '。'}
              </div>
            )}
            <Button variant="primary" onClick={onSave} loading={busy}>
              {busy ? '保存中…' : '保存设置'}
            </Button>
          </Card>

          {/* 开机自启 */}
          <Card>
            <SectionTitle as="h3" title="开机自启" />
            <label className="flex items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                className="accent-primary-strong"
                checked={status?.autoLaunch ?? false}
                onChange={onToggleAutoLaunch}
                disabled={busy}
              />
              开机时自动启动托盘启动器
            </label>
            <p className="mt-1 text-xs text-fg-muted">状态以操作系统实测为准（你也可在系统的「登录项 / 启动」里管理）。</p>
          </Card>
        </div>
      )}

      {/* 配置迁移：无论是否在启动器中都可用（直连 orchestrator） */}
      <ConfigMigration />
    </PageContainer>
  );
}

function ConfigMigration() {
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onExport = async () => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const bundle = await configApi.export(includeSecrets);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.href = url;
      a.download = `hivemind-config-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setMsg(
        `✅ 已导出 ${bundle.providers.length} 个 provider、${bundle.bots.length} 个 bot` +
          (includeSecrets ? '（含明文密钥，请妥善保管、勿入 git）' : '（不含密钥）'),
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onImportFile = async (file: File) => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const bundle = JSON.parse(await file.text());
      const r = await configApi.import(bundle);
      setMsg(
        `✅ 导入完成：provider ${r.providers}、bot ${r.bots}、密钥 ${r.secrets}` +
          (r.errors.length ? `；${r.errors.length} 条出错：${r.errors.join('；')}` : ''),
      );
    } catch (e) {
      setErr(`导入失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <Card className="space-y-3">
      <SectionTitle as="h3" title="配置迁移（导出 / 导入）" className="mb-0" />
      <p className="text-xs text-fg-muted">
        在机器间搬运 providers / bots。它们存在被 git 忽略的本地数据库、密钥存在系统凭证库，都不会随仓库走——
        在旧机器导出成 JSON，到新机器导入即可。
      </p>
      {err && <div className="break-all rounded bg-danger-soft p-2 text-xs text-danger-fg">{err}</div>}
      {msg && <div className="break-all rounded bg-success-soft p-2 text-xs text-success-fg">{msg}</div>}

      <label className="flex items-center gap-2 text-sm text-fg">
        <input
          type="checkbox"
          className="accent-primary-strong"
          checked={includeSecrets}
          onChange={(e) => setIncludeSecrets(e.target.checked)}
        />
        包含密钥（API key / Discord token / 搜索源凭证）
      </label>
      {includeSecrets && (
        <div className="rounded bg-warning-soft p-2 text-xs text-warning-fg">
          ⚠️ 导出文件将含明文密钥，请勿提交到 git 或随意外发。
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={onExport} loading={busy}>
          {busy ? '处理中…' : '导出配置'}
        </Button>
        <Button onClick={() => fileRef.current?.click()} disabled={busy}>
          导入配置…
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onImportFile(f);
          }}
        />
      </div>
      <p className="text-xs text-fg-subtle">导入按 id 合并（同 id 覆盖），完成后自动让 bot 与新配置对齐（启用的启动 / 停用的停止）。</p>
    </Card>
  );
}

function StatusRow({ label, state, port }: { label: string; state?: ServiceState; port?: number }) {
  const tone =
    state === 'running' ? 'success' : state === 'error' ? 'danger' : state === 'starting' ? 'warning' : 'neutral';
  const text =
    state === 'running' ? '运行中' : state === 'error' ? '错误' : state === 'starting' ? '启动中…' : '已停止';
  return (
    <div className="flex items-center justify-between">
      <span className="text-fg">
        {label} {port ? <span className="text-fg-subtle">:{port}</span> : null}
      </span>
      <Badge tone={tone}>{text}</Badge>
    </div>
  );
}
