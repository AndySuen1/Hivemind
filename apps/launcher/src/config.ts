// 启动器配置：单一事实源 = userData/launcher.json。
// 端口是 spawn 服务的前置输入、自启在任何服务存在前就要读，因此绝不放进 orchestrator 的 SQLite。
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface LauncherConfig {
  apiPort: number; // orchestrator API_PORT，默认 3001
  dashboardPort: number; // dashboard 端口，默认 3000
  host: string; // 服务绑定/访问主机，默认 127.0.0.1
  controlPort: number; // 启动器本地控制 API 端口，默认 8787
  autoStartService: boolean; // 启动器起来后自动拉起服务
  openLoginItem: boolean; // 期望开机自启（实际以 OS 回读为准）
  controlToken: string; // 控制 API 本地 token（防跨站调用 OS 级能力）
  ingestToken: string; // 日志转发 token：launcher→orchestrator /api/logs/ingest 鉴权。**只**注入 orchestrator 子进程 env，绝不暴露给浏览器（区别于 controlToken）
  nodePath?: string; // 可选：手动指定系统 node 可执行文件
}

function defaults(): LauncherConfig {
  return {
    apiPort: 3001,
    dashboardPort: 3000,
    host: '127.0.0.1',
    controlPort: 8787,
    autoStartService: true,
    openLoginItem: false,
    controlToken: randomBytes(24).toString('hex'),
    ingestToken: randomBytes(24).toString('hex'),
  };
}

function configPath(): string {
  return join(app.getPath('userData'), 'launcher.json');
}

let current: LauncherConfig | null = null;

/** 读取配置（首次会写入默认值并补全缺失字段）。app ready 后调用。 */
export function loadConfig(): LauncherConfig {
  if (current) return current;
  const p = configPath();
  let cfg = defaults();
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf-8')) as Partial<LauncherConfig>;
      cfg = { ...cfg, ...parsed };
      // token 一旦生成必须持久化，避免每次重启都变
      if (!parsed.controlToken) cfg.controlToken = cfg.controlToken;
    } catch (e) {
      console.error('[config] launcher.json 解析失败，使用默认值：', e);
    }
  }
  current = cfg;
  saveConfig(cfg); // 回写以补全新增字段/生成 token
  return cfg;
}

export function getConfig(): LauncherConfig {
  return current ?? loadConfig();
}

export function saveConfig(cfg: LauncherConfig): void {
  current = cfg;
  const p = configPath();
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf-8');
}

/** 合并部分字段并落盘，返回最新配置。 */
export function updateConfig(patch: Partial<LauncherConfig>): LauncherConfig {
  const next = { ...getConfig(), ...patch };
  saveConfig(next);
  return next;
}

export function getConfigPath(): string {
  return configPath();
}
