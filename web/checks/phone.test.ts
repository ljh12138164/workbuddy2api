import { afterEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { leases, loginSessions } from '../server/tables';
import { credential, env, memoryStore } from './helpers';
import { startPhone, sendPhone, verifyPhone } from '../server/phone-login';
import { open } from '../server/security';

afterEach(() => vi.unstubAllGlobals());
it('persists SMS cookies between requests and consumes an authorization token only once', async () => {
  const { store, close } = memoryStore(); await store.initialize();
  let sessionId = '', consumedCalls = 0, loggedIn = false;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); const headers = new Headers(init?.headers);
    if (url.pathname === '/v2/plugin/auth/state') return Response.json({ code: 0, data: { state: 'plugin-state' } }, { headers: { 'Set-Cookie': 'session=test; Path=/; Secure; HttpOnly' } });
    if (url.pathname === '/console/auth/login') return loggedIn ? new Response('done') : new Response(null, { status: 302, headers: { Location: '/auth/login' } });
    if (url.pathname === '/auth/login') { expect(headers.get('Cookie')).toContain('session=test'); return new Response('<a data-idp="oneid" href="/auth/broker">登录</a>'); }
    if (url.pathname === '/auth/broker') return new Response(null, { status: 302, headers: { Location: 'https://oauth2.account.tencent.com/authorize?state=oneid-state' } });
    if (url.pathname === '/authorize') return new Response('ready', { headers: { 'Set-Cookie': 'oneid=ready; Path=/; Secure' } });
    if (url.pathname === '/v1/auth/sms/code/send') { expect(headers.get('Cookie')).toContain('oneid=ready'); return Response.json({ state_token: 'sms-token', expires_in: 60 }); }
    if (url.pathname === '/v1/auth/sms/code/verify') return Response.json({ state_token: 'verified-token' });
    if (url.pathname === '/v1/auth/accounts') {
      consumedCalls++;
      const row = (await store.db.select().from(loginSessions).where(eq(loginSessions.id, sessionId)).get())!;
      expect(await open(row.payload, env)).toMatchObject({ consumed: true });
      return Response.json({ code: 'authorization-code' });
    }
    if (url.pathname === '/auth/realms/copilot/broker/oneid/endpoint') { loggedIn = true; return new Response('authorized'); }
    if (url.pathname === '/v2/plugin/auth/token') return Response.json({ code: 0, data: credential.auth });
    if (url.pathname === '/v2/plugin/accounts') return Response.json({ code: 0, data: { accounts: [credential.account] } });
    throw new Error('Unexpected test URL: ' + url.pathname);
  }));
  try {
    sessionId = (await startPhone(store, env)).id;
    await sendPhone(sessionId, '13800000000', store, env);
    await expect(sendPhone(sessionId, '13800000000', store, env)).rejects.toThrow('60 秒');
    const result = await verifyPhone(sessionId, '123456', store, env);
    expect(result.uid).toBe(credential.account.uid);
    expect(await verifyPhone(sessionId, '123456', store, env)).toEqual(result);
    expect(consumedCalls).toBe(1);
    expect(await store.db.select().from(leases).all()).toHaveLength(0);
  } finally { close(); }
});

it('rejects an untrusted authorization redirect before fetching it', async () => {
  const { store, close } = memoryStore(); await store.initialize();
  const fetchMock = vi.fn(async (input: string | URL | Request) => String(input).includes('/v2/plugin/auth/state') ? Response.json({ data: { state: 'test' } }) : new Response(null, { status: 302, headers: { Location: 'https://evil.test/login' } }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    await expect(startPhone(store, env)).rejects.toThrow('不受信任');
    expect(fetchMock.mock.calls.map(call => String(call[0])).every(url => !url.includes('evil.test'))).toBe(true);
  } finally { close(); }
});
