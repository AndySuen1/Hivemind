'use client';

import { useEffect, useState } from 'react';
import type { Provider, ProviderCreate, ProviderUpdate } from '@discord-agent-hub/shared';
import { providersApi, webSearchApi } from '@/lib/api';

export default function ProvidersPage() {
  const [list, setList] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

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
    <div className="max-w-4xl">
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-2xl font-bold">Providers</h2>
        <button
          onClick={() => setShowNew((s) => !s)}
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
        >
          {showNew ? '取消' : '+ 新建'}
        </button>
      </div>

      {err && <div className="mb-4 rounded bg-red-50 p-3 text-sm text-red-700">{err}</div>}

      <WebSearchCredential />

      {showNew && (
        <ProviderForm
          mode="create"
          onDone={() => {
            setShowNew(false);
            refresh();
          }}
          onCancel={() => setShowNew(false)}
        />
      )}

      {loading ? (
        <div className="text-zinc-500">加载中…</div>
      ) : list.length === 0 ? (
        <div className="rounded border border-dashed border-zinc-300 bg-white p-8 text-center text-zinc-500">
          还没有 Provider，点右上「+ 新建」加一个 DeepSeek 试试
        </div>
      ) : (
        <div className="space-y-2">
          {list.map((p) => (
            <ProviderRow key={p.id} provider={p} onChange={refresh} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderRow({ provider, onChange }: { provider: Provider; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  if (editing) {
    return (
      <ProviderForm
        mode="edit"
        existing={provider}
        onDone={() => {
          setEditing(false);
          onChange();
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

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
    if (!confirm(`删除 "${provider.name}"？关联的 bot 会无法启动`)) return;
    try {
      await providersApi.delete(provider.id);
      onChange();
    } catch (e) {
      alert((e as Error).message);
    }
  };

  return (
    <div className="rounded border border-zinc-200 bg-white p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="font-semibold">{provider.name}</div>
          <div className="mt-1 space-y-0.5 text-xs text-zinc-500">
            <div>
              类型：<code className="rounded bg-zinc-100 px-1">{provider.kind}</code>
              {' · '}模型：<code className="rounded bg-zinc-100 px-1">{provider.model}</code>
            </div>
            {provider.baseUrl && (
              <div>Base URL：<code className="rounded bg-zinc-100 px-1 break-all">{provider.baseUrl}</code></div>
            )}
            <div className="text-zinc-400">
              ID: <code className="text-[10px]">{provider.id}</code>
            </div>
          </div>
          {testResult && <div className="mt-2 text-xs">{testResult}</div>}
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <button
            onClick={onTest}
            disabled={testing}
            className="rounded border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50"
          >
            {testing ? '测试中…' : '测试'}
          </button>
          <button
            onClick={() => setEditing(true)}
            className="rounded border border-blue-300 px-3 py-1 text-xs text-blue-700 hover:bg-blue-50"
          >
            编辑
          </button>
          <button
            onClick={onDelete}
            className="rounded border border-red-300 px-3 py-1 text-xs text-red-700 hover:bg-red-50"
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

type FormProps =
  | { mode: 'create'; existing?: never; onDone: () => void; onCancel: () => void }
  | { mode: 'edit'; existing: Provider; onDone: () => void; onCancel: () => void };

function ProviderForm(props: FormProps) {
  const isEdit = props.mode === 'edit';
  const [name, setName] = useState(props.existing?.name ?? 'DeepSeek');
  const [kind, setKind] = useState<Provider['kind']>(props.existing?.kind ?? 'openai-compatible');
  const [baseUrl, setBaseUrl] = useState(props.existing?.baseUrl ?? 'https://api.deepseek.com');
  const [model, setModel] = useState(props.existing?.model ?? 'deepseek-v4-flash');
  const [apiKey, setApiKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setErr(null);
    try {
      if (isEdit) {
        const patch: ProviderUpdate = {
          name,
          kind,
          baseUrl: baseUrl || undefined,
          model,
        };
        if (apiKey) patch.apiKey = apiKey;
        await providersApi.update(props.existing.id, patch);
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
        {isEdit ? `编辑「${props.existing.name}」` : '新建 Provider'}
      </div>
      <Field label="名称（显示用）">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
          required
        />
      </Field>
      <Field label="类型">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as Provider['kind'])}
          className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
        >
          <option value="openai-compatible">OpenAI 兼容（DeepSeek / Qwen / GLM / OpenRouter）</option>
          <option value="anthropic-direct">Anthropic 直连（暂未实现）</option>
        </select>
      </Field>
      <Field label="Base URL（OpenAI 兼容必填，DeepSeek 官方建议不带 /v1）">
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.deepseek.com"
          className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
        />
      </Field>
      <Field label="模型（DeepSeek 推荐 deepseek-v4-flash；deepseek-chat 将于 2026/07/24 弃用）">
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="deepseek-v4-flash"
          className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
          required
        />
      </Field>
      <Field label={isEdit ? 'API Key（留空 = 保持原值）' : 'API Key（存入 Windows Credential Manager）'}>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={isEdit ? '••••••••（不改就留空）' : ''}
          className="w-full rounded border border-zinc-300 px-3 py-2 text-sm font-mono"
          required={!isEdit}
        />
      </Field>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-medium text-zinc-700">{label}</div>
      {children}
    </label>
  );
}

// Web Search 全局凭证面板：每个搜索源一行。bot 端只勾用哪些源，凭证在这里统一配一次。
const WEB_PROVIDERS: { id: string; label: string; kind: 'builtin' | 'key' | 'url'; hint: React.ReactNode }[] = [
  { id: 'duckduckgo', label: 'DuckDuckGo', kind: 'builtin', hint: '免费内置，无需配置（国内访问需给 orchestrator 设 WEBSEARCH_PROXY 代理）' },
  {
    id: 'tavily',
    label: 'Tavily',
    kind: 'key',
    hint: <>免费 1000 次/月，去 <a href="https://app.tavily.com" target="_blank" rel="noreferrer" className="underline">app.tavily.com</a> 注册拿 key（tvly-…）</>,
  },
  {
    id: 'brave',
    label: 'Brave',
    kind: 'key',
    hint: <>Claude Code 同款引擎，免费约 2000 次/月，去 <a href="https://brave.com/search/api" target="_blank" rel="noreferrer" className="underline">brave.com/search/api</a> 注册拿 key</>,
  },
  { id: 'searxng', label: 'SearXNG', kind: 'url', hint: '自建开源元搜索，填你的实例 URL（如 https://searx.example.com）' },
];

function WebSearchCredential() {
  return (
    <div className="mb-4 rounded border border-emerald-200 bg-emerald-50/40 p-4">
      <div className="mb-1 text-sm font-semibold">🔍 Web Search 搜索源凭证</div>
      <div className="mb-3 text-[11px] text-zinc-500">
        bot 在「工具」里勾选用哪些源、按序兜底；这里统一配各源的凭证。DuckDuckGo 免费内置、零配置。
      </div>
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
    if (!confirm(`清除 ${provider.label} 配置？`)) return;
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
    <div className="rounded border border-zinc-200 bg-white p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{provider.label}</span>
        {configured === null ? (
          <span className="text-[11px] text-zinc-400">…</span>
        ) : configured ? (
          <span className="rounded bg-green-100 px-2 py-0.5 text-[11px] text-green-800">
            {provider.kind === 'builtin' ? '内置可用' : '已配置'}
            {fromEnv ? '（环境变量）' : ''}
          </span>
        ) : (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-[11px] text-amber-800">未配置</span>
        )}
      </div>
      <div className="mt-1 text-[11px] text-zinc-500">{provider.hint}</div>
      {provider.kind !== 'builtin' && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type={provider.kind === 'key' ? 'password' : 'text'}
            value={val}
            onChange={(e) => setVal(e.target.value)}
            placeholder={provider.kind === 'url' ? 'https://searx.example.com' : configured ? '输入新值可覆盖' : provider.id === 'tavily' ? 'tvly-...' : 'API key'}
            className="min-w-[220px] flex-1 rounded border border-zinc-300 px-3 py-1.5 text-xs font-mono"
          />
          <button onClick={onSave} disabled={busy || !val.trim()} className="rounded bg-emerald-600 px-3 py-1.5 text-xs text-white hover:bg-emerald-700 disabled:opacity-50">
            保存
          </button>
          <button onClick={onTest} disabled={busy || !configured} className="rounded border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50">
            测试
          </button>
          {configured && !fromEnv && (
            <button onClick={onClear} disabled={busy} className="rounded border border-red-300 px-3 py-1.5 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50">
              清除
            </button>
          )}
        </div>
      )}
      {provider.kind === 'builtin' && (
        <div className="mt-2">
          <button onClick={onTest} disabled={busy} className="rounded border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50">
            测试
          </button>
        </div>
      )}
      {msg && <div className="mt-2 text-xs">{msg}</div>}
    </div>
  );
}
