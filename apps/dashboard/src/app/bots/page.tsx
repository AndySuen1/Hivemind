'use client';

import { useEffect, useRef, useState } from 'react';
import { Pencil, Plus, Power, Sparkles, Trash2, Wrench } from 'lucide-react';
import type { BotCreate, BotUpdate, BotTools, Provider } from '@hivemind/shared';
import { DEFAULT_DENY_PATTERNS } from '@hivemind/shared';
import { botsApi, providersApi, type BotWithRuntime } from '@/lib/api';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  FormModal,
  Input,
  PageContainer,
  PageHeader,
  Select,
  Skeleton,
  StatusPill,
  TabPanel,
  Tabs,
  Textarea,
  useConfirm,
  useTabs,
  useToast,
} from '@/components/ui';
import { listEq } from '@/lib/shallow-eq';

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
      // 内容相等短路：3s 轮询内容没变就不 setState，避免无谓重渲染/闪烁
      setBots((prev) =>
        listEq(prev, b, (x) => [x.id, x.runtime.status, x.enabled, x.runtime.errorMessage ?? '']) ? prev : b,
      );
      setProviders((prev) => (listEq(prev, p, (x) => [x.id, x.name, x.model]) ? prev : p));
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
    <PageContainer size="default">
      <PageHeader
        title="Bots"
        actions={
          <Button
            variant="primary"
            leftIcon={<Plus className="size-4" />}
            disabled={providers.length === 0}
            title={providers.length === 0 ? '请先创建至少一个 Provider' : ''}
            onClick={() => setShowNew(true)}
          >
            新建
          </Button>
        }
      />

      {err && <div className="mb-4 rounded bg-danger-soft p-3 text-sm text-danger-fg">{err}</div>}
      {providers.length === 0 && (
        <div className="mb-4 rounded bg-warning-soft p-3 text-sm text-warning-fg">
          ⚠️ 还没有 Provider，请先去{' '}
          <a href="/providers" className="underline">
            Providers
          </a>{' '}
          创建一个
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[132px] rounded-lg" />
          ))}
        </div>
      ) : bots.length === 0 ? (
        <EmptyState
          title="还没有 bot"
          description="创建一个 bot 并启用，连接到 Discord。"
          action={
            <Button
              variant="primary"
              leftIcon={<Plus className="size-4" />}
              disabled={providers.length === 0}
              onClick={() => setShowNew(true)}
            >
              新建 Bot
            </Button>
          }
        />
      ) : (
        <div className="space-y-2">
          {bots.map((b) => (
            <BotRow key={b.id} bot={b} providers={providers} onChange={refresh} />
          ))}
        </div>
      )}

      <BotForm
        mode="create"
        open={showNew}
        providers={providers}
        onClose={() => setShowNew(false)}
        onDone={() => {
          setShowNew(false);
          refresh();
        }}
      />
    </PageContainer>
  );
}

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
  const confirm = useConfirm();
  const { toast } = useToast();

  const onToggleEnabled = async () => {
    setBusy(true);
    try {
      await botsApi.update(bot.id, { enabled: !bot.enabled });
      onChange();
    } catch (e) {
      toast((e as Error).message, { tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    const ok = await confirm({ title: `删除 bot "${bot.name}"？`, confirmText: '删除', danger: true });
    if (!ok) return;
    setBusy(true);
    try {
      await botsApi.delete(bot.id);
      onChange();
    } catch (e) {
      toast((e as Error).message, { tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="none">
      <div className="flex items-start justify-between gap-4 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-fg">{bot.name}</span>
            <StatusPill kind="bot" status={bot.runtime.status} />
            {bot.enabled && <span className="text-xs text-primary-strong">已启用</span>}
          </div>
          <div className="mt-1 space-y-0.5 text-xs text-fg-muted">
            <div>
              Provider: {provider?.name ?? '(已删除)'} →{' '}
              <code className="rounded bg-bg-subtle px-1">{provider?.model ?? '?'}</code>
              {' · '}temp <code className="rounded bg-bg-subtle px-1">{bot.temperature.toFixed(1)}</code>
              {bot.allowedRequesters.length > 0 && ` · allowlist ${bot.allowedRequesters.length} 人`}
            </div>
            <ToolBadges tools={bot.tools} />
            <div className="break-all text-fg-subtle">
              系统提示词：{bot.systemPrompt.slice(0, 80)}
              {bot.systemPrompt.length > 80 ? '…' : ''}
            </div>
            <div className="text-fg-subtle">
              ID: <code className="text-[10px]">{bot.id}</code>
            </div>
          </div>
          {bot.runtime.errorMessage && (
            <div className="mt-2 rounded bg-danger-soft p-2 text-xs text-danger-fg">⚠️ {bot.runtime.errorMessage}</div>
          )}
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <Button size="sm" leftIcon={<Power className="size-4" />} onClick={onToggleEnabled} disabled={busy}>
            {bot.enabled ? '禁用' : '启用'}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Pencil className="size-4" />}
            onClick={() => setEditing(true)}
            disabled={busy}
          >
            编辑
          </Button>
          <Button size="sm" variant="danger" leftIcon={<Trash2 className="size-4" />} onClick={onDelete} disabled={busy}>
            删除
          </Button>
        </div>
      </div>

      <BotForm
        mode="edit"
        open={editing}
        existing={bot}
        providers={providers}
        onClose={() => setEditing(false)}
        onDone={() => {
          setEditing(false);
          onChange();
        }}
      />
    </Card>
  );
}

type BotFormProps = {
  open: boolean;
  onClose: () => void;
  providers: Provider[];
  onDone: () => void;
} & ({ mode: 'create'; existing?: never } | { mode: 'edit'; existing: BotWithRuntime });

function BotForm(props: BotFormProps) {
  const { open, onClose, providers, onDone } = props;
  const isEdit = props.mode === 'edit';
  const existing = props.mode === 'edit' ? props.existing : undefined;
  const firstProvider = providers[0];

  const [name, setName] = useState('');
  const [providerId, setProviderId] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('你是一个友好、简洁的中文助手。');
  const [temperature, setTemperature] = useState(1.3);
  const [allowedRaw, setAllowedRaw] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [discordToken, setDiscordToken] = useState('');

  // 工具配置
  const [wsDirs, setWsDirs] = useState('');
  const [fsEnabled, setFsEnabled] = useState(false);
  const [bashEnabled, setBashEnabled] = useState(false);
  const [bashDeny, setBashDeny] = useState(DEFAULT_DENY_PATTERNS.join('\n'));
  const [bashTimeout, setBashTimeout] = useState(30000);
  const [memEnabled, setMemEnabled] = useState(false);
  const [webEnabled, setWebEnabled] = useState(false);
  const [claudeEnabled, setClaudeEnabled] = useState(false);
  const [claudeMaxTurns, setClaudeMaxTurns] = useState(30);
  const [claudeTimeoutMin, setClaudeTimeoutMin] = useState(20);
  // 对话记忆（窗口/摘要/检索）。windowTurns=0 表示用全局默认 BOT_HISTORY_TURNS。
  const [convWindow, setConvWindow] = useState(0);
  const [convSummary, setConvSummary] = useState(true);
  const [convRetrieval, setConvRetrieval] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const tabs = useTabs([
    { key: 'basic', label: '基本设置' },
    { key: 'tools', label: '工具配置', icon: Wrench },
    { key: 'advanced', label: '高级 · 委派', icon: Sparkles },
  ]);

  // 打开时（或编辑目标变化）从 existing 重置初值；用可选链兜底旧库数据缺 conversationMemory 段。
  useEffect(() => {
    if (!open) return;
    const t = existing?.tools;
    setName(existing?.name ?? '');
    setProviderId(existing?.providerId ?? firstProvider?.id ?? '');
    setSystemPrompt(existing?.systemPrompt ?? '你是一个友好、简洁的中文助手。');
    setTemperature(existing?.temperature ?? 1.3);
    setAllowedRaw(existing?.allowedRequesters.join('\n') ?? '');
    setEnabled(existing?.enabled ?? true);
    setDiscordToken('');
    setWsDirs(t?.workspaceDirs.join('\n') ?? '');
    setFsEnabled(t?.fs.enabled ?? false);
    setBashEnabled(t?.bash.enabled ?? false);
    setBashDeny((t?.bash.denyPatterns ?? DEFAULT_DENY_PATTERNS).join('\n'));
    setBashTimeout(t?.bash.timeoutMs ?? 30000);
    setMemEnabled(t?.memory.enabled ?? false);
    setWebEnabled(t?.webSearch.enabled ?? false);
    setClaudeEnabled(t?.claudeCode.enabled ?? false);
    setClaudeMaxTurns(t?.claudeCode.maxTurns ?? 30);
    setClaudeTimeoutMin(Math.round((t?.claudeCode.timeoutMs ?? 1_200_000) / 60000));
    setConvWindow(t?.conversationMemory?.windowTurns ?? 0);
    setConvSummary(t?.conversationMemory?.summaryEnabled ?? true);
    setConvRetrieval(t?.conversationMemory?.retrievalEnabled ?? true);
    setErr(null);
    setSubmitting(false);
    tabs.setValue('basic');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing?.id]);

  const selectedProvider = providers.find((p) => p.id === providerId);

  const onSubmit = async () => {
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

      if (isEdit && existing) {
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
        await botsApi.update(existing.id, patch);
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
      onDone();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FormModal
      open={open}
      onClose={onClose}
      title={isEdit && existing ? `编辑「${existing.name}」` : '新建 Bot'}
      size="lg"
      onSubmit={onSubmit}
      submitting={submitting}
      error={err}
      initialFocusRef={nameRef}
    >
      <Tabs {...tabs.tabProps} />
      <div className="mt-4 max-h-[60vh] space-y-3 overflow-y-auto pr-1">
        {/* —— 基本设置 —— */}
        <TabPanel tabKey="basic" activeKey={tabs.value} className="space-y-3">
          <Field label="Bot 名称（日志/列表显示，非 Discord 显示名）">
            <Input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="PM-Alice" required />
          </Field>
          <Field
            label={isEdit ? 'Discord Bot Token（留空 = 保持原值）' : 'Discord Bot Token（存入 Windows Credential Manager）'}
          >
            <Input
              type="password"
              value={discordToken}
              onChange={(e) => setDiscordToken(e.target.value)}
              placeholder={isEdit ? '••••••••（不改就留空）' : ''}
              className="font-mono"
              required={!isEdit}
            />
          </Field>
          <Field
            label="Provider（决定用哪个 API endpoint + 模型）"
            hint={
              selectedProvider ? (
                <>
                  想用别的模型？去{' '}
                  <a href="/providers" className="underline">
                    Providers
                  </a>{' '}
                  多加一个（API key 可以一样，model 不同）
                </>
              ) : undefined
            }
          >
            <Select value={providerId} onChange={(e) => setProviderId(e.target.value)} required>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} → {p.model}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="系统提示词（人格/工种）">
            <Textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={4} />
          </Field>
          <Field
            label={`Temperature: ${temperature.toFixed(1)}（DeepSeek 官方推荐：编程/数学 0.0 · 数据分析 1.0 · 对话/翻译 1.3 · 创作 1.5）`}
          >
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={temperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
              className="w-full accent-primary-strong"
            />
            <div className="mt-1 flex justify-between text-[10px] text-fg-subtle">
              <span>0.0 严谨</span>
              <span>1.0</span>
              <span>1.3 对话</span>
              <span>1.5 创作</span>
              <span>2.0 发散</span>
            </div>
          </Field>
          <Field label="Allowlist Discord User ID（多个用逗号/空格/换行分隔，留空 = 不限制）">
            <Textarea
              value={allowedRaw}
              onChange={(e) => setAllowedRaw(e.target.value)}
              placeholder="1234567890123456789"
              rows={2}
              className="font-mono"
            />
          </Field>
          <label className="flex items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              className="accent-primary-strong"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            启用（连接 Discord）
          </label>
        </TabPanel>

        {/* —— 工具配置 —— */}
        <TabPanel tabKey="tools" activeKey={tabs.value} className="space-y-3">
          {/* 工作目录白名单：fs/bash/claude 共用，只在勾了任一时显示 */}
          {(fsEnabled || bashEnabled || claudeEnabled) && (
            <div className="rounded border border-info/30 bg-info-soft/50 p-3">
              <div className="mb-1 text-[11px] font-medium text-info-fg">
                工作目录白名单（fs / bash / Claude 委派共用：fs 的可访问范围 + bash 与 Claude 子进程的起始
                cwd；每行一个绝对路径，留空 = 全部拒绝）
              </div>
              <Textarea
                value={wsDirs}
                onChange={(e) => setWsDirs(e.target.value)}
                rows={2}
                placeholder={'D:\\workspaces\\bot-a'}
                className="font-mono text-xs"
              />
              <div className="mt-1 text-[10px] text-fg-subtle">
                ⚠️ bash 的命令可用绝对路径越出此范围（cwd 只是起始目录、不是沙箱）；真正的访问控制靠下面的
                allowlist。bash/fs 只给可信 bot。
              </div>
            </div>
          )}

          {/* fs */}
          <ToolCard>
            <ToolHeader
              checked={fsEnabled}
              onChange={setFsEnabled}
              title="文件系统 fs"
              desc="read / write / edit / list / grep（范围 = 工作目录）"
            />
          </ToolCard>

          {/* bash */}
          <ToolCard>
            <ToolHeader
              checked={bashEnabled}
              onChange={setBashEnabled}
              title="命令行 bash"
              desc="run_command（cwd = 工作目录 + 命令黑名单 + 超时）"
            />
            {bashEnabled && (
              <div className="mt-2 space-y-2">
                <Field label="命令黑名单（子串匹配，大小写不敏感，每行一条）">
                  <Textarea
                    value={bashDeny}
                    onChange={(e) => setBashDeny(e.target.value)}
                    rows={3}
                    className="font-mono text-xs"
                  />
                </Field>
                <Field label="单条命令超时（毫秒）" className="w-40">
                  <Input
                    type="number"
                    min={1000}
                    max={600000}
                    step={1000}
                    value={bashTimeout}
                    onChange={(e) => setBashTimeout(Number(e.target.value))}
                  />
                </Field>
              </div>
            )}
          </ToolCard>

          {/* memory */}
          <ToolCard>
            <ToolHeader
              checked={memEnabled}
              onChange={setMemEnabled}
              title="长期记忆 memory"
              desc={
                <>
                  跨会话，存于 bot-memory/&lt;botId&gt;/
                </>
              }
            />
            {memEnabled && (
              <div className="mt-1 text-[11px] text-fg-muted">
                开启后，达一定轮数或会话空闲时会自动把对话要点「整理」固化进上面的长期记忆文件（合并去重、总量封顶）。
              </div>
            )}
          </ToolCard>

          {/* 对话记忆：窗口 / 摘要 / 检索 */}
          <ToolCard>
            <div className="text-sm font-medium text-fg">对话记忆（会话连续性）</div>
            <div className="mt-1 text-[11px] text-fg-subtle">
              决定 bot「还记得多久前的对话」。重启后会从历史自动复原。与上面的长期记忆文件是两套机制。
            </div>
            <div className="mt-2 space-y-2">
              <Field label="近期逐字窗口（轮数，0 = 用全局默认 BOT_HISTORY_TURNS=20）" className="w-32">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={convWindow}
                  onChange={(e) => setConvWindow(Number(e.target.value))}
                />
              </Field>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="accent-primary-strong"
                  checked={convSummary}
                  onChange={(e) => setConvSummary(e.target.checked)}
                />
                <span className="text-xs">滚动摘要（把更早对话压缩成摘要，记住整段会话且省 token）</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="accent-primary-strong"
                  checked={convRetrieval}
                  onChange={(e) => setConvRetrieval(e.target.checked)}
                />
                <span className="text-xs">历史检索（按当前提问从更早消息召回相关片段）</span>
              </label>
            </div>
          </ToolCard>

          {/* web search */}
          <ToolCard>
            <ToolHeader checked={webEnabled} onChange={setWebEnabled} title="联网搜索 web_search" />
            {webEnabled && (
              <div className="mt-1 text-[11px] text-fg-muted">
                开启即用——系统自动按优先级{' '}
                <code className="rounded bg-bg-subtle px-1">SearXNG → Brave → Tavily → DuckDuckGo</code>{' '}
                选「已配置且当天还有余量」的源（在{' '}
                <a href="/providers" className="underline">
                  Providers
                </a>{' '}
                页配 key/URL）。无需勾选或设上限；内置防失控护栏。
              </div>
            )}
          </ToolCard>
        </TabPanel>

        {/* —— 高级 · 委派 —— */}
        <TabPanel tabKey="advanced" activeKey={tabs.value} className="space-y-3">
          <ToolCard>
            <ToolHeader
              checked={claudeEnabled}
              onChange={setClaudeEnabled}
              title="🤖 Claude Code 委派 delegate_to_claude"
              desc="复杂工程任务交给 Claude（走本机订阅）"
            />
            {claudeEnabled && (
              <div className="mt-2 space-y-2">
                <div className="flex gap-3">
                  <Field label="最大轮数（防失控）" className="w-32">
                    <Input
                      type="number"
                      min={1}
                      max={100}
                      value={claudeMaxTurns}
                      onChange={(e) => setClaudeMaxTurns(Number(e.target.value))}
                    />
                  </Field>
                  <Field label="单次超时（分钟）" className="w-32">
                    <Input
                      type="number"
                      min={1}
                      max={60}
                      value={claudeTimeoutMin}
                      onChange={(e) => setClaudeTimeoutMin(Number(e.target.value))}
                    />
                  </Field>
                </div>
                <div className="text-[11px] text-fg-muted">
                  Claude 在「工具配置」段的工作目录内干活。危险操作（删文件 / git push / 联网 / 装包）和澄清问题会
                  <strong>弹 Discord 按钮/菜单</strong>等你批准；只读与普通写自动放行。并发受限（单 bot 1 个 / 全局 5
                  个）。
                </div>
                <div className="text-[10px] text-warning-fg">
                  ⚠️ 计费：6/15 起 Agent SDK 用量走独立的「Agent SDK
                  月度额度」（与交互式 Claude Code 分开），用尽不回落。上线前请去 claude.ai 确认 opt-in 与额度。
                </div>
              </div>
            )}
          </ToolCard>
          {claudeEnabled && !(fsEnabled || bashEnabled) && (
            <div className="text-[11px] text-fg-subtle">
              提示：记得到「工具配置」段填好工作目录白名单，Claude 才有干活的地方。
            </div>
          )}
        </TabPanel>
      </div>
    </FormModal>
  );
}

/** 工具卡外壳：在白底 Modal 内用浅灰底区分各工具模块。 */
function ToolCard({ children }: { children: React.ReactNode }) {
  return <div className="rounded border border-border bg-bg-subtle p-3">{children}</div>;
}

/** 工具开关行：复选框 + 标题 + 说明。 */
function ToolHeader({
  checked,
  onChange,
  title,
  desc,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  desc?: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-2">
      <input
        type="checkbox"
        className="accent-primary-strong"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="text-sm font-medium text-fg">{title}</span>
      {desc && <span className="text-[11px] text-fg-subtle">{desc}</span>}
    </label>
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
  if (active.length === 0) return <div className="text-fg-subtle">工具：无</div>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-fg-subtle">工具：</span>
      {active.map((a) => (
        <Badge key={a} tone="info">
          {a}
        </Badge>
      ))}
    </div>
  );
}
