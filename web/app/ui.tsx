export type IconName = 'accounts' | 'key' | 'models' | 'growth' | 'logs' | 'refresh' | 'logout' | 'arrow' | 'copy' | 'plus' | 'shield';
const paths: Record<IconName, string> = {
  accounts: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  key: 'M15 5a6 6 0 1 1-4.5 10L4 22H1v-3l7.5-7A6 6 0 0 1 15 5M17 9h.01',
  models: 'm12 3 9 5-9 5-9-5 9-5M3 12l9 5 9-5M3 16l9 5 9-5',
  growth: 'M3 17l6-6 4 4 8-10M15 5h6v6', logs: 'M8 3H5v18h14V3h-3M8 2h8v4H8V2M8 11h8M8 15h5',
  refresh: 'M20 7v5h-5M4 17v-5h5M5.5 7a7 7 0 0 1 12-2L20 8M4 16l2.5 3a7 7 0 0 0 12-2',
  logout: 'M9 4H4v16h5M13 8l4 4-4 4M8 12h13', arrow: 'M5 12h14M13 6l6 6-6 6',
  copy: 'M9 9h12v12H9V9M15 5V3H3v12h2', plus: 'M12 5v14M5 12h14', shield: 'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3M8 12l3 3 5-6',
};
export function Icon({ name }: { name: IconName }) {
  return <svg aria-hidden="true" className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}
export function Brand() {
  return <span className="brand"><span className="brand-mark"><svg aria-hidden="true" viewBox="0 0 28 28" fill="none"><path d="m5 8 4 12 5-9 5 9 4-12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg></span><span>WorkBuddy<span className="brand-caption">API CONSOLE</span></span></span>;
}
export function EmptyState({ title, children, icon = 'accounts' }: { title: string; children: React.ReactNode; icon?: IconName }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name={icon} /></span><h3>{title}</h3><p>{children}</p></div>;
}
