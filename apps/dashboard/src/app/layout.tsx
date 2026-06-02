import type { Metadata } from 'next';
import './globals.css';
import { AppShell } from '@/components/layout/AppShell';

export const metadata: Metadata = {
  title: 'Hivemind',
  description: 'Multi-bot Discord agent platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-bg text-fg">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
