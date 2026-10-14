import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'WorkBuddy 管理后台', description: 'WorkBuddy API 网关管理' };
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
