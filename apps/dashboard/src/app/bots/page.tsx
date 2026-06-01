'use client';

import { useEffect, useState } from 'react';
import type { BotCreate, BotUpdate, BotTools, Provider } from '@hivemind/shared';
import { DEFAULT_DENY_PATTERNS } from '@hivemind/shared';
import { botsApi, providersApi, type BotWithRuntime } from '@/lib/api';

const linesToArr = (s: string): string[] =>
  s.split('\n').map((x) => x.trim()).filter(Boolean);

export default function BotsPage() {
  const [bots, setBots] = useState<BotWithRuntime[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = async () => {
    try {
      const [b, p] = await Promise.all([botsApi.list(), providersApi.list()]);
      setBots(b);
      setProviders(p);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="max-w-4xl">
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-2xl font-bold">Bots</h2>
        <button
          onClick={() => setShowNew((s) => !s)}
          disabled={providers.length === 0}
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          title={providers.length === 0 ? '请先创建至少一个 Provider' : ''}
        >
          {showNew ? '取消' : '+ 新建'}
        </button>
      </div>

      {err && <div className="mb-4 rounded bg-red-50 p-3 text-sm text-red-700">{err}</div>}
      {providers.length === 0 && (
        <div className="mb-4 rounded bg-amber-50 p-3 text-sm text-amber-800">
          ⚠️ 还没有 Provider，请先去 <a href="/providers" className="underline">Providers</a> 创建一个
        </div>
      )}

      {showNew && (
        <BotForm
          mode="create"
          providers={providers}
          onDone={() => {
            setShowNew(false);
            refresh();
          }}
          onCancel={() => setShowNew(false)}
        />
      )}

      {loading ? (
        <div className="text-zinc-500">加载中…</div>
      ) : bots.length === 0 ? (
        <div className="rounded border border-dashed border-zinc-300 bg-white p-8 text-center text-zinc-500">
          还没有 bot
        </div>
      ) : (
        <div className="space-y-2">
          {bots.map((b) => (
            <BotRow key={b.id} bot={b} providers={providers} onChange={refresh} />
          ))}
        </div>
      )}
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = {
  online: 'bg-green-100 text-green-800',
  connecting: 'bg-amber-100 text-amber-800',
  offline: 'bg-zinc-100 text-zinc-600',
  error: 'bg-red-100 text-red-800',
};

function BotRow({
  bot,
  providers,
  onChange,
}: {
  bot: BotWithRuntime;
  providers: Provider[];
  onChange: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const provider = providers.find((p) => p.id === bot.providerId);

  if (editing) {
    return (
      <BotForm
        mode="edit"
        existing={bot}
        providers={providers}
        onDone={() => {
          setEditing(false);
          onChange();
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  const onToggleEnabled = async () => {
    setBusy(true);
    try {
      await botsApi.update(bot.id, { enabled: !bot.enabled });
      onChange();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (!confirm(`删除 bot "${bot.name}"？`)) return;
    setBusy(true);
    try {
      await botsApi.delete(bot.id);
      onChange();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded border border-zinc-200 bg-white p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{bot.name}</span>
            <span className={`rounded px-2 py-0.5 text-xs ${STATUS_COLOR[bot.runtime.status]}`}>
              {bot.runtime.status}
            </span>
            {bot.enabled && <span className="text-xs text-blue-600">已启用</span>}
          </div>
          <div className="mt-1 space-y-0.5 text-xs text-zinc-500">
            <div>
              Provider: {provider?.name ?? '(已删除)'} → <code className="rounded bg-zinc-100 px-1">{provider?.model ?? '?'}</code>
              {' · '}temp <code className="rounded bg-zinc-100 px-1">{bot.temperature.toFixed(1)}</code>
              {bot.allowedRequesters.length > 0 && ` · allowlist ${bot.allowedRequesters.length} 人`}
            </div>
            <ToolBadges tools={bot.tools} />
            <div className="text-zinc-400 break-all">系统提示词：{bot.systemPrompt.slice(0, 80)}{bot.systemPrompt.length > 80 ? '…' : ''}</div>
            <div className="text-zinc-400">ID: <code className="text-[10px]">{bot.id}</code></div>
          </div>
          {bot.runtime.errorMessage && (
            <div className="mt-2 rounded bg-red-50 p-2 text-xs text-red-700">⚠️ {bot.runtime.errorMessage}</div>
          )}
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <button
            onClick={onToggleEnabled}
            disabled={busy}
            className="rounded border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50"
          >
            {bot.enabled ? '禁用' : '启用'}
          </button>
          <button
            onClick={() => setEditing(true)}
            disabled={busy}
            className="rounded border border-blue-300 px-3 py-1 text-xs text-blue-700 hover:bg-blue-50 disabled:opacity-50"
          >
            编辑
          </button>
          <button
            onClick={onDelete}
            disabled={busy}
            className="rounded border border-red-300 px-3 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

type BotFormProps =
  | {
      mode: 'create';
      existing?: never;
      providers: Provider[];
      onDone: () => void;
      onCancel: () => void;
    }
  | {
      mode: 'edit';
      existing: BotWithRuntime;
      providers: Provider[];
      onDone: () => void;
      onCancel: () => void;
    };

function BotForm(props: BotFormProps) {
  const isEdit = props.mode === 'edit';
  const firstProvider = props.providers[0];

  const [name, setName] = useState(props.existing?.name ?? '');
  const [providerId, setProviderId] = useState(props.existing?.providerId ?? firstProvider?.id ?? '');
  const [systemPrompt, setSystemPrompt] = useState(props.existing?.systemPrompt ?? '你是一个友好、简洁的中文助手。');
  const [temperature, setTemperature] = useState(props.existing?.temperature ?? 1.3);
  const [allowedRaw, setAllowedRaw] = useState(props.existing?.allowedRequesters.join('\n') ?? '');
  const [enabled, setEnabled] = useState(props.existing?.enabled ?? true);
  const [discordToken, setDiscordToken] = useState('');

  // 工具配置
  const t = props.existing?.tools;
  const [wsDirs, setWsDirs] = useState(t?.workspaceDirs.join('\n') ?? '');
  const [fsEnabled, setFsEnabled] = useState(t?.fs.enabled ?? false);
  const [bashEnabled, setBashEnabled] = useState(t?.bash.enabled ?? false);
  const [bashDeny, setBashDeny] = useState((t?.bash.denyPatterns ?? DEFAULT_DENY_PATTERNS).join('\n'));
  const [bashTimeout, setBashTimeout] = useState(t?.bash.timeoutMs ?? 30000);
  const [memEnabled, setMemEnabled] = useState(t?.memory.enabled ?? false);
  const [webEnabled, setWebEnabled] = useState(t?.webSearch.enabled ?? false);
  const [claudeEnabled, setClaudeEnabled] = useState(t?.claudeCode.enabled ?? false);
  const [claudeMaxTurns, setClaudeMaxTurns] = useState(t?.claudeCode.maxTurns ?? 30);
  const [claudeTimeoutMin, setClaudeTimeoutMin] = useState(Math.round((t?.claudeCode.timeoutMs ?? 1_200_000) / 60000));
  // 对话记忆（窗口/摘要/检索）。windowTurns=0 表示用全局默认 BOT_HISTORY_TURNS。
  // 用可选链兜底：旧 API 响应/旧库数据可能尚无 conversationMemory 段，缺失时退默认，绝不让表单崩。
  const [convWindow, setConvWindow] = useState(t?.conversationMemory?.windowTurns ?? 0);
  const [convSummary, setConvSummary] = useState(t?.conversationMemory?.summaryEnabled ?? true);
  const [convRetrieval, setConvRetrieval] = useState(t?.conversationMemory?.retrievalEnabled ?? true);

  const selectedProvider = props.providers.find((p) => p.id === providerId);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setErr(null);
    try {
      const allowedRequesters = allowedRaw
        .split(/[,\s\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);

      const tools: BotTools = {
        workspaceDirs: linesToArr(wsDirs),
        fs: { enabled: fsEnabled },
        bash: {
          enabled: bashEnabled,
          denyPatterns: linesToArr(bashDeny),
          timeoutMs: bashTimeout,
        },
        memory: { enabled: memEnabled },
        conversationMemory: {
          summaryEnabled: convSummary,
          retrievalEnabled: convRetrieval,
          ...(convWindow > 0 ? { windowTurns: convWindow } : {}),
        },
        webSearch: { enabled: webEnabled },
        claudeCode: {
          enabled: claudeEnabled,
          maxTurns: claudeMaxTurns,
          timeoutMs: Math.max(1, claudeTimeoutMin) * 60000,
        },
      };

      if (isEdit) {
        const patch: BotUpdate = {
          name,
          providerId,
          systemPrompt,
          temperature,
          tools,
          allowedRequesters,
          enabled,
        };
        if (discordToken) patch.discordToken = discordToken;
        await botsApi.update(props.existing.id, patch);
      } else {
        if (!discordToken) throw new Error('新建时 Discord Token 必填');
        const input: BotCreate = {
          name,
          providerId,
          systemPrompt,
          temperature,
          tools,
          allowedRequesters,
          enabled,
          discordToken,
        };
        await botsApi.create(input);
      }
      props.onDone();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="mb-6 space-y-3 rounded border border-zinc-200 bg-white p-4">
      <div className="mb-2 text-sm font-semibold text-zinc-700">
        {isEdit ? `编辑「${props.existing.name}」` : '新建 Bot'}
      </div>
      <Field label="Bot 名称（日志/列表显示，非 Discord 显示名）">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="PM-Alice"
          className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
          required
        />
      </Field>
      <Field label={isEdit ? 'Discord Bot Token（留空 = 保持原值）' : 'Discord Bot Token（存入 Windows Credential Manager）'}>
        <input
          type="password"
          value={discordToken}
          onChange={(e) => setDiscordToken(e.target.value)}
          placeholder={isEdit ? '••••••••（不改就留空）' : ''}
          className="w-full rounded border border-zinc-300 px-3 py-2 text-sm font-mono"
          required={!isEdit}
        />
      </Field>
      <Field label="Provider（决定用哪个 API endpoint + 模型）">
        <select
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
          className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
          required
        >
          {props.providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} → {p.model}
            </option>
          ))}
        </select>
        {selectedProvider && (
          <div className="mt-1 text-[11px] text-zinc-500">
            想用别的模型？去 <a href="/providers" className="underline">Providers</a> 多加一个（API key 可以一样，model 不同）
          </div>
        )}
      </Field>
      <Field label="系统提示词（人格/工种）">
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={4}
          className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
        />
      </Field>
      <Field label={`Temperature: ${temperature.toFixed(1)}（DeepSeek 官方推荐：编程/数学 0.0 · 数据分析 1.0 · 对话/翻译 1.3 · 创作 1.5）`}>
        <input
          type="range"
          min={0}
          max={2}
          step={0.1}
          value={temperature}
          onChange={(e) => setTemperature(Number(e.target.value))}
          className="w-full"
        />
        <div className="mt-1 flex justify-between text-[10px] text-zinc-400">
          <span>0.0 严谨</span>
          <span>1.0</span>
          <span>1.3 对话</span>
          <span>1.5 创作</span>
          <span>2.0 发散</span>
        </div>
      </Field>
      <Field label="Allowlist Discord User ID（多个用逗号/空格/换行分隔，留空 = 不限制）">
        <textarea
          value={allowedRaw}
          onChange={(e) => setAllowedRaw(e.target.value)}
          placeholder="1234567890123456789"
          rows={2}
          className="w-full rounded border border-zinc-300 px-3 py-2 text-sm font-mono"
        />
      </Field>

      {/* ============ 工具配置 ============ */}
      <div className="space-y-3 rounded border border-zinc-200 bg-zinc-50 p-3">
        <div className="text-xs font-semibold text-zinc-700">工具（让 bot 能读写文件、跑命令、记长期记忆、联网搜索）</div>

        {/* 共享工作目录：fs 访问边界 + bash/claude 起始 cwd，只在勾了 fs/bash/claude 时显示 */}
        {(fsEnabled || bashEnabled || claudeEnabled) && (
          <div className="rounded border border-indigo-200 bg-indigo-50/50 p-3">
            <div className="mb-1 text-[11px] font-medium text-indigo-700">
              工作目录白名单（fs / bash / Claude 委派共用：fs 的可访问范围 + bash 与 Claude 子进程的起始 cwd；每行一个绝对路径，留空 = 全部拒绝）
            </div>
            <textarea
              value={wsDirs}
              onChange={(e) => setWsDirs(e.target.value)}
              rows={2}
              placeholder={'D:\\workspaces\\bot-a'}
              className="w-full rounded border border-zinc-300 px-3 py-2 text-xs font-mono"
            />
            <div className="mt-1 text-[10px] text-zinc-400">
              ⚠️ bash 的命令可用绝对路径越出此范围（cwd 只是起始目录、不是沙箱）；真正的访问控制靠下面的 allowlist。bash/fs 只给可信 bot。
            </div>
          </div>
        )}

        {/* fs */}
        <div className="rounded border border-zinc-200 bg-white p-3">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={fsEnabled} onChange={(e) => setFsEnabled(e.target.checked)} />
            <span className="text-sm font-medium">文件系统 fs</span>
            <span className="text-[11px] text-zinc-400">read / write / edit / list / grep（范围 = 工作目录）</span>
          </label>
        </div>

        {/* bash */}
        <div className="rounded border border-zinc-200 bg-white p-3">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={bashEnabled} onChange={(e) => setBashEnabled(e.target.checked)} />
            <span className="text-sm font-medium">命令行 bash</span>
            <span className="text-[11px] text-zinc-400">run_command（cwd = 工作目录 + 命令黑名单 + 超时）</span>
          </label>
          {bashEnabled && (
            <div className="mt-2 space-y-2">
              <div>
                <div className="mb-1 text-[11px] text-zinc-500">命令黑名单（子串匹配，大小写不敏感，每行一条）</div>
                <textarea
                  value={bashDeny}
                  onChange={(e) => setBashDeny(e.target.value)}
                  rows={3}
                  className="w-full rounded border border-zinc-300 px-3 py-2 text-xs font-mono"
                />
              </div>
              <label className="block">
                <div className="mb-1 text-[11px] text-zinc-500">单条命令超时（毫秒）</div>
                <input
                  type="number"
                  min={1000}
                  max={600000}
                  step={1000}
                  value={bashTimeout}
                  onChange={(e) => setBashTimeout(Number(e.target.value))}
                  className="w-40 rounded border border-zinc-300 px-3 py-2 text-xs"
                />
              </label>
            </div>
          )}
        </div>

        {/* memory */}
        <div className="rounded border border-zinc-200 bg-white p-3">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={memEnabled} onChange={(e) => setMemEnabled(e.target.checked)} />
            <span className="text-sm font-medium">长期记忆 memory</span>
            <span className="text-[11px] text-zinc-400">跨会话，存于 bot-memory/&lt;botId&gt;/</span>
          </label>
          {memEnabled && (
            <div className="mt-1 text-[11px] text-zinc-500">
              开启后，达一定轮数或会话空闲时会自动把对话要点「整理」固化进上面的长期记忆文件（合并去重、总量封顶）。
            </div>
          )}
        </div>

        {/* 对话记忆：窗口 / 摘要 / 检索（与长期记忆文件不同，管的是「还记得多久前的对话」） */}
        <div className="rounded border border-zinc-200 bg-white p-3">
          <div className="text-sm font-medium">对话记忆（会话连续性）</div>
          <div className="mt-1 text-[11px] text-zinc-400">
            决定 bot「还记得多久前的对话」。重启后会从历史自动复原。与上面的长期记忆文件是两套机制。
          </div>
          <div className="mt-2 space-y-2">
            <label className="block">
              <div className="mb-1 text-[11px] text-zinc-500">近期逐字窗口（轮数，0 = 用全局默认 BOT_HISTORY_TURNS=20）</div>
              <input
                type="number"
                min={0}
                max={100}
                value={convWindow}
                onChange={(e) => setConvWindow(Number(e.target.value))}
                className="w-32 rounded border border-zinc-300 px-3 py-2 text-xs"
              />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={convSummary} onChange={(e) => setConvSummary(e.target.checked)} />
              <span className="text-xs">滚动摘要（把更早对话压缩成摘要，记住整段会话且省 token）</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={convRetrieval} onChange={(e) => setConvRetrieval(e.target.checked)} />
              <span className="text-xs">历史检索（按当前提问从更早消息召回相关片段）</span>
            </label>
          </div>
        </div>

        {/* web search */}
        <div className="rounded border border-zinc-200 bg-white p-3">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={webEnabled} onChange={(e) => setWebEnabled(e.target.checked)} />
            <span className="text-sm font-medium">联网搜索 web_search</span>
          </label>
          {webEnabled && (
            <div className="mt-1 text-[11px] text-zinc-500">
              开启即用——系统自动按优先级 <code className="rounded bg-zinc-100 px-1">SearXNG → Brave → Tavily → DuckDuckGo</code> 选「已配置且当天还有余量」的源（在 <a href="/providers" className="underline">Providers</a> 页配 key/URL）。无需勾选或设上限；内置防失控护栏。
            </div>
          )}
        </div>

        {/* claude code 委派 */}
        <div className="rounded border border-zinc-200 bg-white p-3">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={claudeEnabled} onChange={(e) => setClaudeEnabled(e.target.checked)} />
            <span className="text-sm font-medium">🤖 Claude Code 委派 delegate_to_claude</span>
            <span className="text-[11px] text-zinc-400">复杂工程任务交给 Claude（走本机订阅）</span>
          </label>
          {claudeEnabled && (
            <div className="mt-2 space-y-2">
              <div className="flex gap-3">
                <label className="block">
                  <div className="mb-1 text-[11px] text-zinc-500">最大轮数（防失控）</div>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={claudeMaxTurns}
                    onChange={(e) => setClaudeMaxTurns(Number(e.target.value))}
                    className="w-32 rounded border border-zinc-300 px-3 py-2 text-xs"
                  />
                </label>
                <label className="block">
                  <div className="mb-1 text-[11px] text-zinc-500">单次超时（分钟）</div>
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={claudeTimeoutMin}
                    onChange={(e) => setClaudeTimeoutMin(Number(e.target.value))}
                    className="w-32 rounded border border-zinc-300 px-3 py-2 text-xs"
                  />
                </label>
              </div>
              <div className="text-[11px] text-zinc-500">
                Claude 在上面的「工作目录」内干活。危险操作（删文件 / git push / 联网 / 装包）和澄清问题会**弹 Discord 按钮/菜单**等你批准；只读与普通写自动放行。并发受限（单 bot 1 个 / 全局 5 个）。
              </div>
              <div className="text-[10px] text-amber-600">
                ⚠️ 计费：6/15 起 Agent SDK 用量走独立的「Agent SDK 月度额度」（与交互式 Claude Code 分开），用尽不回落。上线前请去 claude.ai 确认 opt-in 与额度。
              </div>
            </div>
          )}
        </div>
      </div>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span className="text-sm">启用（连接 Discord）</span>
      </label>
      {err && <div className="rounded bg-red-50 p-2 text-xs text-red-700">{err}</div>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? '保存中…' : '保存'}
        </button>
        <button
          type="button"
          onClick={props.onCancel}
          className="rounded border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-50"
        >
          取消
        </button>
      </div>
    </form>
  );
}

function ToolBadges({ tools }: { tools?: BotTools }) {
  if (!tools) return null;
  const active: string[] = [];
  if (tools.fs.enabled) active.push('fs');
  if (tools.bash.enabled) active.push('bash');
  if (tools.claudeCode.enabled) active.push('claude');
  if (tools.fs.enabled || tools.bash.enabled || tools.claudeCode.enabled)
    active.push(`dirs(${tools.workspaceDirs.length})`);
  if (tools.memory.enabled) active.push('memory');
  if (tools.webSearch.enabled) active.push('web');
  if (active.length === 0) return <div className="text-zinc-300">工具：无</div>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-zinc-400">工具：</span>
      {active.map((a) => (
        <span key={a} className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-700">
          {a}
        </span>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-medium text-zinc-700">{label}</div>
      {children}
    </label>
  );
}
