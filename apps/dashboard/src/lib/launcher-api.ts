// 启动器（Electron 壳）本地控制 API 客户端。仅当 dashboard 由启动器拉起时，
// 启动器才会注入 NEXT_PUBLIC_LAUNCHER_BASE / NEXT_PUBLIC_LAUNCHER_TOKEN；
// 手动 pnpm dev 跑时二者为空 → launcherAvailable=false，设置页降级提示“仅在启动器中可用”。
const LAUNCHER_BASE = process.env.NEXT_PUBLIC_LAUNCHER_BASE;
const LAUNCHER_TOKEN = process.env.NEXT_PUBLIC_LAUNCHER_TOKEN;

export const launcherAvailable = Boolean(LAUNCHER_BASE && LAUNCHER_TOKEN);

export type ServiceState = 'stopped' | 'starting' | 'running' | 'error';

export interface LauncherSettings {
  apiPort: number;
  dashboardPort: number;
  autoStartService: boolean;
  openLoginItem: boolean;
}

export interface LauncherStatus {
  orchestrator: ServiceState;
  dashboard: ServiceState;
  apiPort: number;
  dashboardPort: number;
  controlPort: number;
  autoLaunch: boolean;
  lastError?: string;
}

export interface SettingsBundle {
  settings: LauncherSettings;
  status: LauncherStatus;
}

type ApiOk<T> = { ok: true; data: T };
type ApiErr = { ok: false; error: string };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (!LAUNCHER_BASE || !LAUNCHER_TOKEN) throw new Error('NOT_IN_LAUNCHER');
  const headers: Record<string, string> = {
    'X-Launcher-Token': LAUNCHER_TOKEN,
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${LAUNCHER_BASE}${path}`, { ...init, headers });
  const body = (await res.json()) as ApiOk<T> | ApiErr;
  if (!body.ok) throw new Error(body.error);
  return body.data;
}

export const launcherApi = {
  getSettings: () => call<SettingsBundle>('/launcher/settings'),
  updateSettings: (patch: Partial<LauncherSettings>) =>
    call<SettingsBundle>('/launcher/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  getStatus: () => call<LauncherStatus>('/launcher/service/status'),
  start: () => call<LauncherStatus>('/launcher/service/start', { method: 'POST' }),
  stop: () => call<LauncherStatus>('/launcher/service/stop', { method: 'POST' }),
  restart: () => call<LauncherStatus>('/launcher/service/restart', { method: 'POST' }),
};
