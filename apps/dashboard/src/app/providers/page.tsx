'use client';

import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import type { Provider, ProviderCreate, ProviderUpdate } from '@hivemind/shared';
import { providersApi, webSearchApi } from '@/lib/api';
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
  SectionTitle,
  Select,
  Skeleton,
  TabPanel,
  Tabs,
  useConfirm,
  useTabs,
  useToast,
} from '@/components/ui';

export default function ProvidersPage() {
  const [list, setList] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // null = 关闭，'new' = 新建，Provider = 编辑该项（共用一个顶层 Modal）
  const [editing, setEditing] = useState<Provider | 'new' | null>(null);

  const { value: tab, tabProps } = useTabs(
    [
      { key: 'models', label: '模型供应商' },
      { key: 'search', label: 'Web 搜索源' },
    ],
    { defaultKey: 'models', queryKey: 'tab' },
  );

  const refresh = async () => {
    try {
      setList(await providersApi.list());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  return (
    <PageContainer size="default">
      <PageHeader
        title="Providers"
        subtitle="管理 LLM 模型供应商与 Web 搜索源凭证"
        actions={
          tab === 'models' ? (
            <Button variant="primary" size="lg" leftIcon={<Plus className="size-[18px]" />} onClick={() => setEditing('new')}>
              新建
            </Button>
          ) : undefined
        }
      />

      {err && <div className="mb-4 rounded bg-danger-soft p-3 text-sm text-danger-fg">{err}</div>}

      <Tabs {...tabProps} className="mb-4" />

      <TabPanel tabKey="models" activeKey={tab}>
        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-[88px] rounded-lg" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <EmptyState
            title="还没有 Provider"
            description="点右上「新建」加一个 DeepSeek 试试。模型由 Provider 决定，想换模型就新建一个。"
            action={
              <Button variant="primary" leftIcon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
                新建 Provider
              </Button>
            }
          />
        ) : (
          <div className="space-y-2">
            {list.map((p) => (
              <ProviderRow key={p.id} provider={p} onEdit={() => setEditing(p)} onChange={refresh} />
            ))}
          </div>
        )}
      </TabPanel>

      <TabPanel tabKey="search" activeKey={tab}>
        <WebSearchTab />
      </TabPanel>

      <ProviderFormModal
        open={editing !== null}
        mode={editing === 'new' ? 'create' : 'edit'}
        existing={editing !== 'new' && editing !== null ? editing : undefined}
        onClose={() => setEditing(null)}
        onDone={() => {
          setEditing(null);
          refresh();
        }}
      />
    </PageContainer>
  );
}

function ProviderRow({
  provider,
  onEdit,
  onChange,
}: {
  provider: Provider;
  onEdit: () => void;
  onChange: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const confirm = useConfirm();
  const { toast } = useToast();

  const onTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await providersApi.test(provider.id);
      setTestResult(`✅ ${r.reply.slice(0, 80)}`);
    } catch (e) {
      setTestResult(`❌ ${(e as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  const onDelete = async () => {
    const ok = await confirm({
      title: `删除 "${provider.name}"？`,
      description: '关联的 bot 会无法启动。此操作不可撤销。',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await providersApi.delete(provider.id);
      onChange();
    } catch (e) {
      toast((e as Error).message, { tone: 'danger' });
    }
  };

  return (
    <Card padding="md">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-fg">{provider.name}</div>
          <div className="mt-1 space-y-0.5 text-xs text-fg-muted">
            <div>
              类型：<code className="rounded bg-bg-subtle px-1">{provider.kind}</code>
              {' · '}模型：<code className="rounded bg-bg-subtle px-1">{provider.model}</code>
            </div>
            {provider.baseUrl && (
              <div>
                Base URL：<code className="break-all rounded bg-bg-subtle px-1">{provider.baseUrl}</code>
              </div>
            )}
            <div className="text-fg-subtle">
              ID: <code className="text-[10px]">{provider.id}</code>
            </div>
          </div>
          {testResult && <div className="mt-2 text-xs text-fg">{testResult}</div>}
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <Button size="sm" onClick={onTest} loading={testing}>
            {testing ? '测试中…' : '测试'}
          </Button>
          <Button size="sm" variant="secondary" onClick={onEdit}>
            编辑
          </Button>
          <Button size="sm" variant="danger" onClick={onDelete}>
            删除
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ProviderFormModal({
  open,
  mode,
  existing,
  onClose,
  onDone,
}: {
  open: boolean;
  mode: 'create' | 'edit';
  existing?: Provider;
  onClose: () => void;
  onDone: () => void;
}) {
  const isEdit = mode === 'edit';
  const [name, setName] = useState('DeepSeek');
  const [kind, setKind] = useState<Provider['kind']>('openai-compatible');
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com');
  const [model, setModel] = useState('deepseek-v4-flash');
  const [apiKey, setApiKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // 每次打开（或编辑目标变化）重置初值，避免上次残留 / apiKey 不清空误判
  useEffect(() => {
    if (!open) return;
    setName(existing?.name ?? 'DeepSeek');
    setKind(existing?.kind ?? 'openai-compatible');
    setBaseUrl(existing?.baseUrl ?? 'https://api.deepseek.com');
    setModel(existing?.model ?? 'deepseek-v4-flash');
    setApiKey('');
    setErr(null);
    setSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing?.id]);

  const onSubmit = async () => {
    setSubmitting(true);
    setErr(null);
    try {
      if (isEdit && existing) {
        const patch: ProviderUpdate = {
          name,
          kind,
          baseUrl: baseUrl || undefined,
          model,
        };
        if (apiKey) patch.apiKey = apiKey;
        await providersApi.update(existing.id, patch);
      } else {
        if (!apiKey) throw new Error('新建时 API Key 必填');
        const input: ProviderCreate = {
          name,
          kind,
          baseUrl: baseUrl || undefined,
          model,
          apiKey,
        };
        await providersApi.create(input);
      }
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FormModal
      open={open}
      onClose={onClose}
      title={isEdit && existing ? `编辑「${existing.name}」` : '新建 Provider'}
      size="md"
      onSubmit={onSubmit}
      submitting={submitting}
      error={err}
      initialFocusRef={nameRef}
    >
      <Field label="名称（显示用）">
        <Input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} required />
      </Field>
      <Field label="类型">
        <Select value={kind} onChange={(e) => setKind(e.target.value as Provider['kind'])}>
          <option value="openai-compatible">OpenAI 兼容（DeepSeek / Qwen / GLM / OpenRouter）</option>
          <option value="anthropic-direct">Anthropic 直连（暂未实现）</option>
        </Select>
      </Field>
      <Field label="Base URL（OpenAI 兼容必填，DeepSeek 官方建议不带 /v1）">
        <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com" />
      </Field>
      <Field label="模型（DeepSeek 推荐 deepseek-v4-flash；deepseek-chat 将于 2026/07/24 弃用）">
        <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-v4-flash" required />
      </Field>
      <Field label={isEdit ? 'API Key（留空 = 保持原值）' : 'API Key（存入 Windows Credential Manager）'}>
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={isEdit ? '••••••••（不改就留空）' : ''}
          className="font-mono"
          required={!isEdit}
        />
      </Field>
    </FormModal>
  );
}

// Web Search 全局凭证面板：每个搜索源一行。bot 端只勾用哪些源，凭证在这里统一配一次。
const WEB_PROVIDERS: { id: string; label: string; kind: 'builtin' | 'key' | 'url'; hint: React.ReactNode }[] = [
  { id: 'duckduckgo', label: 'DuckDuckGo', kind: 'builtin', hint: '免费内置，无需配置（国内访问需给 orchestrator 设 WEBSEARCH_PROXY 代理）' },
  {
    id: 'tavily',
    label: 'Tavily',
    kind: 'key',
    hint: (
      <>
        免费 1000 次/月，去{' '}
        <a href="https://app.tavily.com" target="_blank" rel="noreferrer" className="text-primary-strong underline">
          app.tavily.com
        </a>{' '}
        注册拿 key（tvly-…）
      </>
    ),
  },
  {
    id: 'brave',
    label: 'Brave',
    kind: 'key',
    hint: (
      <>
        Claude Code 同款引擎，免费约 2000 次/月，去{' '}
        <a href="https://brave.com/search/api" target="_blank" rel="noreferrer" className="text-primary-strong underline">
          brave.com/search/api
        </a>{' '}
        注册拿 key
      </>
    ),
  },
  { id: 'searxng', label: 'SearXNG', kind: 'url', hint: '自建开源元搜索，填你的实例 URL（如 https://searx.example.com）' },
];

function WebSearchTab() {
  return (
    <div>
      <SectionTitle
        as="h3"
        title="Web 搜索源凭证"
        description="bot 在「工具」里勾选用哪些源、按序兜底；这里统一配各源的凭证。DuckDuckGo 免费内置、零配置。"
      />
      <div className="space-y-2">
        {WEB_PROVIDERS.map((p) => (
          <WebProviderRow key={p.id} provider={p} />
        ))}
      </div>
    </div>
  );
}

function WebProviderRow({ provider }: { provider: (typeof WEB_PROVIDERS)[number] }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [fromEnv, setFromEnv] = useState(false);
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const confirm = useConfirm();

  const refresh = async () => {
    try {
      const s = await webSearchApi.status(provider.id);
      setConfigured(s.configured);
      setFromEnv(s.fromEnv);
    } catch (e) {
      setMsg(`❌ ${(e as Error).message}`);
    }
  };
  useEffect(() => {
    refresh();
  }, []);

  const onSave = async () => {
    if (!val.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      await webSearchApi.save(provider.id, provider.kind === 'url' ? { url: val.trim() } : { apiKey: val.trim() });
      setVal('');
      setMsg('✅ 已保存');
      refresh();
    } catch (e) {
      setMsg(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const onTest = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await webSearchApi.test(provider.id);
      setMsg(`✅ 连通：${r.sample.slice(0, 60)}`);
    } catch (e) {
      setMsg(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const onClear = async () => {
    const ok = await confirm({
      title: `清除 ${provider.label} 配置？`,
      confirmText: '清除',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    try {
      await webSearchApi.remove(provider.id);
      setMsg('已清除');
      refresh();
    } catch (e) {
      setMsg(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="sm">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-fg">{provider.label}</span>
        {configured === null ? (
          <Skeleton className="h-5 w-16 rounded-full" />
        ) : configured ? (
          <Badge tone="success">
            {provider.kind === 'builtin' ? '内置可用' : '已配置'}
            {fromEnv ? '（环境变量）' : ''}
          </Badge>
        ) : (
          <Badge tone="warning">未配置</Badge>
        )}
      </div>
      <div className="mt-1 text-[11px] text-fg-muted">{provider.hint}</div>
      {provider.kind !== 'builtin' && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input
            type={provider.kind === 'key' ? 'password' : 'text'}
            value={val}
            onChange={(e) => setVal(e.target.value)}
            placeholder={
              provider.kind === 'url'
                ? 'https://searx.example.com'
                : configured
                  ? '输入新值可覆盖'
                  : provider.id === 'tavily'
                    ? 'tvly-...'
                    : 'API key'
            }
            className="min-w-[220px] flex-1 py-1.5 font-mono text-xs"
          />
          <Button size="sm" variant="primary" onClick={onSave} disabled={busy || !val.trim()}>
            保存
          </Button>
          <Button size="sm" onClick={onTest} disabled={busy || !configured}>
            测试
          </Button>
          {configured && !fromEnv && (
            <Button size="sm" variant="danger" onClick={onClear} disabled={busy}>
              清除
            </Button>
          )}
        </div>
      )}
      {provider.kind === 'builtin' && (
        <div className="mt-2">
          <Button size="sm" onClick={onTest} disabled={busy}>
            测试
          </Button>
        </div>
      )}
      {msg && <div className="mt-2 text-xs text-fg">{msg}</div>}
    </Card>
  );
}
