import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { env } from './helpers';
import { app } from '../server/app';
import { storeFor } from '../server/store';
import { accounts as accountsTable, keys, leases, models } from '../server/tables';
import { credential } from './helpers';
import { digest, seal } from '../server/security';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('runs login and management through the D1 HTTP driver without a Worker binding', async () => {
  const database = new DatabaseSync(':memory:');
  const remoteEnv = { ...env, CLOUDFLARE_ACCOUNT_ID: 'test-account', D1_DATABASE_ID: 'test-database', D1_API_TOKEN: 'test-d1-token' };
  const queries: string[] = [];
  let failAccounting = false;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    // Workers rejects this redirect mode before sending the request.
    if (init?.redirect === 'error') throw new TypeError('Workers does not support redirect: error');
    if (String(input) === 'https://copilot.tencent.com/v2/chat/completions') {
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } });
    }
    expect(String(input)).toBe('https://api.cloudflare.com/client/v4/accounts/test-account/d1/database/test-database/raw');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-d1-token');
    const query = JSON.parse(String(init?.body)) as { sql: string; params: (string | number | null)[] };
    queries.push(query.sql);
    if (failAccounting && query.sql.startsWith('insert into "wb_logs"')) return new Response(null, { status: 500 });
    const statement = database.prepare(query.sql);
    let rows: unknown[][] = [];
    const columns = statement.columns().map(column => column.name);
    if (columns.length) {
      statement.setReturnArrays(true);
      rows = statement.all(...query.params).map(row => Array.isArray(row) ? row : Object.values(row));
    } else statement.run(...query.params);
    return Response.json({ success: true, result: [{ success: true, results: { columns, rows } }] });
  }));
  try {
    const initial = await Promise.all(Array.from({ length: 4 }, () => app.fetch(new Request('https://vercel.test/api/trpc/auth.me'), { ...remoteEnv })));
    expect(initial.every(response => response.status === 401)).toBe(true);
    expect(queries.filter(query => query.startsWith('CREATE '))).toHaveLength(10);
    queries.length = 0;
    const login = await app.fetch(new Request('https://vercel.test/api/trpc/auth.login', { method: 'POST', headers: { Origin: 'https://vercel.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) }), remoteEnv);
    expect(login.status).toBe(200);
    const cookie = login.headers.get('Set-Cookie')!;
    queries.length = 0;
    const accounts = await app.fetch(new Request('https://vercel.test/api/trpc/accounts.list', { headers: { Cookie: cookie } }), remoteEnv);
    expect(accounts.status).toBe(200);
    expect(await accounts.json()).toMatchObject({ result: { data: [] } });
    expect(queries).toHaveLength(2); // Session validation and the requested list only.
    expect(queries.some(query => query.startsWith('CREATE '))).toBe(false);
    const group = await app.fetch(new Request('https://vercel.test/api/trpc/groups.save', { method: 'POST', headers: { Origin: 'https://vercel.test', 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: '测试分组', models: ['test-model'] }) }), remoteEnv);
    expect(group.status).toBe(200);
    const groups = await app.fetch(new Request('https://vercel.test/api/trpc/groups.list', { headers: { Cookie: cookie } }), remoteEnv);
    expect(await groups.json()).toMatchObject({ result: { data: [{ name: '测试分组' }] } });
    expect((await app.fetch(new Request('https://vercel.test/v1/models', { headers: { Authorization: 'Bearer invalid' } }), remoteEnv)).status).toBe(401);
    const store = storeFor(remoteEnv);
    await store.db.insert(accountsTable).values({ id: 'account', uid: credential.account.uid, name: 'test', credential: await seal(credential, env), updated_at: Date.now() }).run();
    await store.db.insert(models).values({ id: 'test-model', detail: '{}' }).run();
    await store.db.insert(keys).values({ id: 'key', name: 'test', key_hash: await digest('test-key'), prefix: 'test', created_at: Date.now() }).run();
    queries.length = 0;
    const reply = await app.fetch(new Request('https://vercel.test/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }] }) }), remoteEnv);
    expect(reply.status).toBe(200);
    expect(await reply.json()).toMatchObject({ choices: [{ message: { content: 'OK' } }] });
    expect(queries).toHaveLength(11);
    expect(queries.filter(query => query.startsWith('delete from "wb_leases"'))).toHaveLength(1);
    expect(queries.filter(query => query.startsWith('delete from "wb_limits"'))).toHaveLength(0);
    failAccounting = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const partial = await app.fetch(new Request('https://vercel.test/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }] }) }), remoteEnv);
    expect(partial.status).toBe(200);
    expect(errors).toHaveBeenCalledOnce();
    expect(await store.db.select().from(leases).all()).toHaveLength(0);
    expect((await store.db.select().from(keys).get())?.tokens).toBe(6);
  } finally { database.close(); }
});

it('reuses stores across request environments and isolates database and token changes', () => {
  const remoteEnv = { ...env, CLOUDFLARE_ACCOUNT_ID: 'cache-account', D1_DATABASE_ID: 'cache-database', D1_API_TOKEN: 'cache-token' };
  const store = storeFor(remoteEnv);
  expect(storeFor({ ...remoteEnv })).toBe(store);
  expect(storeFor({ ...remoteEnv, D1_DATABASE_ID: 'other-database' })).not.toBe(store);
  expect(storeFor({ ...remoteEnv, D1_API_TOKEN: 'other-token' })).not.toBe(store);
});
