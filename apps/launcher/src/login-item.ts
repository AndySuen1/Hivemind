// 开机自启。按平台/形态分三条路径：
//
//  1) dev（未打包）+ Windows：直接管理 HKCU\...\Run 注册表项（值名 DiscordAgentHubLauncher），
//     命令 = `"<系统node>" "<…/scripts/dev.mjs>"`。
//  2) dev（未打包）+ macOS：写 ~/Library/LaunchAgents/<label>.plist（ProgramArguments = [node, dev.mjs]）并 launchctl load。
//     —— 两者同因：dev 下 process.execPath 是 node_modules 里的 electron.exe，裸 openAtLogin 注册它开机只会弹空白 Electron；
//        而 dev.mjs 会清掉 ELECTRON_RUN_AS_NODE 并以绝对路径拉起 Electron 应用。读状态都以文件/注册表为 ground truth
//        （Electron getLoginItemSettings 在自定义命令下回读不可靠）。
//  3) 打包（v2，任意平台）：execPath 即真应用，直接用内置 app.setLoginItemSettings / getLoginItemSettings。
import { app } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getConfig } from './config';
import { resolveNodePath } from './node-path';

const LABEL = 'com.discord-agent-hub.launcher';

// ---- Windows（dev）注册表 ----
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'DiscordAgentHubLauncher';

// node.exe 是“控制台子系统”程序：开机被注册表 Run 项直接拉起会分配一个黑色控制台窗口，
// 且 dev.mjs 整段会话都在等 electron 退出 → 黑窗口一直挂着不关。
// 解法：不直接注册 node，而是注册 wscript.exe 跑一个隐藏窗口的 VBS 包装来拉 node。
//   - wscript.exe 本身是 GUI 子系统程序，自己不弹任何窗口；
//   - VBS 里 WScript.Shell.Run cmd, 0, False —— 第二参数 0 = 隐藏窗口启动，于是 node 全程无控制台。
// VBS 放在 userData 目录（与 launcher.json 同处）。
function autostartVbsPath(): string {
  return join(app.getPath('userData'), 'autostart.vbs');
}
function wscriptPath(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe');
}

/** 写入隐藏启动用的 VBS，返回其路径。命令 = `"<node>" "<dev.mjs>"`，以隐藏窗口方式运行。 */
function writeAutostartVbs(node: string, script: string): string {
  const p = autostartVbsPath();
  const cmd = `"${node}" "${script}"`; // 期望 WScript 收到的命令行
  const literal = `"${cmd.replace(/"/g, '""')}"`; // VBS 字符串字面量：内部双引号需翻倍
  const vbs =
    `' 由 discord-agent-hub-launcher 自动生成：隐藏窗口拉起 dev 启动器，避免开机弹出黑色控制台窗口。\r\n` +
    `CreateObject("WScript.Shell").Run ${literal}, 0, False\r\n`;
  writeFileSync(p, vbs, 'utf-8');
  return p;
}

/** 读取当前 Run 项的值字符串；不存在返回 null。 */
function readRunValue(): string | null {
  try {
    const out = execFileSync('reg', ['query', RUN_KEY, '/v', RUN_VALUE], { encoding: 'utf-8' });
    const line = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((l) => l.startsWith(RUN_VALUE));
    if (!line) return null;
    const idx = line.indexOf('REG_SZ');
    if (idx === -1) return null;
    return line.slice(idx + 'REG_SZ'.length).trim();
  } catch {
    return null; // reg query 对缺失值非零退出 → 抛错
  }
}

// ---- macOS（dev）LaunchAgent ----
function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

/** dev 形态开机自启的启动命令组件：系统 node + 绝对路径的 scripts/dev.mjs。 */
function devLaunch(): { node: string; script: string } {
  return {
    node: resolveNodePath(getConfig().nodePath),
    script: join(app.getAppPath(), 'scripts', 'dev.mjs'),
  };
}

function useWinRegistry(): boolean {
  return process.platform === 'win32' && !app.isPackaged;
}
function useMacLaunchAgent(): boolean {
  return process.platform === 'darwin' && !app.isPackaged;
}

function buildPlist(node: string, script: string): string {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(node)}</string>
    <string>${esc(script)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

export function setAutoLaunch(enabled: boolean): void {
  if (useWinRegistry()) {
    try {
      if (enabled) {
        const { node, script } = devLaunch();
        const vbs = writeAutostartVbs(node, script);
        // 注册 wscript.exe 隐藏跑 VBS（而非直接跑 node），开机不再弹黑色控制台窗口。
        execFileSync('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', `"${wscriptPath()}" "${vbs}"`, '/f'], { stdio: 'ignore' });
      } else {
        execFileSync('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { stdio: 'ignore' });
        rmSync(autostartVbsPath(), { force: true });
      }
    } catch {
      /* delete 不存在会抛，忽略 */
    }
    return;
  }

  if (useMacLaunchAgent()) {
    const p = plistPath();
    try {
      if (enabled) {
        mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
        const { node, script } = devLaunch();
        writeFileSync(p, buildPlist(node, script), 'utf-8');
        // 先尝试卸载旧的（忽略错误），再 load -w（-w 标记为启用，写入 disabled 覆盖）
        try {
          execFileSync('launchctl', ['unload', '-w', p], { stdio: 'ignore' });
        } catch {
          /* 未加载过 */
        }
        execFileSync('launchctl', ['load', '-w', p], { stdio: 'ignore' });
      } else {
        if (existsSync(p)) {
          try {
            execFileSync('launchctl', ['unload', '-w', p], { stdio: 'ignore' });
          } catch {
            /* 未加载 */
          }
          rmSync(p, { force: true });
        }
      }
    } catch {
      /* 忽略 launchctl/文件错误 */
    }
    return;
  }

  // 打包版 / 其它平台：内置 API
  app.setLoginItemSettings({ openAtLogin: enabled });
}

export function getAutoLaunch(): boolean {
  if (useWinRegistry()) {
    return readRunValue() !== null;
  }

  if (useMacLaunchAgent()) {
    return existsSync(plistPath()); // 以 plist 是否存在为准
  }

  try {
    const s = app.getLoginItemSettings();
    const willLaunch = (s as { executableWillLaunchAtLogin?: boolean }).executableWillLaunchAtLogin;
    return typeof willLaunch === 'boolean' ? willLaunch : s.openAtLogin;
  } catch {
    return false;
  }
}

/**
 * 启动时迁移：若已开启自启但 Run 项仍是旧的“直接跑 node”形式（会弹黑窗），
 * 就地重写为 wscript 隐藏形式。已是隐藏形式或未开启则不动。
 */
export function ensureAutoLaunchHidden(): void {
  if (!useWinRegistry()) return;
  const val = readRunValue();
  if (val === null) return; // 未开启自启
  if (/wscript/i.test(val)) return; // 已是隐藏形式
  setAutoLaunch(true); // 旧形式 → 重写为隐藏形式
}
