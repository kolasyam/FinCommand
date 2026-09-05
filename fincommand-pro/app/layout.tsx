import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'FinCommand Pro — CFO/CEO Financial Dashboard',
  description: 'IND AS · Schedule III · CFO/CEO Financial Dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
