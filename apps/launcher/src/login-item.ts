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
    const { node, script } = devLaunch();
    try {
      if (enabled) {
        execFileSync('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', `"${node}" "${script}"`, '/f'], { stdio: 'ignore' });
      } else {
        execFileSync('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { stdio: 'ignore' });
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
    try {
      execFileSync('reg', ['query', RUN_KEY, '/v', RUN_VALUE], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
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
