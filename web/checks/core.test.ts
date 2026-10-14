import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { memoryStore, env, credential, eventBody } from './helpers';
import { hashPassword, open, parseCredential, seal, sessionUser, verifyPassword } from '../server/security';
import { accounts, admins } from '../server/tables';
import { schema } from '../server/schema';
import { appRouter, type Context } from '../server/router';
import { fromChat, sseData, toChat, translateStream } from '../server/protocols';
import { importAccount } from '../server/upstream';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('persistent credentials and database coordination', () => {
  it('persists a salted password hash and never resets an existing administrator', async () => {
    const { store, close } = memoryStore();
    try {
      await store.initialize();
      const initial = (await store.db.select().from(admins).get())!;
      expect(initial.username).toBe('admin');
      expect(initial.password_hash).toMatch(/^pbkdf2-sha256\$100000\$/);
      expect(initial.password_hash).not.toContain('admin123');
      expect(await verifyPassword('admin123', initial.password_hash)).toBe(true);
      expect(await hashPassword('admin123')).not.toBe(initial.password_hash);
      const updated = await hashPassword('new-admin-password');
      await store.db.update(admins).set({ password_hash: updated, version: 1 }).run();
      await store.initialize();
      expect((await store.db.select().from(admins).get())?.password_hash).toBe(updated);
      expect(await verifyPassword('admin123', updated)).toBe(false);
    } finally { close(); }
  });
  it('decrypts across environments and rejects tampering, including large exports', async () => {
    const payload = { ...credential, notes: '中文'.repeat(100000) };
    const encrypted = await seal(payload, env);
    expect(encrypted).not.toContain(credential.auth.accessToken);
    expect(await open(encrypted, { ...env })).toEqual(payload);
    await expect(open(encrypted, { ...env, DATA_ENCRYPTION_KEY: 'different-encryption-key-0123456789' })).rejects.toThrow();
    expect(() => parseCredential({ auth: { $wbEncrypted: 'test' } })).toThrow('桌面');
  });
  it('allows one lease owner and ignores release from a different instance', async () => {
    const { store, close } = memoryStore(); await store.initialize();
    try {
      const leases = await Promise.all(Array.from({ length: 8 }, () => store.lease('account:1', 5000)));
      expect(leases.filter(Boolean)).toHaveLength(1);
      await store.release('account:1', 'wrong-owner');
      expect(await store.lease('account:1', 5000)).toBeNull();
      await store.release('account:1', leases.find(Boolean)!);
      expect(await store.lease('account:1', 5000)).toBeTruthy();
    } finally { close(); }
  });
  it('atomically limits attempts and rolls over the next time window', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1800000000000);
    const { store, close } = memoryStore(); await store.initialize();
    try {
      expect((await Promise.all(Array.from({ length: 10 }, () => store.limit('login', 3, 60000)))).filter(Boolean)).toHaveLength(3);
      vi.setSystemTime(Date.now() + 60000);
      expect(await store.limit('login', 3, 60000)).toBe(true);
    } finally { close(); }
  });
  it('keeps the D1 migrations aligned with the runtime schema', () => {
    expect(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8')).toBe(schema.slice(0, -1).join(';\n\n') + ';\n');
    expect(readFileSync(new URL('../migrations/0002_admins.sql', import.meta.url), 'utf8')).toBe(schema.at(-1) + ';\n');
  });
  it('authenticates the admin with an HttpOnly signed session', async () => {
    const { store, close } = memoryStore(); await store.initialize();
    const ctx: Context = { env, store, admin: false, request: new Request('https://example.test/api/trpc/auth.login'), headers: new Headers() };
    const caller = appRouter.createCaller(ctx);
    try {
      await expect(caller.accounts.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await expect(caller.auth.login({ username: 'admin', password: 'wrong' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await caller.auth.login({ username: 'admin', password: 'admin123' });
      const cookie = ctx.headers.get('Set-Cookie')!;
      expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure'); expect(cookie).toContain('SameSite=Strict');
      expect(await sessionUser(new Request('https://example.test', { headers: { cookie } }), env, store)).toEqual({ username: 'admin', version: 0 });
      expect(await sessionUser(new Request('https://example.test', { headers: { cookie: 'wb_session=invalid' } }), env, store)).toBeNull();
    } finally { close(); }
  });
  it('checks upstream ownership before importing credentials', async () => {
    const { store, close } = memoryStore(); await store.initialize();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: 0, data: { accounts: [{ uid: 'another-user' }] } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(importAccount(credential, '', store, env)).rejects.toThrow('uid 不匹配');
      expect(await store.db.select().from(accounts).all()).toHaveLength(0);
      fetchMock.mockResolvedValue(Response.json({ code: 0, data: { accounts: [credential.account] } }));
      const result = await importAccount(credential, '', store, env);
      expect(result.uid).toBe(credential.account.uid);
      const caller = appRouter.createCaller({ env, store, admin: true, request: new Request('https://example.test'), headers: new Headers() });
      expect(JSON.stringify(await caller.accounts.list())).not.toContain('test-upstream');
      expect(await caller.accounts.export({ ids: [result.id] })).toEqual({ items: [JSON.stringify(credential)] });
      const { key } = await caller.keys.create({ name: 'test' });
      expect(JSON.stringify(await caller.keys.list())).not.toContain(key);
    } finally { close(); }
  });
});

describe('protocol adapters', () => {
  it('preserves Responses tools and tool results and rejects implicit server-side history', () => {
    const chat = toChat({ model: 'test', input: [{ type: 'function_call', call_id: 'call1', name: 'search', arguments: '{}' }, { type: 'function_call_output', call_id: 'call1', output: 'result' }], tools: [{ type: 'function', name: 'search', parameters: {} }] }, 'responses');
    expect(chat.messages).toEqual([{ role: 'assistant', content: null, tool_calls: [{ id: 'call1', type: 'function', function: { name: 'search', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call1', content: 'result' }]);
    expect(() => toChat({ previous_response_id: 'resp_old' }, 'responses')).toThrow('完整对话历史');
    expect(() => toChat({ tools: [{ type: 'web_search' }] }, 'responses')).toThrow('function');
  });
  it('preserves Anthropic image and tool input', () => {
    const result = toChat({ model: 'test', messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'tool1', name: 'search', input: { query: '中文' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'result' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fake' } }] }] }, 'anthropic');
    expect(JSON.stringify(result)).toContain('data:image/png;base64,fake');
    expect(JSON.stringify(result)).toContain('tool_call_id');
    expect((result.messages as { role: string }[]).map(message => message.role)).toEqual(['assistant', 'tool', 'user']);
    const output = fromChat({ model: 'test', choices: [{ message: { tool_calls: [{ id: 'tool1', function: { name: 'search', arguments: '{"query":"中文"}' } }] } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }, 'anthropic');
    expect(output.content).toEqual([{ type: 'tool_use', id: 'tool1', name: 'search', input: { query: '中文' } }]);
  });
  it('parses split CRLF and multibyte UTF-8 SSE', async () => {
    const data = [];
    for await (const value of sseData(eventBody([{ text: '中文' }, '[DONE]'], 1))) data.push(value);
    expect(data).toEqual(['{"text":"中文"}', '[DONE]']);
  });
  it('groups parallel Responses function calls before their results', () => {
    const result = toChat({ input: [
      { type: 'function_call', call_id: 'a', name: 'first', arguments: '{}' },
      { type: 'function_call', call_id: 'b', name: 'second', arguments: '{}' },
      { type: 'function_call_output', call_id: 'a', output: 'one' },
      { type: 'function_call_output', call_id: 'b', output: 'two' },
    ] }, 'responses');
    const messages = result.messages as { role: string; tool_calls?: unknown[] }[];
    expect(messages.map(message => message.role)).toEqual(['assistant', 'tool', 'tool']);
    expect(messages[0].tool_calls).toHaveLength(2);
  });
  it.each(['chat', 'responses', 'anthropic'] as const)('streams deltas and records final usage for %s', async protocol => {
    const values = [{ choices: [{ delta: { content: '中' } }] }, { choices: [{ delta: { content: '文' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }, '[DONE]'];
    const usage = { input: 0, output: 0 }; const output = [];
    for await (const event of translateStream(eventBody(values), protocol, 'test', usage)) output.push(event);
    expect(usage).toEqual({ input: 5, output: 2 });
    expect(output.join('')).toContain(protocol === 'chat' ? '[DONE]' : protocol === 'responses' ? 'response.completed' : 'message_stop');
    expect(output.join('')).toContain(protocol === 'chat' ? '中' : protocol === 'responses' ? 'response.output_text.delta' : 'text_delta');
  });
  it('keeps parallel tool indexes and final Responses output consistent', async () => {
    const values = [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'callA', function: { name: 'a', arguments: '{' } }, { index: 1, id: 'callB', function: { name: 'b', arguments: '{' } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"x":2}' } }, { index: 0, function: { arguments: '"x":1}' } }] }, finish_reason: 'tool_calls' }] }, '[DONE]'];
    let output = ''; for await (const value of translateStream(eventBody(values), 'responses', 'test', { input: 0, output: 0 })) output += value;
    const completed = output.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).find(event => event.type === 'response.completed');
    expect(completed.response.output.map((item: { call_id: string }) => item.call_id)).toEqual(['callA', 'callB']);
    expect(completed.response.output.map((item: { arguments: string }) => JSON.parse(item.arguments))).toEqual([{ x: 1 }, { x: 2 }]);
  });
  it('fails truncated upstream streams instead of reporting success', async () => {
    const consume = async () => { for await (const event of translateStream(eventBody([{ choices: [{ delta: { content: 'partial' } }] }]), 'responses', 'test', { input: 0, output: 0 })) void event; };
    await expect(consume()).rejects.toThrow('提前结束');
  });
});
