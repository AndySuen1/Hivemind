import Link from 'next/link';

export default function Home() {
  return (
    <div className="max-w-3xl">
      <h2 className="mb-4 text-2xl font-bold">Discord Agent Hub</h2>
      <p className="mb-6 text-zinc-600">
        本地多 bot 平台。先在 <Link href="/providers" className="text-blue-600 underline">Providers</Link> 添加一个模型供应商（如 DeepSeek），再在 <Link href="/bots" className="text-blue-600 underline">Bots</Link> 创建并启用一个 Discord bot。
      </p>
      <div className="rounded border border-zinc-200 bg-white p-6">
        <h3 className="mb-3 font-semibold">三步上线第一个 bot：</h3>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-zinc-700">
          <li>
            <Link href="/providers" className="text-blue-600 underline">Providers</Link> 页 → 新建 → 选 OpenAI 兼容 / Base URL <code className="rounded bg-zinc-100 px-1">https://api.deepseek.com</code>（不带 /v1） + API Key + 模型 <code className="rounded bg-zinc-100 px-1">deepseek-v4-flash</code>
          </li>
          <li>
            <Link href="/bots" className="text-blue-600 underline">Bots</Link> 页 → 新建 → 填 Discord Bot Token + 选刚加的 Provider + allowlist 加自己 Discord user ID + 调 temperature（对话默认 1.3）+ 启用
          </li>
          <li>Discord DM 这个 bot 任意消息 → 收到 DeepSeek 回复</li>
        </ol>
      </div>
      <div className="mt-4 rounded border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
        <strong>DeepSeek 模型选择提示：</strong>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li><code className="rounded bg-white px-1">deepseek-v4-flash</code>：便宜（$0.14/M 输入），1M 上下文，支持 thinking/non-thinking 模式，**推荐起步**</li>
          <li><code className="rounded bg-white px-1">deepseek-v4-pro</code>：贵 ~3 倍，更强推理</li>
          <li><code className="rounded bg-white px-1">deepseek-chat</code> / <code className="rounded bg-white px-1">deepseek-reasoner</code>：**将于 2026/07/24 弃用**，新项目别选</li>
          <li>cache hit 价 $0.0028/M（比 miss 便宜 50 倍），多 bot 共用 system prompt 时收益巨大</li>
        </ul>
      </div>
    </div>
  );
}
