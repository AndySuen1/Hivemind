// 子进程生命周期管理：用 child_process.spawn 拉起“真正独立的系统 node”跑 tsx / next，
// 绝不用 Electron 的 fork/UtilityProcess（它们 ELECTRON_RUN_AS_NODE=1 仍跑 Electron ABI，
// 会让 better-sqlite3/keytar 报 “compiled against a different Node.js version”）。
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { app } from 'electron';
import { getConfig } from './config';
import { resolveNodePath } from './node-path';
import type { LogForwarder } from './log-forwarder';
import type { ServiceName, ServiceState } from './types';

const RESTART_BACKOFF_MS = 2000;
const MAX_CRASH_RESTARTS = 3; // 连续异常退出超过此次数则停止重试，置 error
const FORCE_KILL_TIMEOUT_MS = 5000;

interface Service {
  name: ServiceName;
  child: ChildProcess | null;
  state: ServiceState;
  manualStop: boolean;
  crashes: number;
  readyTimer: NodeJS.Timeout | null;
  forceTimer: NodeJS.Timeout | null;
  exitWaiters: Array<() => void>;
}

/** 仓库根目录：app.getAppPath() = apps/launcher，向上两级。 */
function repoRoot(): string {
  return resolve(app.getAppPath(), '..', '..');
}

/** 通过 require.resolve 定位包的 JS 入口，规避 pnpm symlink 与 Windows .bin shim 的 shell 依赖。 */
function resolveCli(pkg: string, subpath: string, fromDir: string): string {
  const pkgJson = require.resolve(`${pkg}/package.json`, { paths: [fromDir, repoRoot()] });
  return join(dirname(pkgJson), subpath);
}

export class ProcessManager extends EventEmitter {
  private services: Record<ServiceName, Service> = {
    orchestrator: this.blank('orchestrator'),
    dashboard: this.blank('dashboard'),
  };
  lastError: string | undefined;

  // forwarder 把子进程 stdout/stderr 转发到 orchestrator /api/logs/ingest（可选；无则退回直接透传终端）。
  constructor(private readonly forwarder?: LogForwarder) {
    super();
  }

  private blank(name: ServiceName): Service {
    return { name, child: null, state: 'stopped', manualStop: false, crashes: 0, readyTimer: null, forceTimer: null, exitWaiters: [] };
  }

  getState(name: ServiceName): ServiceState {
    return this.services[name].state;
  }

  private setState(svc: Service, state: ServiceState): void {
    if (svc.state === state) return;
    svc.state = state;
    this.emit('status-change');
  }

  private spawnArgs(name: ServiceName): { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
    const cfg = getConfig();
    const node = resolveNodePath(cfg.nodePath);
    const apiBase = `http://${cfg.host}:${cfg.apiPort}`;
    if (name === 'orchestrator') {
      const cwd = join(repoRoot(), 'apps', 'orchestrator');
      const tsx = resolveCli('tsx', 'dist/cli.mjs', cwd);
      return {
        cmd: node,
        args: [tsx, 'src/index.ts'],
        cwd,
        env: {
          ...process.env,
          API_PORT: String(cfg.apiPort),
          DASHBOARD_PORT: String(cfg.dashboardPort),
          DASHBOARD_ORIGIN: `http://${cfg.host}:${cfg.dashboardPort}`,
          // 日志转发鉴权：**只**注入 orchestrator（dashboard 不给，绝不进 NEXT_PUBLIC 暴露给浏览器）。
          LOG_INGEST_TOKEN: cfg.ingestToken,
        },
      };
    }
    const cwd = join(repoRoot(), 'apps', 'dashboard');
    const next = resolveCli('next', 'dist/bin/next', cwd);
    return {
      cmd: node,
      args: [next, 'dev', '-p', String(cfg.dashboardPort)],
      cwd,
      env: {
        ...process.env,
        PORT: String(cfg.dashboardPort),
        NEXT_PUBLIC_API_BASE: apiBase,
        NEXT_PUBLIC_LAUNCHER_BASE: `http://127.0.0.1:${cfg.controlPort}`,
        NEXT_PUBLIC_LAUNCHER_TOKEN: cfg.controlToken,
      },
    };
  }

  start(name: ServiceName): void {
    const svc = this.services[name];
    if (svc.state === 'running' || svc.state === 'starting') return;
    svc.manualStop = false;

    let spec: ReturnType<ProcessManager['spawnArgs']>;
    try {
      spec = this.spawnArgs(name);
    } catch (e) {
      this.lastError = `${name} 解析启动命令失败：${(e as Error).message}`;
      console.error('[pm]', this.lastError);
      this.setState(svc, 'error');
      return;
    }

    console.log(`[pm] start ${name}: ${spec.cmd} ${spec.args.join(' ')} (cwd=${spec.cwd})`);
    const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    svc.child = child;
    this.setState(svc, 'starting');

    // 子进程输出：透传终端（dev 可见）+ 转发采集为对应 source。透传走 forwarder.writeOut/Err（绕过
    // launcher 自捕获，避免与 push 重复）；无 forwarder 时退回直接写终端。
    child.stdout?.on('data', (d) => {
      const s = String(d);
      if (this.forwarder) {
        this.forwarder.writeOut(`[${name}] ${s}`);
        this.forwarder.push(name, 'out', s);
      } else {
        process.stdout.write(`[${name}] ${s}`);
      }
    });
    child.stderr?.on('data', (d) => {
      const s = String(d);
      if (/EADDRINUSE/.test(s)) this.lastError = `${name} 端口被占用`;
      if (this.forwarder) {
        this.forwarder.writeErr(`[${name}] ${s}`);
        this.forwarder.push(name, 'err', s);
      } else {
        process.stderr.write(`[${name}] ${s}`);
      }
    });

    child.on('error', (err) => {
      this.lastError = `${name} 启动失败：${err.message}`;
      console.error('[pm]', this.lastError);
      this.setState(svc, 'error');
    });

    // 存活超过 readyTimer 仍未退出 → 视为 running，并清零崩溃计数
    svc.readyTimer = setTimeout(() => {
      if (svc.child === child && svc.state === 'starting') {
        svc.crashes = 0;
        this.setState(svc, 'running');
      }
    }, 1500);

    child.on('exit', (code, signal) => {
      if (svc.readyTimer) clearTimeout(svc.readyTimer);
      if (svc.forceTimer) clearTimeout(svc.forceTimer);
      svc.readyTimer = null;
      svc.forceTimer = null;
      svc.child = null;
      const waiters = svc.exitWaiters;
      svc.exitWaiters = [];
      waiters.forEach((w) => w());

      if (svc.manualStop) {
        this.setState(svc, 'stopped');
        return;
      }
      // 非预期退出：退避重启，超限置 error
      console.warn(`[pm] ${name} 异常退出 code=${code} signal=${signal}`);
      svc.crashes += 1;
      if (svc.crashes > MAX_CRASH_RESTARTS) {
        this.lastError = this.lastError ?? `${name} 反复退出（已放弃自动重启）`;
        this.setState(svc, 'error');
        return;
      }
      this.setState(svc, 'starting');
      setTimeout(() => {
        if (!svc.manualStop && svc.child === null) this.start(name);
      }, RESTART_BACKOFF_MS);
    });
  }

  /** 停止单个服务：SIGTERM → 超时强杀。返回退出后 resolve 的 Promise。 */
  stop(name: ServiceName): Promise<void> {
    const svc = this.services[name];
    svc.manualStop = true;
    if (svc.readyTimer) {
      clearTimeout(svc.readyTimer);
      svc.readyTimer = null;
    }
    const child = svc.child;
    if (!child || child.exitCode !== null) {
      this.setState(svc, 'stopped');
      return Promise.resolve();
    }
    return new Promise<void>((res) => {
      svc.exitWaiters.push(res);
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      svc.forceTimer = setTimeout(() => this.forceKill(svc), FORCE_KILL_TIMEOUT_MS);
    });
  }

  private forceKill(svc: Service): void {
    const child = svc.child;
    if (!child || child.pid == null) return;
    console.warn(`[pm] 强杀 ${svc.name} (pid=${child.pid})`);
    if (process.platform === 'win32') {
      // next dev 会派生 worker 子进程，需 /T 连同子树一起杀
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      } catch {
        /* 进程可能已退出 */
      }
    } else {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }

  startAll(): void {
    this.start('orchestrator');
    this.start('dashboard');
  }

  async stopAll(): Promise<void> {
    await Promise.all([this.stop('orchestrator'), this.stop('dashboard')]);
  }

  async restartAll(): Promise<void> {
    await this.stopAll();
    // 给端口释放一点时间
    await new Promise((r) => setTimeout(r, 300));
    this.services.orchestrator.crashes = 0;
    this.services.dashboard.crashes = 0;
    this.startAll();
  }
}
