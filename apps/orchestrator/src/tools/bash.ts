import { z } from 'zod';
import { tool, type Tool } from 'ai';
import { exec, execSync, type ChildProcess } from 'node:child_process';
import type { BashToolConfig } from '@hivemind/shared';
import { assertRealpathAllowed } from './path-guard.js';

const MAX_OUTPUT_CHARS = 8000; // 单流截断，防 token 爆炸
const MAX_BUFFER = 10 * 1024 * 1024;

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return s.slice(0, MAX_OUTPUT_CHARS) + `\n…（输出已截断，共 ${s.length} 字符）`;
}

/**
 * 命令黑名单校验：把命令小写 + 折叠连续空白后做子串匹配，能多挡一层
 * `rm   -rf` 之类的空格变体。
 *
 * ⚠️ 安全模型说明（重要）：黑名单是弱护栏，不是边界。run_command 执行的是任意
 * shell 命令，cwd 只决定起始目录、并不限制命令能读写删的范围（命令可用绝对路径、
 * cd 等触达任意位置）。真正能限制谁触发的是 allowedRequesters 白名单（默认只你自己）。
 * 因此 bash 工具应只授予可信 bot，不要当作沙箱。
 */
function findDenied(command: string, denyPatterns: string[]): string | null {
  const normalized = command.toLowerCase().replace(/\s+/g, ' ');
  for (const p of denyPatterns) {
    if (!p) continue;
    if (normalized.includes(p.toLowerCase().replace(/\s+/g, ' '))) return p;
  }
  return null;
}

/** 超时后尽力杀掉整棵进程树：Windows 用 taskkill /T，posix 退而求其次杀直接子进程 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
      return;
    } catch {
      // 落到下面的兜底
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // 进程可能已退出
  }
}

/**
 * 构建 run_command 工具：强制 cwd 落在 allowedCwds（= 共享 workspaceDirs）白名单内 + 命令黑名单 + 超时。
 * allowedCwds 为空 = 一律拒绝（fail-closed）。
 */
export function buildBashTool(allowedCwds: string[], config: BashToolConfig): Record<string, Tool> {
  const { denyPatterns, timeoutMs } = config;

  const run_command = tool({
    description:
      '在指定工作目录下执行一条 shell 命令并返回 stdout/stderr/退出码。cwd 必须落在白名单目录内；部分危险命令被黑名单拦截。',
    inputSchema: z.object({
      command: z.string().describe('要执行的 shell 命令'),
      cwd: z.string().describe('工作目录绝对路径（必须在白名单内）'),
    }),
    execute: async ({ command, cwd }) => {
      // 1. cwd 白名单（realpath 校验，挡住指向白名单外的 junction/symlink 目录）
      let safeCwd: string;
      try {
        safeCwd = assertRealpathAllowed(cwd, allowedCwds);
      } catch (e) {
        return `错误：${(e as Error).message}`;
      }
      // 2. 命令黑名单
      const denied = findDenied(command, denyPatterns);
      if (denied) {
        return `错误：命令被安全黑名单拦截（命中 "${denied}"），已拒绝执行`;
      }
      // 3. 执行：自管超时定时器，超时杀整棵进程树（exec 自带 timeout 只发 SIGTERM，
      //    Windows 上杀不掉子进程，会留下孤儿进程）
      return await new Promise<string>((resolvePromise) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        const child = exec(
          command,
          { cwd: safeCwd, maxBuffer: MAX_BUFFER, windowsHide: true },
          (err, stdout, stderr) => {
            if (timer) clearTimeout(timer);
            const out = truncate(String(stdout ?? ''));
            const errOut = truncate(String(stderr ?? ''));
            if (timedOut) {
              resolvePromise(`命令超时（>${timeoutMs}ms），已终止进程树\nstdout:\n${out || '(空)'}\nstderr:\n${errOut || '(空)'}`);
              return;
            }
            if (err) {
              const e = err as NodeJS.ErrnoException & { code?: number | string };
              resolvePromise(
                `退出码 ${e.code ?? '未知'}\nstdout:\n${out || '(空)'}\nstderr:\n${errOut || '(空)'}`
              );
              return;
            }
            resolvePromise(`退出码 0\nstdout:\n${out || '(空)'}\nstderr:\n${errOut || '(空)'}`);
          }
        );
        timer = setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, timeoutMs);
      });
    },
  });

  return { run_command };
}
