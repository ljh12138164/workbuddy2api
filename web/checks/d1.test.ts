import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { env } from './helpers';
import { app } from '../server/app';

afterEach(() => vi.unstubAllGlobals());

it('runs login and management through the D1 HTTP driver without a Worker binding', async () => {
  const database = new DatabaseSync(':memory:');
  const remoteEnv = { ...env, CLOUDFLARE_ACCOUNT_ID: 'test-account', D1_DATABASE_ID: 'test-database', D1_API_TOKEN: 'test-d1-token' };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    // Workers rejects this redirect mode before sending the request.
    if (init?.redirect === 'error') throw new TypeError('Workers does not support redirect: error');
    expect(String(input)).toBe('https://api.cloudflare.com/client/v4/accounts/test-account/d1/database/test-database/raw');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-d1-token');
    const query = JSON.parse(String(init?.body)) as { sql: string; params: (string | number | null)[] };
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
    const login = await app.fetch(new Request('https://vercel.test/api/trpc/auth.login', { method: 'POST', headers: { Origin: 'https://vercel.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) }), remoteEnv);
    expect(login.status).toBe(200);
    const cookie = login.headers.get('Set-Cookie')!;
    const accounts = await app.fetch(new Request('https://vercel.test/api/trpc/accounts.list', { headers: { Cookie: cookie } }), remoteEnv);
    expect(accounts.status).toBe(200);
    expect(await accounts.json()).toMatchObject({ result: { data: [] } });
    const group = await app.fetch(new Request('https://vercel.test/api/trpc/groups.save', { method: 'POST', headers: { Origin: 'https://vercel.test', 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: '测试分组', models: ['test-model'] }) }), remoteEnv);
    expect(group.status).toBe(200);
    const groups = await app.fetch(new Request('https://vercel.test/api/trpc/groups.list', { headers: { Cookie: cookie } }), remoteEnv);
    expect(await groups.json()).toMatchObject({ result: { data: [{ name: '测试分组' }] } });
    expect((await app.fetch(new Request('https://vercel.test/v1/models', { headers: { Authorization: 'Bearer invalid' } }), remoteEnv)).status).toBe(401);
  } finally { database.close(); }
});
