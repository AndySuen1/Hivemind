import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Hivemind',
  description: 'Multi-bot Discord agent platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-zinc-50 text-zinc-900">
        <div className="flex min-h-screen">
          <aside className="w-56 border-r border-zinc-200 bg-white p-4">
            <h1 className="mb-6 text-lg font-bold">Hivemind</h1>
            <nav className="space-y-1">
              <NavItem href="/">概览</NavItem>
              <NavItem href="/providers">Providers</NavItem>
              <NavItem href="/bots">Bots</NavItem>
              <NavItem href="/observability">可观测</NavItem>
              <NavItem href="/settings">系统设置</NavItem>
            </nav>
            <p className="mt-8 text-xs text-zinc-400">Phase 0&apos;<br/>DeepSeek + Claude</p>
          </aside>
          <main className="flex-1 p-8">{children}</main>
        </div>
      </body>
    </html>
  );
}

function NavItem({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="block rounded px-3 py-2 text-sm hover:bg-zinc-100">
      {children}
    </Link>
  );
}
