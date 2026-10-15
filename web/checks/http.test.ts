import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStore, env, credential, eventBody } from './helpers';
import * as storage from '../server/store';
import { app } from '../server/app';
import { appRouter } from '../server/router';
import { seal } from '../server/security';
import vercel from '../api/index';
import { accounts, leases, logs, models } from '../server/tables';
import { eq } from 'drizzle-orm';
import { authenticate } from '../server/gateway';
import { GatewayRequest } from '../server/gateway-request';

let store: storage.Store;
let close: () => void;
let accountId: string;
beforeEach(async () => {
  ({ store, close } = memoryStore()); await store.initialize();
  vi.spyOn(storage, 'storeFor').mockReturnValue(store);
  accountId = crypto.randomUUID();
  await store.db.insert(accounts).values({ id: accountId, uid: credential.account.uid, name: 'test', credential: await seal(credential, env), updated_at: Date.now() }).run();
  await store.db.insert(models).values({ id: 'test-model', detail: '{}' }).run();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); close(); });
function caller() { return appRouter.createCaller({ env, store, admin: true, request: new Request('https://example.test'), headers: new Headers() }); }
function request(path: string, key: string, input: unknown, signal?: AbortSignal) {
  return app.fetch(new Request('https://example.test' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(input), signal }), env);
}
function managementRequest(path: string, input: unknown, cookie?: string) {
  return app.fetch(new Request('https://example.test/api/trpc/' + path, { method: 'POST', headers: { Origin: 'https://example.test', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(input) }), env);
}
const chat = { model: 'test-model', choices: [{ message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };

describe('HTTP auth, quotas and gateway accounting', () => {
  it('logs in with the default database admin without username or password environment variables', async () => {
    const result = await app.fetch(new Request('https://example.test/api/trpc/auth.login', { method: 'POST', headers: { Origin: 'https://example.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) }), { ADMIN_JWT_SECRET: env.ADMIN_JWT_SECRET, DATA_ENCRYPTION_KEY: env.DATA_ENCRYPTION_KEY });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ result: { data: { username: 'admin' } } });
    expect(result.headers.get('Set-Cookie')).toContain('HttpOnly');
  });
  it('changes the password, invalidates every old session and keeps the new password after initialization', async () => {
    const login = await managementRequest('auth.login', { username: 'admin', password: 'admin123' });
    const cookie = login.headers.get('Set-Cookie')!;
    const another = await managementRequest('auth.login', { username: 'admin', password: 'admin123' });
    const changed = await managementRequest('auth.changePassword', { currentPassword: 'admin123', newPassword: 'updated-password' }, cookie);
    expect(changed.status).toBe(200);
    for (const oldCookie of [cookie, another.headers.get('Set-Cookie')!]) {
      expect((await app.fetch(new Request('https://example.test/api/trpc/auth.me', { headers: { Cookie: oldCookie } }), env)).status).toBe(401);
    }
    await store.initialize();
    expect((await managementRequest('auth.login', { username: 'admin', password: 'admin123' })).status).toBe(401);
    expect((await managementRequest('auth.login', { username: 'admin', password: 'updated-password' })).status).toBe(200);
  });
  it('rejects unauthenticated, wrong-current-password and invalid new-password changes', async () => {
    const valid = { currentPassword: 'admin123', newPassword: 'updated-password' };
    expect((await managementRequest('auth.changePassword', valid)).status).toBe(401);
    const login = await managementRequest('auth.login', { username: 'admin', password: 'admin123' });
    const cookie = login.headers.get('Set-Cookie')!;
    for (const input of [{ ...valid, currentPassword: 'wrong' }, { ...valid, newPassword: 'short' }, { ...valid, newPassword: 'admin123' }]) {
      expect((await managementRequest('auth.changePassword', input, cookie)).status).toBe(400);
    }
    expect((await managementRequest('auth.login', { username: 'admin', password: 'admin123' })).status).toBe(200);
  });
  it('rejects cross-origin mutations and signs a tRPC login cookie over HTTP', async () => {
    const body = JSON.stringify({ username: 'admin', password: 'admin123' });
    const bad = await app.fetch(new Request('https://example.test/api/trpc/auth.login', { method: 'POST', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' }, body }), env);
    expect(bad.status).toBe(403);
    const good = await app.fetch(new Request('https://example.test/api/trpc/auth.login', { method: 'POST', headers: { Origin: 'https://example.test', 'Content-Type': 'application/json' }, body }), env);
    expect(good.status).toBe(200);
    const cookie = good.headers.get('Set-Cookie')!;
    expect(cookie).toContain('HttpOnly');
    const accounts = await app.fetch(new Request('https://example.test/api/trpc/accounts.list', { headers: { Cookie: cookie } }), env);
    expect(accounts.status).toBe(200); expect(await accounts.text()).not.toContain(credential.auth.accessToken);
    expect((await app.fetch(new Request('https://example.test/api/trpc/accounts.list'), env)).status).toBe(401);
  });
  it('keeps API CORS separate from cookie-authenticated administration', async () => {
    const result = await app.fetch(new Request('https://example.test/v1/messages', { method: 'OPTIONS', headers: { Origin: 'https://client.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-api-key,anthropic-version' } }), env);
    expect(result.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(result.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect((await request('/v1/chat/completions', 'bad', { model: 'test-model', messages: [{ role: 'user', content: 'hello' }] })).status).toBe(401);
  });
  it('refreshes credentials and syncs account balance with Workers-compatible fetch', async () => {
    const login = await managementRequest('auth.login', { username: 'admin', password: 'admin123' });
    const cookie = login.headers.get('Set-Cookie')!;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.redirect === 'error') throw new TypeError('Workers does not support redirect: error');
      if (String(input).endsWith('/auth/token/refresh')) return Response.json({ code: 0, data: { accessToken: 'refreshed-access', expiresIn: 3600 } });
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer refreshed-access');
      return Response.json({ code: 0, data: { Response: { Data: { Accounts: [{ CapacityUnit: 'credits', CycleCapacityRemain: 7, CapacitySize: 10 }] } } } });
    }));
    expect((await managementRequest('accounts.refresh', { id: accountId }, cookie)).status).toBe(200);
    const synced = await managementRequest('accounts.sync', { id: accountId }, cookie);
    expect(synced.status).toBe(200);
    expect(await synced.json()).toMatchObject({ result: { data: { balance: 7, total: 10 } } });
  });
  it.each(['/v1/chat/completions', '/v1/responses', '/v1/messages'])('forwards %s and writes usage once', async path => {
    const { key } = await caller().keys.create({ name: 'test', requestLimit: 1 });
    const upstream = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.redirect === 'error') throw new TypeError('Workers does not support redirect: error');
      return Response.json(chat);
    }); vi.stubGlobal('fetch', upstream);
    const input = { model: 'test-model', input: 'hello', messages: [{ role: 'user', content: 'hello' }] };
    const result = await request(path, key, input);
    expect(result.status).toBe(200); expect(await result.text()).toContain('你好');
    expect(upstream.mock.calls).toHaveLength(1);
    expect(await caller().stats()).toEqual({ requests: 1, tokens: 5, failed: 0 });
    expect((await caller().keys.list())[0].requests).toBe(1);
    expect((await request(path, key, input)).status).toBe(429);
    expect(upstream.mock.calls).toHaveLength(1);
    expect(await store.db.select().from(leases).all()).toHaveLength(0);
  });
  it('does not fall back to the pool after a bound account or group is deleted', async () => {
    const admin = caller();
    const { key } = await admin.keys.create({ name: 'bound', accountId });
    await admin.accounts.remove({ id: accountId });
    const another = crypto.randomUUID();
    await store.db.insert(accounts).values({ id: another, uid: 'different-user', name: 'other', credential: await seal(credential, env), updated_at: Date.now() }).run();
    expect((await request('/v1/chat/completions', key, { model: 'test-model', messages: [{ role: 'user', content: 'hello' }] })).status).toBe(503);
    const group = await admin.groups.save({ name: 'limited', models: ['test-model'] });
    const groupKey = await admin.keys.create({ name: 'group', groupId: group.id });
    await admin.groups.remove({ id: group.id });
    expect((await request('/v1/chat/completions', groupKey.key, { model: 'test-model', messages: [{ role: 'user', content: 'hello' }] })).status).toBe(403);
  });
  it('releases only its own leases when an account lease has a new owner', async () => {
    const { key } = await caller().keys.create({ name: 'lease-owner' });
    vi.stubGlobal('fetch', vi.fn(async () => {
      await store.db.update(leases).set({ owner: 'new-owner' }).where(eq(leases.id, `account:${accountId}`)).run();
      return Response.json(chat);
    }));
    expect((await request('/v1/chat/completions', key, { model: 'test-model', messages: [{ role: 'user', content: 'hello' }] })).status).toBe(200);
    expect(await store.db.select().from(leases).all()).toMatchObject([{ id: `account:${accountId}`, owner: 'new-owner' }]);
  });
  it('atomically enforces a quota across concurrent requests to multiple accounts', async () => {
    for (let i = 0; i < 3; i++) await store.db.insert(accounts).values({ id: crypto.randomUUID(), uid: 'test-user-' + i, name: 'other', credential: await seal(credential, env), updated_at: Date.now() }).run();
    const { key } = await caller().keys.create({ name: 'quota', requestLimit: 1 });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(chat)));
    const results = await Promise.all(Array.from({ length: 4 }, () => request('/v1/chat/completions', key, { model: 'test-model', messages: [{ role: 'user', content: 'hello' }] })));
    expect(results.filter(response => response.status === 200)).toHaveLength(1);
    expect(results.filter(response => response.status === 429)).toHaveLength(3);
    expect((await caller().keys.list())[0].requests).toBe(1);
    expect(await store.db.select().from(leases).all()).toHaveLength(0);
  });
  it.each(['account-lease', 'quota', 'account-update'])('releases acquired leases when admission fails at %s', async stage => {
    const { key } = await caller().keys.create({ name: 'admission-failure' });
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    if (stage === 'account-lease') {
      const lease = store.lease.bind(store);
      vi.spyOn(store, 'lease').mockImplementation((id, duration) => {
        if (id.startsWith('account:')) throw new Error('lease unavailable');
        return lease(id, duration);
      });
    } else {
      const update = store.db.update.bind(store.db);
      const spy = vi.spyOn(store.db, 'update');
      if (stage === 'account-update') spy.mockImplementationOnce(update);
      spy.mockImplementationOnce(() => { throw new Error('database unavailable'); });
    }
    expect((await request('/v1/chat/completions', key, { model: 'test-model', messages: [{ role: 'user', content: 'hello' }] })).status).toBe(502);
    expect(upstream).not.toHaveBeenCalled();
    expect(await store.db.select().from(leases).all()).toHaveLength(0);
    expect((await caller().keys.list())[0].requests).toBe(stage === 'account-update' ? 1 : 0);
    expect(await caller().stats()).toMatchObject({ requests: stage === 'account-update' ? 1 : 0 });
  });
  it.each(['reader', 'signal'])('cancels an in-flight stream read through %s and settles once before releasing its leases', async method => {
    const { key } = await caller().keys.create({ name: 'cancel' });
    const clientAbort = new AbortController();
    let readStarted!: () => void;
    const reading = new Promise<void>(resolve => { readStarted = resolve; });
    let upstreamCancelled = false;
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init!.signal!.addEventListener('abort', () => { upstreamCancelled = true; controller.error(new Error('aborted')); }, { once: true });
        },
        pull() { readStarted(); },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    }));
    const result = await request('/v1/chat/completions', key, { model: 'test-model', messages: [{ role: 'user', content: 'hello' }], stream: true }, clientAbort.signal);
    const reader = result.body!.getReader();
    const pending = reader.read();
    await reading;
    if (method === 'reader') await reader.cancel();
    else clientAbort.abort();
    expect(await pending).toMatchObject({ done: true });
    expect(upstreamCancelled).toBe(true);
    expect(await store.db.select().from(leases).all()).toHaveLength(0);
    expect(await caller().logs.list()).toMatchObject([{ status: 499 }]);
    expect((await caller().keys.list())[0].requests).toBe(1);
  });
  it('shares settlement between completion and cancellation callers', async () => {
    const { key } = await caller().keys.create({ name: 'shared-settlement' });
    const row = await authenticate(new Request('https://example.test', { headers: { Authorization: 'Bearer ' + key } }), store);
    const session = await GatewayRequest.start(store, row!, 'test-model');
    session.usage.input = 3; session.usage.output = 2;
    const completion = session.finish(200), cancellation = session.finish(499);
    expect(cancellation).toBe(completion);
    await Promise.all([completion, cancellation]);
    expect(await caller().stats()).toEqual({ requests: 1, tokens: 5, failed: 0 });
    expect((await caller().keys.list())[0]).toMatchObject({ requests: 1, tokens: 5 });
    expect(await store.db.select().from(leases).all()).toHaveLength(0);
  });
  it('accounts for final stream usage and fails interrupted streams', async () => {
    const { key } = await caller().keys.create({ name: 'stream' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(eventBody([{ choices: [{ delta: { content: '你好' } }] }, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }, '[DONE]']), { headers: { 'Content-Type': 'text/event-stream' } })));
    const result = await request('/v1/responses', key, { model: 'test-model', input: 'hello', stream: true });
    expect(await result.text()).toContain('response.completed');
    expect(await caller().stats()).toEqual({ requests: 1, tokens: 5, failed: 0 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(eventBody([{ choices: [{ delta: { content: 'partial' } }] }]), { headers: { 'Content-Type': 'text/event-stream' } })));
    const interrupted = await request('/v1/messages', key, { model: 'test-model', messages: [{ role: 'user', content: 'hello' }], stream: true });
    expect(await interrupted.text()).toContain('event: error');
    expect(await caller().stats()).toEqual({ requests: 2, tokens: 5, failed: 1 });
    expect(await store.db.select().from(leases).all()).toHaveLength(0);
  });
  it('keeps upstream error payloads out of client errors and cools a failing account', async () => {
    const { key } = await caller().keys.create({ name: 'error' });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: credential.auth.accessToken }, { status: 429 })));
    const result = await request('/v1/chat/completions', key, { model: 'test-model', messages: [{ role: 'user', content: 'hello' }] });
    expect(result.status).toBe(429); expect(await result.text()).not.toContain(credential.auth.accessToken);
    expect((await caller().accounts.list())[0].cool_until).toBeGreaterThan(Date.now());
    expect(await caller().stats()).toEqual({ requests: 1, tokens: 0, failed: 1 });
  });
  it('restores the original route and query in the Vercel Web-standard entry', async () => {
    const result = await vercel.fetch(new Request('https://example.test/api/index?__wb_path=/health'));
    expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ ok: true });
    const { key } = await caller().keys.create({ name: 'vercel' });
    const models = await vercel.fetch(new Request('https://example.test/api/index?__wb_path=/v1/models', { headers: { Authorization: 'Bearer ' + key } }));
    expect(await models.json()).toMatchObject({ data: [{ id: 'test-model' }] });
  });
  it('paginates logs without losing rows that share a timestamp', async () => {
    const now = Date.now();
    for (let index = 0; index < 105; index++) await store.db.insert(logs).values({ id: crypto.randomUUID(), key_id: 'test-key', account_id: accountId, model: 'test-model', status: 200, duration_ms: 10, created_at: now }).run();
    const first = await caller().logs.list(); const last = first.at(-1)!;
    const second = await caller().logs.list({ before: last.created_at, beforeId: last.id });
    expect(first).toHaveLength(100); expect(second).toHaveLength(5);
    expect(new Set([...first, ...second].map(log => log.id)).size).toBe(105);
  });
});
