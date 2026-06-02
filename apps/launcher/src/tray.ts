// 系统托盘：图标 + 右键菜单。所有写操作统一走 controller（落盘/重启/设登录项），
// 状态变化时由 controller.onChange 触发重建菜单，保证托盘与网页设置页一致。
import { Tray, Menu, nativeImage, app } from 'electron';
import { join } from 'node:path';
import type { LauncherController, ServiceState, StatusSnapshot } from './types';

function assetPath(file: string): string {
  return join(app.getAppPath(), 'assets', file);
}

function trayImage(): Electron.NativeImage {
  if (process.platform === 'darwin') {
    const img = nativeImage.createFromPath(assetPath('trayTemplate.png'));
    img.setTemplateImage(true); // 菜单栏按深浅色自动反色
    return img;
  }
  return nativeImage.createFromPath(assetPath('tray.png'));
}

function stateLabel(s: ServiceState): string {
  switch (s) {
    case 'running':
      return '运行中';
    case 'starting':
      return '启动中…';
    case 'error':
      return '错误';
    default:
      return '已停止';
  }
}

function summarize(st: StatusSnapshot): string {
  const both = st.orchestrator === 'running' && st.dashboard === 'running';
  if (both) return '服务：运行中';
  if (st.orchestrator === 'stopped' && st.dashboard === 'stopped') return '服务：已停止';
  if (st.orchestrator === 'error' || st.dashboard === 'error') return '服务：错误';
  return '服务：启动中…';
}

export function createTray(controller: LauncherController): Tray {
  const tray = new Tray(trayImage());
  tray.setToolTip('Hivemind');

  const rebuild = (): void => {
    const st = controller.getStatus();
    const anyRunning = st.orchestrator !== 'stopped' || st.dashboard !== 'stopped';
    const allStopped = st.orchestrator === 'stopped' && st.dashboard === 'stopped';

    const menu = Menu.buildFromTemplate([
      { label: '打开管理网站', click: () => controller.openDashboard() },
      { type: 'separator' },
      { label: summarize(st), enabled: false },
      { label: `  orchestrator  ${stateLabel(st.orchestrator)}`, enabled: false },
      { label: `  dashboard     ${stateLabel(st.dashboard)}`, enabled: false },
      { type: 'separator' },
      { label: '启动服务', enabled: allStopped, click: () => void controller.startServices() },
      { label: '停止服务', enabled: anyRunning, click: () => void controller.stopServices() },
      { label: '重启服务', enabled: anyRunning, click: () => void controller.restartServices() },
      { type: 'separator' },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: st.autoLaunch,
        click: () => void controller.applySettings({ openLoginItem: !st.autoLaunch }),
      },
      { type: 'separator' },
      { label: '退出', click: () => controller.quit() },
    ]);
    tray.setContextMenu(menu);
    if (st.lastError) tray.setToolTip(`Hivemind — ${st.lastError}`);
    else tray.setToolTip('Hivemind');
  };

  rebuild();
  controller.onChange(rebuild);
  // 单击托盘图标也打开管理网站（Windows 习惯）
  tray.on('click', () => controller.openDashboard());
  return tray;
}
