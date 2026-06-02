'use client';

import { ToastProvider } from '@/components/ui/toast';
import { ConfirmProvider } from '@/components/ui/confirm-dialog';
import { SideNav } from './SideNav';

/** 客户端外壳：挂全局 Toast/Confirm Provider + 侧边栏，保持根 layout 为 RSC。 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <div className="flex min-h-screen">
          <SideNav />
          <main className="min-w-0 flex-1 p-8 md:p-10">{children}</main>
        </div>
      </ConfirmProvider>
    </ToastProvider>
  );
}
