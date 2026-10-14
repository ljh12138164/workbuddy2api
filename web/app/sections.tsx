'use client';
import { useEffect, useState } from 'react';
import { rpc, type Data, type Outputs, type Run } from './client';
import { EmptyState, Icon } from './ui';
type Props = { data: Data; run: Run };
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  const expandable = title === '导入账号' || title === '手机号登录';
  if (expandable) return <details className="panel intake-panel" data-panel={title}><summary><span><Icon name={title === '导入账号' ? 'plus' : 'shield'} /><strong>{title}</strong></span><span className="expand-label">展开<Icon name="arrow" /></span></summary><div className="panel-body space-y-4">{children}</div></details>;
  return <section className="panel" data-panel={title}><div className="panel-heading"><h2>{title}</h2></div><div className="panel-body space-y-4">{children}</div></section>;
}
function AccountSelect({ data, value, onChange, optional = false }: { data: Data; value: string; onChange: (value: string) => void; optional?: boolean }) {
  return <select required={!optional} value={value} onChange={e => onChange(e.target.value)}><option value="">{optional ? '共享账号池' : '选择账号'}</option>{data.accounts.map(account => <option key={account.id} value={account.id}>{account.name} {account.enabled ? '' : '（停用）'}</option>)}</select>;
}
function download(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Accounts({ data, run }: Props) {
  const [credential, setCredential] = useState(''); const [name, setName] = useState(''); const [importResult, setImportResult] = useState('');
  const [phone, setPhone] = useState(''); const [code, setCode] = useState(''); const [session, setSession] = useState('');
  return <>
  <Panel title="账号列表"><div className="flex flex-wrap gap-2"><button onClick={async () => { const result = await run(() => rpc.accounts.export.mutate({ ids: [] })); if (result) download('workbuddy-accounts.json', result); }}>导出全部凭证</button><p className="self-center text-sm text-slate-600">导出文件含登录凭证，请妥善保存。</p></div>
    {!data.accounts.length ? <EmptyState title="添加你的第一个账号">在下方展开“导入账号”或“手机号登录”，连接账号后即可同步模型并创建 API Key。</EmptyState> : <div className="table-scroll overflow-x-auto"><table className="w-full"><thead><tr><th>账号</th><th>积分（缓存）</th><th>状态</th><th>操作</th></tr></thead><tbody>{data.accounts.map(account => <tr key={account.id}>
      <td><p>{account.name}</p><p className="text-xs text-slate-500">{account.uid}</p><details className="mt-2"><summary className="cursor-pointer">积分明细</summary><pre className="max-h-48 max-w-xs overflow-auto text-xs">{JSON.stringify(JSON.parse(account.credits), null, 2)}</pre></details></td>
      <td className="numeric">{account.balance.toLocaleString()} <span className="muted">/ {account.balance_total.toLocaleString()}</span></td><td><span className={`status-tag ${account.enabled ? 'status-enabled' : 'status-disabled'}`}>{account.enabled ? '启用' : '停用'}</span></td><td><div className="row-actions flex min-w-72 flex-wrap gap-2">
        <button onClick={() => run(() => rpc.accounts.sync.mutate({ id: account.id }), '积分已同步')}>同步积分</button><button onClick={() => run(() => rpc.accounts.refresh.mutate({ id: account.id }), '凭证已刷新')}>刷新凭证</button>
        <button onClick={() => run(() => rpc.accounts.update.mutate({ id: account.id, name: account.name, enabled: !account.enabled }))}>{account.enabled ? '停用' : '启用'}</button>
        <button onClick={() => { const value = window.prompt('账号名称', account.name); if (value !== null) run(() => rpc.accounts.update.mutate({ id: account.id, name: value, enabled: Boolean(account.enabled) })); }}>改名</button>
        <button onClick={() => { if (window.confirm(`删除账号 ${account.name}？绑定此账号的 Key 将无法继续调用。`)) run(() => rpc.accounts.remove.mutate({ id: account.id })); }}>删除</button>
      </div></td></tr>)}</tbody></table></div>}
  </Panel>
  <Panel title="导入账号"><form className="space-y-3" onSubmit={async e => {
    e.preventDefault(); const result = await run(() => rpc.accounts.import.mutate({ name, credential }));
    if (result) { setImportResult(result.results.map(item => item.error || `已导入 ${item.uid}`).join('\n')); if (result.results.every(item => !item.error)) setCredential(''); }
  }}>
    <p className="text-sm text-slate-600">可粘贴完整凭证，或选择 .info / JSON 文件。新版加密凭证需先在桌面版导入后导出。</p>
    <div className="grid gap-3 sm:grid-cols-2"><label>名称（可选）<input maxLength={120} value={name} onChange={e => setName(e.target.value)} /></label><label>凭证文件<input type="file" accept=".info,.json" onChange={e => {
      const file = e.target.files?.[0]; if (file) run(async () => { if (file.size > 1000000) throw new Error('文件不能超过 1 MB'); setCredential(await file.text()); });
    }} /></label></div>
    <label>凭证 JSON<textarea required rows={4} spellCheck={false} autoComplete="off" value={credential} onChange={e => setCredential(e.target.value)} /></label><button type="submit">导入并验证账号</button>
    {importResult && <p role="status" className="whitespace-pre-wrap text-sm">{importResult}</p>}
  </form></Panel>
  <Panel title="手机号登录"><form className="grid items-end gap-3 sm:grid-cols-3" onSubmit={async e => {
    e.preventDefault(); const result = await run(() => rpc.phone.verify.mutate({ id: session, code }), '账号已导入'); if (result) { setSession(''); setCode(''); }
  }}>
    <label>手机号<input inputMode="tel" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} /></label>
    <button type="button" onClick={async () => {
      const result = await run(async () => { const started = await rpc.phone.start.mutate(); setSession(started.id); await rpc.phone.send.mutate({ id: started.id, mobile: phone }); return started; }, '验证码已发送'); if (!result) setSession('');
    }}>发送验证码</button>
    <label>验证码<input pattern="[0-9]{4,8}" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} /></label><button type="submit" disabled={!session || !code}>验证并添加账号</button>
  </form><p className="text-sm text-slate-600">需要人机验证时，请在官方客户端登录后导入凭证。</p></Panel>
</>;
}

export function Keys({ data, run }: Props) {
  const [name, setName] = useState(''); const [limit, setLimit] = useState(0); const [account, setAccount] = useState(''); const [group, setGroup] = useState(''); const [created, setCreated] = useState('');
  return <><Panel title="创建 API Key"><form className="grid gap-3 sm:grid-cols-2" onSubmit={async e => {
    e.preventDefault(); const result = await run(() => rpc.keys.create.mutate({ name, requestLimit: limit, accountId: account || null, groupId: group || null })); if (result) { setCreated(result.key); setName(''); }
  }}>
    <label>名称<input required maxLength={120} value={name} onChange={e => setName(e.target.value)} /></label><label>请求次数配额（0 为不限）<input required type="number" min={0} max={100000000} value={limit} onChange={e => setLimit(Number(e.target.value))} /></label>
    <label>账号范围<AccountSelect data={data} value={account} onChange={setAccount} optional /></label><label>模型分组<select value={group} onChange={e => setGroup(e.target.value)}><option value="">全部启用模型</option>{data.groups.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label><button type="submit">创建</button>
  </form>{created && <div className="space-y-2"><label>完整 Key（只显示这一次）<input readOnly value={created} onFocus={e => e.target.select()} /></label><div className="flex gap-2"><button onClick={() => run(() => navigator.clipboard.writeText(created), '已复制')}>复制</button><button onClick={() => setCreated('')}>收起</button></div></div>}</Panel>
  <Panel title="API Key 列表"><p className="text-sm text-slate-600">网关受理并分配到账号的请求占用配额，失败也计数。每个 Key 每分钟最多 60 次、并发最多 4 个。</p>
    {!data.keys.length ? <EmptyState title="还没有访问密钥" icon="key">使用上方表单创建 API Key，再将它填写到你的 AI 客户端中。</EmptyState> : <div className="table-scroll overflow-x-auto"><table className="w-full"><thead><tr><th>名称 / 前缀</th><th>范围</th><th>已用 / 配额</th><th>Token</th><th>操作</th></tr></thead><tbody>{data.keys.map(key => <tr key={key.id}>
      <td>{key.name}<p className="font-mono text-xs text-slate-500">{key.prefix}…</p></td><td>{key.account_id ? data.accounts.find(a => a.id === key.account_id)?.name || '账号已删除' : '共享账号池'}<p className="text-xs text-slate-500">{key.group_id ? data.groups.find(g => g.id === key.group_id)?.name || '分组已删除' : '全部启用模型'}</p></td><td>{key.requests} / {key.request_limit || '不限'}</td><td>{key.tokens.toLocaleString()}</td><td><div className="flex gap-2">
        <button onClick={() => run(() => rpc.keys.update.mutate({ id: key.id, enabled: !key.enabled, requestLimit: key.request_limit }))}>{key.enabled ? '停用' : '启用'}</button><button onClick={() => { const value = window.prompt('请求次数配额，0 为不限', String(key.request_limit)); if (value !== null && /^\d+$/.test(value)) run(() => rpc.keys.update.mutate({ id: key.id, enabled: Boolean(key.enabled), requestLimit: Number(value) })); }}>改配额</button><button onClick={() => { if (window.confirm(`删除 Key ${key.name}？`)) run(() => rpc.keys.remove.mutate({ id: key.id })); }}>删除</button>
      </div></td></tr>)}</tbody></table></div>}
  </Panel></>;
}

export function Models({ data, run }: Props) {
  const [account, setAccount] = useState(''); const [name, setName] = useState(''); const [selected, setSelected] = useState<string[]>([]); const [editing, setEditing] = useState<string>();
  return <><Panel title="模型目录"><form className="flex flex-wrap items-end gap-3" onSubmit={e => { e.preventDefault(); run(() => rpc.models.sync.mutate({ id: account }), '模型目录已同步'); }}><label className="min-w-48">同步来源<AccountSelect data={data} value={account} onChange={setAccount} /></label><button>同步模型</button></form>
    {!data.models.length ? <EmptyState title="同步你的模型目录" icon="models">选择一个已添加的账号并同步模型。勾选启用的模型后，客户端即可使用对应的模型 ID。</EmptyState> : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{data.models.map(model => <label className="model-option" key={model.id}><input type="checkbox" checked={Boolean(model.enabled)} onChange={e => run(() => rpc.models.toggle.mutate({ id: model.id, enabled: e.target.checked }))} /><code className="break-all">{model.id}</code></label>)}</div>}
  </Panel><Panel title="模型分组"><form className="space-y-3" onSubmit={async e => { e.preventDefault(); const result = await run(() => rpc.groups.save.mutate({ id: editing, name, models: selected })); if (result) { setName(''); setSelected([]); setEditing(undefined); } }}>
    <label>分组名称<input required maxLength={120} value={name} onChange={e => setName(e.target.value)} /></label><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{data.models.map(model => <label key={model.id} className="model-option"><input type="checkbox" checked={selected.includes(model.id)} onChange={e => setSelected(e.target.checked ? [...selected, model.id] : selected.filter(id => id !== model.id))} /><span className="break-all">{model.id}</span></label>)}</div><div className="flex gap-2"><button>{editing ? '保存分组' : '创建分组'}</button>{editing && <button type="button" onClick={() => { setEditing(undefined); setName(''); setSelected([]); }}>取消编辑</button>}</div>
  </form><ul className="space-y-3">{data.groups.map(group => <li key={group.id} className="border-t border-slate-200 pt-3"><p>{group.name}</p><p className="my-2 break-all text-sm text-slate-600">{JSON.parse(group.models).join(', ') || '未允许任何模型'}</p><div className="flex gap-2"><button onClick={() => { setEditing(group.id); setName(group.name); setSelected(JSON.parse(group.models)); }}>编辑</button><button onClick={() => { if (window.confirm('删除分组后，绑定的 Key 将不能使用任何模型。继续？')) run(() => rpc.groups.remove.mutate({ id: group.id })); }}>删除</button></div></li>)}</ul></Panel></>;
}

export function SecuritySettings({ onChanged }: { onChanged: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <Panel title="修改管理员密码"><p>修改后所有设备的旧登录会话将失效，请使用新密码重新登录。</p>
    <form className="max-w-md space-y-4" onSubmit={async event => {
      event.preventDefault(); setError('');
      if (newPassword !== confirmation) { setError('两次输入的新密码不一致'); return; }
      setBusy(true);
      try { await rpc.auth.changePassword.mutate({ currentPassword, newPassword }); setCurrentPassword(''); setNewPassword(''); setConfirmation(''); onChanged(); }
      catch (err) { setError(err instanceof Error ? err.message : '修改密码失败'); }
      finally { setBusy(false); }
    }}><fieldset disabled={busy} className="space-y-4">
      <label>当前密码<input required type="password" autoComplete="current-password" maxLength={256} value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} /></label>
      <label>新密码<input required type="password" autoComplete="new-password" minLength={8} maxLength={256} placeholder="至少 8 个字符" value={newPassword} onChange={event => setNewPassword(event.target.value)} /></label>
      <label>确认新密码<input required type="password" autoComplete="new-password" minLength={8} maxLength={256} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
      {error && <p role="alert" className="feedback feedback-error">{error}</p>}
      <button type="submit" className="button-primary">{busy ? '正在保存…' : '保存新密码'}</button>
    </fieldset></form>
  </Panel>;
}

export function Growth({ data, run }: Props) {
  const [account, setAccount] = useState(''); const [code, setCode] = useState(''); const [tasks, setTasks] = useState<Outputs['growth']['list'] | null>(null);
  const taskRows = Array.isArray(tasks?.tasks) ? tasks.tasks.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null) : [];
  const statusNames: Record<string, string> = { not_accepted: '未领取', accepted: '进行中', completed: '待领奖', claimed: '已领取' };
  const load = async () => { const result = await run(() => rpc.growth.list.query({ id: account })); if (result) setTasks(result); };
  return <Panel title="手动成长任务"><p className="text-sm text-slate-600">查询任务后可按任务码手动领取任务和奖励；完成条件须在官方客户端满足。当前没有定时任务或自动签到。</p>
    <form className="flex flex-wrap items-end gap-3" onSubmit={e => { e.preventDefault(); load(); }}><label className="min-w-48">账号<AccountSelect data={data} value={account} onChange={value => { setAccount(value); setTasks(null); }} /></label><button>查询任务</button></form>
    {!tasks ? <EmptyState title="查询账号的成长任务" icon="growth">选择账号，查看可领取的任务与奖励。任务操作由你手动执行。</EmptyState> : <>
      {taskRows.length ? <div className="table-scroll overflow-x-auto"><table className="w-full"><thead><tr><th>任务 / 任务码</th><th>奖励积分</th><th>状态</th><th>操作</th></tr></thead><tbody>{taskRows.map((task, index) => <tr key={String(task.task_code ?? index)}><td>{String(task.title ?? task.task_code ?? '未命名任务')}<p className="font-mono text-xs text-slate-500">{String(task.task_code ?? '—')}</p></td><td className="numeric">{String(task.reward_credit ?? '—')}</td><td><span className="status-tag status-disabled">{statusNames[String(task.accept_status)] ?? String(task.accept_status ?? '未知')}</span></td><td><button disabled={typeof task.task_code !== 'string'} onClick={() => setCode(String(task.task_code))}>选择任务</button></td></tr>)}</tbody></table></div> : <EmptyState title="没有可展示的任务" icon="growth">可展开原始结果查看接口返回的完整信息。</EmptyState>}
      <details><summary className="text-xs text-slate-600">查看原始结果</summary><pre className="mt-3 max-h-96 overflow-auto p-3 text-xs">{JSON.stringify(tasks, null, 2)}</pre></details>
    </>}
    <label>任务码<input value={code} pattern="[\w-]+" onChange={e => setCode(e.target.value)} placeholder="从查询结果中复制 task_code" /></label><div className="flex flex-wrap gap-2"><button disabled={!account || !/^[\w-]+$/.test(code)} onClick={async () => { if (await run(() => rpc.growth.accept.mutate({ id: account, codes: [code] }), '任务已领取')) await load(); }}>领取任务</button><button disabled={!account || !/^[\w-]+$/.test(code)} onClick={async () => { if (await run(() => rpc.growth.claim.mutate({ id: account, code }), '奖励请求已提交')) await load(); }}>领取奖励</button></div>
  </Panel>;
}

export function Logs({ data }: Props) {
  const [logs, setLogs] = useState<Outputs['logs']['list']>([]); const [key, setKey] = useState(''); const [before, setBefore] = useState<{ at: number; id: string }>(); const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  useEffect(() => {
    let active = true; setLoading(true); setError(''); rpc.logs.list.query({ keyId: key || undefined, before: before?.at, beforeId: before?.id }).then(result => { if (active) setLogs(result); }).catch(err => { if (active) setError(err.message); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; };
  }, [key, before, data.stats.requests]);
  return <Panel title="请求日志"><label className="max-w-sm">API Key<select value={key} onChange={e => { setKey(e.target.value); setBefore(undefined); }}><option value="">全部</option>{data.keys.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    {error && <p role="alert" className="text-red-700">{error}</p>}{loading ? <p role="status" className="muted">正在加载请求记录…</p> : !logs.length ? <EmptyState title={before ? '没有更早的记录' : '暂无请求记录'} icon="logs">{before ? '返回最新记录查看近期请求。' : '使用 API Key 发起调用后，这里会显示请求状态、Token 用量和耗时。'}</EmptyState> : <div className="table-scroll overflow-x-auto"><table className="w-full"><thead><tr><th>时间</th><th>Key / 账号</th><th>模型</th><th>状态</th><th>输入 / 输出 Token</th><th>耗时</th></tr></thead><tbody>{logs.map(log => <tr key={log.id}><td className="whitespace-nowrap">{new Date(log.created_at).toLocaleString()}</td><td>{data.keys.find(item => item.id === log.key_id)?.name || '已删除'} / {data.accounts.find(item => item.id === log.account_id)?.name || '已删除'}</td><td>{log.model}</td><td>{log.status}</td><td>{log.input_tokens} / {log.output_tokens}</td><td>{(log.duration_ms / 1000).toFixed(2)}s</td></tr>)}</tbody></table></div>}
    <div className="flex gap-2"><button disabled={loading || before === undefined} onClick={() => setBefore(undefined)}>最新记录</button><button disabled={loading || logs.length < 100} onClick={() => { const last = logs.at(-1); if (last) setBefore({ at: last.created_at, id: last.id }); }}>更早记录</button></div>
  </Panel>;
}
