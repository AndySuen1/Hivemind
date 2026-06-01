// 解析“系统 node”可执行文件路径。被 process-manager（spawn 子进程）与 login-item（dev 开机自启命令）共用。
// 注意：Electron 里 process.execPath 指向 Electron 本体而非 node，不可用；GUI/开机启动也不继承 shell PATH，故需显式查找。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function resolveNodePath(configured?: string): string {
  if (configured && existsSync(configured)) return configured;

  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(finder, ['node'], { encoding: 'utf-8' });
    const first = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0];
    if (first && existsSync(first)) return first;
  } catch {
    /* 找不到则继续猜常见路径 */
  }

  const candidates =
    process.platform === 'win32'
      ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe'), 'C:\\Program Files\\nodejs\\node.exe']
      : ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
  for (const c of candidates) if (c && existsSync(c)) return c;

  return process.platform === 'win32' ? 'node.exe' : 'node'; // 最后赌 PATH
}
