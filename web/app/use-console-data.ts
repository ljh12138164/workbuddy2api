'use client';
import { useCallback, useRef, useState } from 'react';
import { rpc, type Data, type DataSection, type Run } from './client';

const sections: DataSection[] = ['accounts', 'keys', 'models', 'groups', 'stats'];
const queries = {
  accounts: () => rpc.accounts.list.query(), keys: () => rpc.keys.list.query(),
  models: () => rpc.models.list.query(), groups: () => rpc.groups.list.query(), stats: () => rpc.stats.query(),
};

export function useConsoleData() {
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const generation = useRef(0);
  const reload = useCallback(async (changed: DataSection[], current: number) => {
    if (!changed.length) return;
    const entries = await Promise.all([...new Set(changed)].map(async name => [name, await queries[name]()]));
    if (generation.current === current) setData(previous => ({ ...previous, ...Object.fromEntries(entries) }) as Data);
  }, []);

  const run: Run = useCallback(async (operation, message, changed = []) => {
    const current = generation.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await operation();
      if (generation.current !== current) return result;
      if (message) setNotice(message);
      try { await reload(changed, current); }
      catch { if (generation.current === current) setError('操作已完成，但数据刷新失败，请点击“刷新数据”重试。'); }
      return result;
    } catch (err) {
      if (generation.current === current) setError(err instanceof Error ? err.message : '操作失败');
    } finally { if (generation.current === current) setBusy(false); }
  }, [reload]);

  const refresh = useCallback((message?: string) => run(() => reload(sections, generation.current), message), [reload, run]);
  const reset = useCallback((message = '') => {
    generation.current++; setData(null); setBusy(false); setError(''); setNotice(message);
  }, []);
  const clearFeedback = () => { setError(''); setNotice(''); };
  return { data, busy, error, notice, run, refresh, reset, clearFeedback };
}
