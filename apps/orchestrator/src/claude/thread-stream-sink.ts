// Claude 帖直通的逐字贴帖渲染器（实现 delegation-core 的 ClaudeStreamSink）。
// 对比委派的「编辑单条状态消息」：这里把 Claude 的每段文本 / 每条命令原文 / 每个工具结果
// **逐条 send 进帖子**（按「步」实时）。
//
// 与 discord.js 解耦：只依赖一个 ThreadStreamTarget（send/sendFile/now/sleep），
// 由 bot-manager 包真实 thread channel 注入，冒烟测试注入 mock。这样渲染逻辑可纯逻辑单测。
//
// 限流防护：内置串行发送队列（保证有序）+ 滑窗节流（最近 5 条 / 5 秒）+ 大输出转附件 + 1900 分块。

import type { ClaudeStreamSink, ClaudeToolResult, ClaudeToolUse, RateLimitInfo } from './delegation-core.js';
import { toolLabel } from './delegation-core.js';

const MAX_CONTENT = 1900; // Discord 硬上限 2000，留余量给前缀
const RESULT_ATTACH_THRESHOLD = 1700; // 工具结果超此长度 → 转附件，避免刷屏/撑爆
const SNIPPET_MAX = 600; // Write/Edit 片段预览上限
const WINDOW_SIZE = 5; // 滑窗：最近 N 条
const WINDOW_MS = 5000; // 滑窗时长（Discord 约 5 条/5 秒）

/** 渲染器的输出端（由 bot-manager 包真实 thread channel；测试注入 mock）。 */
export interface ThreadStreamTarget {
  send(content: string): Promise<void>;
  sendFile(name: string, content: string): Promise<void>;
  /** 可注入时钟/睡眠以便测试节流；缺省用真实实现。 */
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

// 纯读类工具的结果不贴（噪音大：文件全文/目录列表等）；tool_use 行已说明「读取了什么」。
const QUIET_RESULT_TOOLS = new Set(['Read', 'Glob', 'LS', 'NotebookRead', 'TodoWrite']);

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** 用比内容里最长 ``` 连串更长的围栏包裹，避免内容含 ``` 破坏代码块。 */
function fence(content: string, lang = ''): string {
  let max = 0;
  let cur = 0;
  for (const ch of content) {
    if (ch === '`') { cur++; if (cur > max) max = cur; } else cur = 0;
  }
  const ticks = '`'.repeat(Math.max(3, max + 1));
  return `${ticks}${lang}\n${content}\n${ticks}`;
}

/** tool_result 的 content（字符串 / text 块数组 / 其它）归一化为纯文本。 */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const blk = (b ?? {}) as { type?: string; text?: string };
        return blk.type === 'text' && typeof blk.text === 'string' ? blk.text : '';
      })
      .join('');
  }
  if (content == null) return '';
  return safeJson(content);
}

/** 一条 tool_use → 给用户看的「命令原文」展示（按工具类型）。 */
function formatToolUse(tu: ClaudeToolUse): { header: string; body?: string; lang?: string } {
  const input = (tu.input ?? {}) as Record<string, unknown>;
  switch (tu.name) {
    case 'Bash': {
      const cmd = String(input.command ?? '');
      const desc = input.description ? ` — ${String(input.description)}` : '';
      return { header: `🔧 **执行命令**${desc}`, body: cmd, lang: 'bash' };
    }
    case 'Write': {
      const path = String(input.file_path ?? input.path ?? '');
      const content = String(input.content ?? '');
      const snippet = content.length > SNIPPET_MAX ? content.slice(0, SNIPPET_MAX) + '\n…（已截断）' : content;
      return { header: `✏️ **写文件** \`${path}\``, body: snippet || undefined };
    }
    case 'Edit':
    case 'MultiEdit': {
      const path = String(input.file_path ?? input.path ?? '');
      const oldS = String(input.old_string ?? '');
      const newS = String(input.new_string ?? '');
      const diff = oldS || newS
        ? `- ${oldS.slice(0, SNIPPET_MAX / 2)}\n+ ${newS.slice(0, SNIPPET_MAX / 2)}`
        : undefined;
      return { header: `✏️ **改文件** \`${path}\``, body: diff, lang: 'diff' };
    }
    case 'Read':
      return { header: `🔎 读取 \`${String(input.file_path ?? input.path ?? '')}\`` };
    case 'Grep':
      return { header: `🔎 搜索 \`${String(input.pattern ?? '')}\`` };
    case 'Glob':
      return { header: `🔎 查找 \`${String(input.pattern ?? '')}\`` };
    case 'LS':
      return { header: `🔎 列目录 \`${String(input.path ?? '')}\`` };
    case 'WebFetch':
      return { header: `🌐 抓取 ${String(input.url ?? '')}` };
    case 'WebSearch':
      return { header: `🌐 搜索 ${String(input.query ?? '')}` };
    case 'TodoWrite':
      return { header: `📝 更新任务清单` };
    default:
      return { header: `${toolLabel(tu.name)} \`${tu.name}\``, body: safeJson(input), lang: 'json' };
  }
}

export class ThreadStreamSink implements ClaudeStreamSink {
  private chain: Promise<void> = Promise.resolve();
  private sentAt: number[] = [];
  private readonly toolNameById = new Map<string, string>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly target: ThreadStreamTarget,
    private readonly opts: { quiet?: boolean } = {}
  ) {
    this.now = target.now ?? (() => Date.now());
    this.sleep = target.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // ---------- ClaudeStreamSink ----------

  async onAssistant(text: string, toolUses: ClaudeToolUse[]): Promise<void> {
    if (this.opts.quiet) return;
    const t = text.trim();
    if (t) this.postText(t);
    for (const tu of toolUses) {
      if (tu.id) this.toolNameById.set(tu.id, tu.name);
      const { header, body, lang } = formatToolUse(tu);
      this.postBlock(header, body, lang, `${tu.name}.txt`);
    }
  }

  async onToolResult(results: ClaudeToolResult[]): Promise<void> {
    if (this.opts.quiet) return;
    for (const r of results) {
      const toolName = r.toolUseId ? this.toolNameById.get(r.toolUseId) : undefined;
      if (toolName && QUIET_RESULT_TOOLS.has(toolName) && !r.isError) continue; // 纯读结果不贴
      const text = toolResultText(r.content).trimEnd();
      if (!text) continue;
      const head = r.isError ? '⚠️ 结果（出错）' : '↳ 结果';
      this.postBlock(head, text, '', 'output.txt');
    }
  }

  async onRateLimit(_info: RateLimitInfo, rejected: boolean): Promise<void> {
    if (rejected) this.postText('⚠️ 已触达订阅用量上限（被限流），稍后会自动恢复。');
  }

  // ---------- 公共：收尾文案 + 等待清空 ----------

  /** 直接贴一行系统文案（建帖提示 / 收尾 / 错误等）。 */
  notice(line: string): void {
    this.postText(line);
  }

  /** 等待所有排队的发送落地（turn 结束 / abort / 拒绝时强制 flush，避免停在半截）。 */
  async flush(): Promise<void> {
    await this.chain.catch(() => {});
  }

  // ---------- 内部：分块 / 围栏 / 串行队列 + 滑窗节流 ----------

  private postText(text: string): void {
    for (const chunk of chunk1900(text)) this.enqueue(() => this.target.send(chunk));
  }

  /**
   * 贴一个「标题 + 可选代码块正文」：能塞进一条就一条；正文过长 → 标题单发 + 正文转附件。
   */
  private postBlock(header: string, body: string | undefined, lang: string | undefined, fileName: string): void {
    if (!body) {
      this.postText(header);
      return;
    }
    const fenced = `${header}\n${fence(body, lang ?? '')}`;
    if (body.length <= RESULT_ATTACH_THRESHOLD && fenced.length <= MAX_CONTENT) {
      this.enqueue(() => this.target.send(fenced));
    } else {
      this.postText(header + '\n（内容较长，见附件）');
      this.enqueue(() => this.target.sendFile(fileName, body));
    }
  }

  private enqueue(fn: () => Promise<void>): void {
    this.chain = this.chain.then(async () => {
      await this.throttle();
      try {
        await fn();
      } catch (e) {
        console.error('[thread-sink] 发送失败（已忽略，丢这一帧）', (e as Error).message);
      }
    });
  }

  /** 滑窗节流：最近 WINDOW_SIZE 条若都落在 WINDOW_MS 内，则等到窗口腾出位置再发。 */
  private async throttle(): Promise<void> {
    const now = this.now();
    this.sentAt = this.sentAt.filter((t) => now - t < WINDOW_MS);
    if (this.sentAt.length >= WINDOW_SIZE) {
      const waitMs = WINDOW_MS - (now - this.sentAt[0]!);
      if (waitMs > 0) await this.sleep(waitMs);
      const after = this.now();
      this.sentAt = this.sentAt.filter((t) => after - t < WINDOW_MS);
    }
    this.sentAt.push(this.now());
  }
}

/** 按 1900 分块（不破坏多字节；优先在换行处切）。 */
export function chunk1900(text: string): string[] {
  if (text.length <= MAX_CONTENT) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > MAX_CONTENT) {
    let cut = rest.lastIndexOf('\n', MAX_CONTENT);
    if (cut < MAX_CONTENT * 0.5) cut = MAX_CONTENT; // 没有合适换行就硬切
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}
