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
      launcherApi.getStatus().then(setStatus).catch(() => {});
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
            : '✅ 已保存。'
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
    <div className="max-w-2xl">
      <h2 className="mb-6 text-2xl font-bold">系统设置</h2>

      {err && <div className="mb-4 rounded bg-red-50 p-3 text-sm text-red-700">{err}</div>}
      {msg && <div className="mb-4 rounded bg-green-50 p-3 text-sm text-green-700">{msg}</div>}

      {!available ? (
        <div className="mb-6 rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <div className="mb-1 font-semibold">端口 / 开机自启 / 服务启停 仅在启动器中可用</div>
          你当前是手动 <code className="rounded bg-amber-100 px-1">pnpm dev</code> 运行的 dashboard。
          用桌面托盘启动器打开本页面即可管理这些系统级设置。下面的「配置迁移」无论是否在启动器中都可用。
        </div>
      ) : loading ? (
        <div className="mb-6 text-zinc-500">加载中…</div>
      ) : (
        <div className="mb-6 space-y-6">
          {/* 服务状态 */}
          <section className="rounded border border-zinc-200 bg-white p-4">
            <div className="mb-3 text-sm font-semibold text-zinc-700">服务状态</div>
            <div className="space-y-1 text-sm">
              <StatusRow label="orchestrator（后端 API）" state={status?.orchestrator} port={status?.apiPort} />
              <StatusRow label="dashboard（管理网站）" state={status?.dashboard} port={status?.dashboardPort} />
            </div>
            {status?.lastError && (
              <div className="mt-2 rounded bg-red-50 p-2 text-xs text-red-700">最近错误：{status.lastError}</div>
            )}
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => svcAction(launcherApi.start)}
                disabled={busy}
                className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
              >
                启动
              </button>
              <button
                onClick={() => svcAction(launcherApi.stop)}
                disabled={busy}
                className="rounded border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50"
              >
                停止
              </button>
              <button
                onClick={() => svcAction(launcherApi.restart)}
                disabled={busy}
                className="rounded border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50"
              >
                重启
              </button>
            </div>
          </section>

          {/* 端口与启动行为 */}
          <section className="space-y-3 rounded border border-zinc-200 bg-white p-4">
            <div className="text-sm font-semibold text-zinc-700">端口与启动</div>
            <Field label="后端 API 端口（orchestrator，API_PORT）">
              <input
                type="number"
                min={1}
                max={65535}
                value={apiPort}
                onChange={(e) => setApiPort(Number(e.target.value))}
                className="w-40 rounded border border-zinc-300 px-3 py-2 text-sm"
              />
            </Field>
            <Field label="管理网站端口（dashboard）">
              <input
                type="number"
                min={1}
                max={65535}
                value={dashboardPort}
                onChange={(e) => setDashboardPort(Number(e.target.value))}
                className="w-40 rounded border border-zinc-300 px-3 py-2 text-sm"
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={autoStartService}
                onChange={(e) => setAutoStartService(e.target.checked)}
              />
              启动器打开后自动拉起服务
            </label>
            {portsChanged && (
              <div className="rounded bg-amber-50 p-2 text-xs text-amber-700">
                改了端口，保存后服务会重启以生效
                {dashPortChanged ? '；且本页面所在端口会变，请稍后通过托盘重新打开。' : '。'}
              </div>
            )}
            <button
              onClick={onSave}
              disabled={busy}
              className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? '保存中…' : '保存设置'}
            </button>
          </section>

          {/* 开机自启 */}
          <section className="rounded border border-zinc-200 bg-white p-4">
            <div className="mb-2 text-sm font-semibold text-zinc-700">开机自启</div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={status?.autoLaunch ?? false} onChange={onToggleAutoLaunch} disabled={busy} />
              开机时自动启动托盘启动器
            </label>
            <p className="mt-1 text-xs text-zinc-500">
              状态以操作系统实测为准（你也可在系统的「登录项 / 启动」里管理）。
            </p>
          </section>
        </div>
      )}

      {/* 配置迁移：无论是否在启动器中都可用（直连 orchestrator） */}
      <ConfigMigration />
    </div>
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
          (includeSecrets ? '（含明文密钥，请妥善保管、勿入 git）' : '（不含密钥）')
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
          (r.errors.length ? `；${r.errors.length} 条出错：${r.errors.join('；')}` : '')
      );
    } catch (e) {
      setErr(`导入失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <section className="space-y-3 rounded border border-zinc-200 bg-white p-4">
      <div className="text-sm font-semibold text-zinc-700">配置迁移（导出 / 导入）</div>
      <p className="text-xs text-zinc-500">
        在机器间搬运 providers / bots。它们存在被 git 忽略的本地数据库、密钥存在系统凭证库，都不会随仓库走——
        在旧机器导出成 JSON，到新机器导入即可。
      </p>
      {err && <div className="rounded bg-red-50 p-2 text-xs text-red-700 break-all">{err}</div>}
      {msg && <div className="rounded bg-green-50 p-2 text-xs text-green-700 break-all">{msg}</div>}

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={includeSecrets} onChange={(e) => setIncludeSecrets(e.target.checked)} />
        包含密钥（API key / Discord token / 搜索源凭证）
      </label>
      {includeSecrets && (
        <div className="rounded bg-amber-50 p-2 text-xs text-amber-700">
          ⚠️ 导出文件将含明文密钥，请勿提交到 git 或随意外发。
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={onExport}
          disabled={busy}
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? '处理中…' : '导出配置'}
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="rounded border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50"
        >
          导入配置…
        </button>
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
      <p className="text-xs text-zinc-400">
        导入按 id 合并（同 id 覆盖），完成后自动让 bot 与新配置对齐（启用的启动 / 停用的停止）。
      </p>
    </section>
  );
}

function StatusRow({ label, state, port }: { label: string; state?: ServiceState; port?: number }) {
  const tone =
    state === 'running'
      ? 'bg-green-100 text-green-800'
      : state === 'error'
        ? 'bg-red-100 text-red-800'
        : state === 'starting'
          ? 'bg-amber-100 text-amber-800'
          : 'bg-zinc-100 text-zinc-600';
  const text =
    state === 'running' ? '运行中' : state === 'error' ? '错误' : state === 'starting' ? '启动中…' : '已停止';
  return (
    <div className="flex items-center justify-between">
      <span className="text-zinc-700">
        {label} {port ? <span className="text-zinc-400">:{port}</span> : null}
      </span>
      <span className={`rounded px-2 py-0.5 text-[11px] ${tone}`}>{text}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-medium text-zinc-700">{label}</div>
      {children}
    </label>
  );
}
