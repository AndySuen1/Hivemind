// 权限中转：实现 Agent SDK 的 canUseTool 回调，把 Claude 的工具批准 / 澄清问题接到 Discord。
//
// 策略「只对真危险操作问」（用户选定）：
//   - 只读/低危工具（Read/Glob/Grep/LS/WebSearch…）→ 直接放行
//   - 写文件（Write/Edit/NotebookEdit…）→ 直接放行（cwd 已被 SDK 限定在 workspaceDirs 内）
//   - Bash → **解析命令内容**：命中危险模式（git push / rm / 网络抓取 / 装包 / 提权…）才弹 Discord 按钮，否则放行
//   - WebFetch（网络抓取）/ 未知工具 → 弹按钮（保守）
//   - AskUserQuestion → 弹 Discord select 菜单收集答案，按 SDK 约定回喂 { questions, answers }
//
// ⚠️ 这是**弱护栏**：Bash 命令匹配是启发式，命令可绕（变量、base64、绝对路径等）。真正的边界是
// allowedRequesters（默认只本人）+ cwd 白名单 + 只把委派工具给可信 bot。详见方案安全章节。

import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { SendableChannels } from 'discord.js';
import { askPermission, askChoice } from './discord-ui.js';
import { recorder } from '../recorder.js';

/** 可观测性上下文：委派内权限/反问事件挂在 delegate_start（parentEventId）之下。 */
export interface RelayObserveContext {
  runId: string;
  sessionId: string;
  botId: string;
  parentEventId?: string;
}

export interface RelayContext {
  botName: string;
  requesterId: string;
  channel: SendableChannels;
  signal: AbortSignal;
  /** 单个权限按钮的等待超时（ms），超时默认拒绝 */
  permissionTimeoutMs: number;
  /** AskUserQuestion 的等待超时（ms） */
  questionTimeoutMs: number;
  /** 缺省则不记录权限/反问事件（best-effort）。 */
  observe?: RelayObserveContext;
}

// 只读 / 低危：直接放行，不打扰用户
const ALWAYS_ALLOW = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'BashOutput',
  'WebSearch', // 仅搜索（只读）；抓取任意 URL 的 WebFetch 仍要问
]);

// 写文件类：按用户策略「只对真危险操作问」自动放行（cwd 已被限定在工作目录白名单内）
const ALLOW_WRITE = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// 危险 Bash 命令模式（命中才弹按钮）。子串匹配，大小写不敏感，空白折叠。
// 注意：归一化后的命令首尾各补了一个空格，所以带尾空格的模式（如 'rm -rf '）能强制词边界，
// 避免 'rm -r' 误命中 'rm -rogue-bin' 这类程序名（减少误报）。
const DANGEROUS_BASH = [
  'git push',
  'rm -rf ', 'rm -r ', 'rm -f ', 'rmdir ', 'del /', 'del -',
  'format ', 'mkfs', 'dd if=', 'dd of=', '> /dev/',
  'curl ', 'wget ', 'iwr ', 'invoke-webrequest',
  'npm i ', 'npm install', 'npm publish', 'pnpm add', 'pnpm install',
  'yarn add', 'yarn install', 'pip install', 'pipx ', 'npx ',
  'sudo ', 'shutdown', 'reboot',
];

/** 把命令归一化（小写 + 折叠空白 + 首尾补空格）后做危险模式子串匹配，返回命中的模式或 null。 */
function matchDangerousBash(command: string): string | null {
  const normalized = ` ${command.toLowerCase().replace(/\s+/g, ' ')} `;
  for (const p of DANGEROUS_BASH) {
    if (normalized.includes(p)) return p.trim();
  }
  return null;
}

type Classification =
  | { action: 'allow' }
  | { action: 'ask'; title: string; detail?: string };

function classify(toolName: string, input: Record<string, unknown>): Classification {
  if (ALWAYS_ALLOW.has(toolName) || ALLOW_WRITE.has(toolName)) return { action: 'allow' };

  if (toolName === 'Bash') {
    const command = String(input.command ?? '');
    const hit = matchDangerousBash(command);
    if (hit) return { action: 'ask', title: `Claude 想执行命令（命中危险模式「${hit}」）`, detail: command };
    return { action: 'allow' };
  }

  if (toolName === 'WebFetch') {
    return { action: 'ask', title: 'Claude 想抓取网页（网络请求）', detail: String(input.url ?? '') };
  }

  // 未知工具：保守起见弹按钮确认
  return { action: 'ask', title: `Claude 想使用工具 ${toolName}`, detail: safeJson(input) };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v).slice(0, 800);
  } catch {
    return String(v);
  }
}

/** 创建绑定到某次委派的 canUseTool 回调。 */
export function createPermissionHandler(ctx: RelayContext): CanUseTool {
  return async (toolName, input, opts): Promise<PermissionResult> => {
    if (ctx.signal.aborted) return { behavior: 'deny', message: '任务已被取消', interrupt: true };

    if (toolName === 'AskUserQuestion') {
      return relayAskUserQuestion(ctx, input);
    }

    // 弹 Discord 按钮等用户决定（allow 用原 input，deny 带原因/中断）
    const ask = async (title: string, detail?: string): Promise<PermissionResult> => {
      const obs = ctx.observe;
      if (obs) {
        recorder.recordEvent({
          runId: obs.runId, sessionId: obs.sessionId, botId: obs.botId,
          type: 'permission_request', toolName, label: '🔐 权限请求', status: 'pending',
          input: { title, detail }, parentEventId: obs.parentEventId,
        });
      }
      const decision = await askPermission({
        channel: ctx.channel,
        requesterId: ctx.requesterId,
        signal: ctx.signal,
        title: `**${ctx.botName}** ${title}`,
        detail,
        timeoutMs: ctx.permissionTimeoutMs,
      });
      if (obs) {
        recorder.recordEvent({
          runId: obs.runId, sessionId: obs.sessionId, botId: obs.botId,
          type: 'permission_decision', toolName, label: '🔐 权限裁决', status: decision,
          parentEventId: obs.parentEventId,
        });
      }
      if (decision === 'allow') return { behavior: 'allow', updatedInput: input };
      if (decision === 'aborted') return { behavior: 'deny', message: '任务被取消', interrupt: true };
      return {
        behavior: 'deny',
        message: decision === 'timeout' ? '用户超时未批准，已默认拒绝该操作' : '用户在 Discord 拒绝了该操作',
      };
    };

    // SDK 判定该操作触达了工作目录外的路径（Bash 命令越界、写到 cwd 外等）→ 一律确认，
    // 不管工具是不是「自动放行」类。这是用 SDK 自己的边界检测兜住越界访问的安全网。
    if (typeof opts?.blockedPath === 'string' && opts.blockedPath) {
      const t = (typeof opts.title === 'string' && opts.title) || `${toolName} 想访问工作目录外的路径`;
      return ask(t, `越界路径：${opts.blockedPath}`);
    }

    const c = classify(toolName, input);
    if (c.action === 'allow') return { behavior: 'allow', updatedInput: input };

    // 优先用 SDK 渲染好的权限提示句（更准确），否则用我们分类出的 title
    const title = (typeof opts?.title === 'string' && opts.title) || c.title;
    return ask(title, c.detail);
  };
}

interface AskQuestion {
  question?: unknown;
  header?: unknown;
  options?: unknown;
  multiSelect?: unknown;
}

/**
 * 把 AskUserQuestion 的每个问题逐一发到 Discord（select 菜单），收集答案后按 SDK 约定回喂：
 * `{ behavior:'allow', updatedInput:{ questions, answers } }`，answers 的键是完整问题文本，
 * 值是选中的 label（multiSelect 为 label 数组）。
 */
async function relayAskUserQuestion(
  ctx: RelayContext,
  input: Record<string, unknown>
): Promise<PermissionResult> {
  const questions = Array.isArray(input.questions) ? (input.questions as AskQuestion[]) : [];
  if (!questions.length) return { behavior: 'allow', updatedInput: input };

  const answers: Record<string, string | string[]> = {};
  for (const q of questions) {
    const questionText = String(q.question ?? '');
    const header = String(q.header ?? '');
    const rawOptions = Array.isArray(q.options) ? q.options : [];
    const options = rawOptions.map((o) => {
      const obj = (o ?? {}) as Record<string, unknown>;
      return {
        label: String(obj.label ?? ''),
        description: obj.description != null ? String(obj.description) : undefined,
      };
    });
    const multiSelect = q.multiSelect === true;

    const chosen = await askChoice({
      channel: ctx.channel,
      requesterId: ctx.requesterId,
      signal: ctx.signal,
      prompt: header ? `**${header}** — ${questionText}` : questionText,
      options,
      multiSelect,
      timeoutMs: ctx.questionTimeoutMs,
    });

    if (chosen === null) {
      // 超时/中止：拒绝整个澄清，让 Claude 基于现有信息合理推进或停下说明
      recordAskQuestion(ctx, questions, answers, 'timeout');
      return {
        behavior: 'deny',
        message: '用户未在限定时间内回答澄清问题。请基于现有信息做合理假设继续，或停止并说明你需要哪些信息。',
      };
    }
    answers[questionText] = multiSelect ? chosen : (chosen[0] ?? '');
  }

  recordAskQuestion(ctx, questions, answers, 'answered');
  return { behavior: 'allow', updatedInput: { ...input, questions, answers } };
}

/** 记一条 ask_question 事件（反问的问题 + 收集到的答案），挂在 delegate_start 之下。 */
function recordAskQuestion(
  ctx: RelayContext,
  questions: AskQuestion[],
  answers: Record<string, string | string[]>,
  status: 'answered' | 'timeout'
): void {
  const obs = ctx.observe;
  if (!obs) return;
  recorder.recordEvent({
    runId: obs.runId,
    sessionId: obs.sessionId,
    botId: obs.botId,
    type: 'ask_question',
    label: '❓ 向你提问',
    status,
    input: questions,
    output: answers,
    parentEventId: obs.parentEventId,
  });
}
