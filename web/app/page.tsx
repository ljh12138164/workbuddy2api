'use client';
import { useCallback, useEffect, useState } from 'react';
import { rpc, type Data, type Run } from './client';
import { Accounts, Keys, Models, Growth, Logs, SecuritySettings } from './sections';
import { Brand, Icon, type IconName } from './ui';
const tabs = ['账号', 'API Key', '模型与分组', '成长任务', '请求日志', '安全设置'] as const;
const views: Record<(typeof tabs)[number], { title: string; description: string; icon: IconName }> = {
  '账号': { title: '账号管理', description: '管理登录凭证、账号状态与积分，维护你的共享账号池。', icon: 'accounts' },
  'API Key': { title: 'API Key', description: '创建访问密钥，分配账号范围、模型权限和请求配额。', icon: 'key' },
  '模型与分组': { title: '模型与分组', description: '同步可用模型，通过分组控制每个 Key 的调用范围。', icon: 'models' },
  '成长任务': { title: '成长任务', description: '查询任务进度，手动领取任务与已完成的奖励。', icon: 'growth' },
  '请求日志': { title: '请求日志', description: '追踪每次网关调用的状态、Token 用量和响应耗时。', icon: 'logs' },
  '安全设置': { title: '安全设置', description: '更新管理员密码，管理后台访问安全。', icon: 'shield' },
};

export default function Page() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [username, setUsername] = useState('admin'); const [password, setPassword] = useState('');
  const [data, setData] = useState<Data | null>(null);
  const [tab, setTab] = useState<(typeof tabs)[number]>('账号');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const reload = useCallback(async () => {
    const [accounts, keys, models, groups, stats] = await Promise.all([
      rpc.accounts.list.query(), rpc.keys.list.query(), rpc.models.list.query(), rpc.groups.list.query(), rpc.stats.query(),
    ]);
    setData({ accounts, keys, models, groups, stats });
  }, []);
  useEffect(() => { rpc.auth.me.query().then(user => { setUsername(user.username); setAuthenticated(true); }).catch(() => setAuthenticated(false)); }, []);
  useEffect(() => { if (authenticated) reload().catch(err => setError(err.message)); }, [authenticated, reload]);
  const run: Run = async (operation, message) => {
    setBusy(true); setError(''); setNotice('');
    try { const result = await operation(); await reload(); if (message) setNotice(message); return result; }
    catch (err) { setError(err instanceof Error ? err.message : '操作失败'); }
    finally { setBusy(false); }
  };
  if (authenticated === null) return <main className="initial-loading" aria-live="polite"><Brand /><div className="loading-line" /><p>正在加载管理后台…</p></main>;
  if (!authenticated) return <main className="login-layout">
    <section className="login-aside"><Brand /><div><h2>你的账号。<br />你的 API 工作台。</h2><p>在一个地方管理账号、模型和访问权限。</p><div className="login-protocols"><span>OpenAI</span><span>Responses</span><span>Anthropic</span></div></div><p className="login-aside-footer"><Icon name="shield" />凭证加密存储 · 管理员专属访问</p></section>
    <section className="login-main"><div className="login-form-wrap"><h1>登录管理后台</h1><p className="login-description">使用管理员账号继续，首次登录后可在安全设置中修改密码。</p>
    {notice && <p role="status" className="feedback feedback-success">{notice}</p>}
    <form className="login-form space-y-5" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      try { await rpc.auth.login.mutate({ username, password }); setPassword(''); setNotice(''); setAuthenticated(true); }
      catch (err) { setError(err instanceof Error ? err.message : '登录失败'); }
      finally { setBusy(false); }
    }}>
      <label>用户名<input required autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} /></label>
      <label>密码<input required type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <button disabled={busy} className="button-primary w-full">{busy ? '正在登录…' : '登录'}<Icon name="arrow" /></button>
    </form><p className="login-footnote">会话将在 12 小时后过期。</p></div></section></main>;
  return <div className="console-shell">
    <aside className="sidebar"><Brand /><nav aria-label="管理功能">{tabs.map(value => <button key={value} aria-current={tab === value ? 'page' : undefined} onClick={() => { setTab(value); setError(''); setNotice(''); }}><Icon name={views[value].icon} /><span>{value}</span>{value === '账号' && data && <span className="nav-count">{data.accounts.length}</span>}</button>)}</nav>
      <div className="sidebar-footer"><div className="session-user"><span className="user-avatar">{username.slice(0, 1).toUpperCase()}</span><div><strong>{username}</strong><span>管理员</span></div></div><button disabled={busy} onClick={async () => {
        setBusy(true); setError(''); try { await rpc.auth.logout.mutate(); setAuthenticated(false); setData(null); }
        catch (err) { setError(err instanceof Error ? err.message : '退出失败'); } finally { setBusy(false); }
      }}><Icon name="logout" />退出登录</button></div>
    </aside>
    <div className="workspace"><header className="topbar"><span className="breadcrumb">管理后台<span>/</span><strong>{views[tab].title}</strong></span><span className="session-badge"><span />管理员会话</span></header>
    <main className="workspace-main"><div className="page-heading"><div><h1>{views[tab].title}</h1><p>{views[tab].description}</p></div><button disabled={busy} onClick={() => run(reload, '已刷新')}><Icon name="refresh" />刷新数据</button></div>
    {data && <dl className="metrics-strip">{[['账号', data.accounts.length, `${data.accounts.filter(a => a.enabled).length} 个启用`], ['请求', data.stats.requests, '累计受理'], ['Token', data.stats.tokens, '累计用量'], ['失败', data.stats.failed, '累计失败']].map(([label, value, description]) => <div key={label}><dt>{label}</dt><dd>{Number(value).toLocaleString()}<span>{description}</span></dd></div>)}</dl>}
    <div className="endpoint-bar"><span><Icon name="models" />API 地址</span><code>{typeof window !== 'undefined' ? window.location.origin : ''}/v1</code><button className="button-quiet" aria-label="复制 API 地址" onClick={() => run(() => navigator.clipboard.writeText(window.location.origin + '/v1'), 'API 地址已复制')}><Icon name="copy" /><span>复制</span></button></div>
    {error && <p role="alert" className="feedback feedback-error">{error}</p>}
    {notice && <p role="status" className="feedback feedback-success">{notice}</p>}
    {!data ? <div className="content-skeleton" role="status" aria-label="正在加载数据"><div /><div /><div /></div> : <fieldset disabled={busy} className={`section-layout ${tab === '账号' ? 'account-layout' : ''}`} aria-busy={busy}>
      {tab === '账号' && <Accounts data={data} run={run} />}{tab === 'API Key' && <Keys data={data} run={run} />}
      {tab === '模型与分组' && <Models data={data} run={run} />}{tab === '成长任务' && <Growth data={data} run={run} />}
      {tab === '请求日志' && <Logs data={data} run={run} />}
      {tab === '安全设置' && <SecuritySettings onChanged={() => { setAuthenticated(false); setData(null); setPassword(''); setTab('账号'); setError(''); setNotice('密码已修改，请使用新密码重新登录。'); }} />}
    </fieldset>}{busy && <p role="status" className="operation-status"><span className="loading-dot" />正在处理…</p>}
    <footer className="workspace-footer"><span>WorkBuddy API Console</span><span>账号与网关管理</span></footer>
  </main></div></div>;
}
