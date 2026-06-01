// Electron 主进程入口：单实例锁 → 读配置 → 拉起子进程 → 创建托盘 → 启动本地控制 API → 优雅退出。
// 纪律：orchestrator/dashboard 全部由 ProcessManager 以独立系统 node 子进程 spawn，主进程不加载任何原生模块。
import { app, shell, Tray } from 'electron';
import { getConfig, getConfigPath, loadConfig, updateConfig } from './config';
import { ProcessManager } from './process-manager';
import { getAutoLaunch, setAutoLaunch } from './login-item';
import { startControlServer } from './control-server';
import { createTray } from './tray';
import type { LauncherController, PublicSettings, StatusSnapshot } from './types';

// 显式设置应用名：历史 app 名保持不变（仅包名改为 @hivemind/launcher）：userData(launcher.json：端口/token/自启) 与开机自启身份都绑定它，改了会作废现有配置。
app.setName('discord-agent-hub-launcher');

let tray: Tray | null = null;
let controller: LauncherController | null = null;
let isQuitting = false;

// 单实例：第二次启动只唤起“打开管理网站”，不再重复拉服务。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => controller?.openDashboard());

  app.whenReady().then(init).catch((e) => {
    console.error('[main] 初始化失败：', e);
    app.quit();
  });
}

function init(): void {
  const cfg = loadConfig();
  console.log(`[main] 配置文件: ${getConfigPath()}`);
  if (process.platform === 'darwin') app.dock?.hide(); // 纯托盘应用，不在程序坞显示

  const pm = new ProcessManager();
  const listeners: Array<() => void> = [];
  const notify = (): void => listeners.forEach((fn) => fn());
  pm.on('status-change', notify);

  controller = {
    getStatus(): StatusSnapshot {
      const c = getConfig();
      return {
        orchestrator: pm.getState('orchestrator'),
        dashboard: pm.getState('dashboard'),
        apiPort: c.apiPort,
        dashboardPort: c.dashboardPort,
        controlPort: c.controlPort,
        autoLaunch: getAutoLaunch(),
        lastError: pm.lastError,
      };
    },
    getSettings(): PublicSettings {
      const c = getConfig();
      return {
        apiPort: c.apiPort,
        dashboardPort: c.dashboardPort,
        autoStartService: c.autoStartService,
        openLoginItem: getAutoLaunch(),
      };
    },
    async applySettings(patch: Partial<PublicSettings>): Promise<StatusSnapshot> {
      const before = getConfig();
      const portsChanged =
        (patch.apiPort !== undefined && patch.apiPort !== before.apiPort) ||
        (patch.dashboardPort !== undefined && patch.dashboardPort !== before.dashboardPort);

      // 开机自启：写 OS 登录项（真值随后由 getAutoLaunch 实测回读）。
      // 不加 “!== getAutoLaunch()” 守卫——否则当注册命令本身需要更新时（如 dev 改为 node+dev.mjs）会被跳过而无法重注册。
      if (patch.openLoginItem !== undefined) {
        setAutoLaunch(patch.openLoginItem);
      }

      updateConfig({
        ...(patch.apiPort !== undefined ? { apiPort: patch.apiPort } : {}),
        ...(patch.dashboardPort !== undefined ? { dashboardPort: patch.dashboardPort } : {}),
        ...(patch.autoStartService !== undefined ? { autoStartService: patch.autoStartService } : {}),
        ...(patch.openLoginItem !== undefined ? { openLoginItem: patch.openLoginItem } : {}),
      });

      // 端口变了且服务并非全停 → 用新端口重启；全停则仅存配置，下次启动生效。
      const running = pm.getState('orchestrator') !== 'stopped' || pm.getState('dashboard') !== 'stopped';
      if (portsChanged && running) {
        await pm.restartAll();
      }
      notify();
      return this.getStatus();
    },
    async startServices(): Promise<void> {
      pm.startAll();
      notify();
    },
    async stopServices(): Promise<void> {
      await pm.stopAll();
      notify();
    },
    async restartServices(): Promise<void> {
      await pm.restartAll();
      notify();
    },
    openDashboard(): void {
      const c = getConfig();
      void shell.openExternal(`http://${c.host}:${c.dashboardPort}`);
    },
    quit(): void {
      app.quit();
    },
    onChange(listener: () => void): void {
      listeners.push(listener);
    },
  };

  tray = createTray(controller);

  startControlServer(controller, cfg.controlToken, cfg.controlPort, '127.0.0.1');

  if (cfg.autoStartService) pm.startAll();

  // 优雅退出：先 SIGTERM 子进程，等其退出（最多 5s 内部强杀）后再真正退出。
  app.on('before-quit', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    isQuitting = true;
    pm.stopAll().finally(() => app.quit());
  });
}

// 纯托盘应用：窗口全关不退出（本就无窗口，保险起见显式处理）。
app.on('window-all-closed', () => {
  /* no-op：保持常驻托盘 */
});
