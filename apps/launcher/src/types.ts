// 启动器内部共享类型：控制器接口 + 状态快照 + 对外可见设置。
// 这些类型在 main / tray / control-server 间共享，单独成文件避免循环依赖。

export type ServiceName = 'orchestrator' | 'dashboard';
export type ServiceState = 'stopped' | 'starting' | 'running' | 'error';

/** 对外（托盘 + 控制 API）暴露的可配置系统设置；不含本地 token 等敏感字段。 */
export interface PublicSettings {
  apiPort: number;
  dashboardPort: number;
  autoStartService: boolean; // 启动器启动后是否自动拉起服务
  openLoginItem: boolean; // 期望的开机自启状态（实际以 OS 回读为准）
}

/** 一次完整的运行状态快照，供托盘菜单与设置页渲染。 */
export interface StatusSnapshot {
  orchestrator: ServiceState;
  dashboard: ServiceState;
  apiPort: number;
  dashboardPort: number;
  controlPort: number;
  autoLaunch: boolean; // OS 实测的开机自启状态
  lastError?: string;
}

/**
 * 启动器高层控制器：托盘与控制 HTTP API 都只依赖这个接口，
 * 真正的编排（写配置 / 重启子进程 / 设登录项）由 main.ts 实现并注入。
 */
export interface LauncherController {
  getStatus(): StatusSnapshot;
  getSettings(): PublicSettings;
  /** 应用部分设置：端口变化→重启服务；openLoginItem 变化→设/取消 OS 登录项。返回新快照。 */
  applySettings(patch: Partial<PublicSettings>): Promise<StatusSnapshot>;
  startServices(): Promise<void>;
  stopServices(): Promise<void>;
  restartServices(): Promise<void>;
  openDashboard(): void;
  quit(): void;
  /** 注册状态变化监听（托盘据此刷新菜单）。 */
  onChange(listener: () => void): void;
}
