import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import { AppShell } from '@/components/shell';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'AI Orchestrator', template: '%s · AI Orchestrator' },
  description: 'Dashboard for the autonomous multi-agent AI orchestrator.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

// Applies a stored explicit theme before first paint (no flash). "system" leaves data-theme unset.
const themeScript = `(function(){try{var t=localStorage.getItem('orch-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
