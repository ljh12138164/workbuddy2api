import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../server/app';
import * as storage from '../server/store';
import { accounts, leases } from '../server/tables';
import { open, seal } from '../server/security';
import { credential, env, eventBody, memoryStore } from './helpers';
import type { Credential } from '../server/types';
import { runGrowth, taskPlan } from '../server/growth';

let store: storage.Store, close: () => void, accountId: string;
beforeEach(async () => {
  ({ store, close } = memoryStore()); await store.initialize();
  vi.spyOn(storage, 'storeFor').mockReturnValue(store);
  accountId = crypto.randomUUID();
  await store.db.insert(accounts).values({ id: accountId, uid: credential.account.uid, name: 'growth', credential: await seal(credential, env), updated_at: Date.now() }).run();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); close(); });
const post = (path: string, input: unknown) => app.fetch(new Request('https://example.test/v1/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }), env);
const success = (data: unknown) => Response.json({ code: 0, data });

describe('public account automation', () => {
  it('refreshes and persists credentials without a login cookie or API key', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('X-Refresh-Token')).toBe(credential.auth.refreshToken);
      return success({ accessToken: 'rotated-access', refreshToken: 'rotated-refresh', expiresIn: 7200 });
    }));
    const response = await post('credentials/refresh', { accountId });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('rotated-access'); expect(text).not.toContain('rotated-refresh');
    const saved = await store.db.select().from(accounts).get();
    expect((await open<Credential>(saved!.credential, env)).auth).toMatchObject({ accessToken: 'rotated-access', refreshToken: 'rotated-refresh' });
    expect(await store.db.select().from(leases).all()).toHaveLength(0);
  });
  it('accepts, executes, verifies and claims tasks rather than assuming a successful event means completion', async () => {
    let state = 'not_accepted';
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname; paths.push(path);
      if (path.endsWith('/tasks')) return success({ tasks: [{ task_code: 'chat_5', title: '对话', reward_credit: 100, accept_status: state, progress: { current: state === 'completed' ? 1 : 0, target: 1 } }] });
      if (path.endsWith('/accept')) { state = 'accepted'; return success({ results: [{ task_code: 'chat_5', status: 'accepted' }] }); }
      if (path.endsWith('/completions')) {
        expect(JSON.parse(String(init?.body)).extra_vars.growthEvent).toContain('chat_request_send');
        state = 'completed'; return new Response(eventBody([{ choices: [{ finish_reason: 'stop' }] }, '[DONE]']), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (path.endsWith('/claim')) { state = 'claimed'; return success({ credit: 100 }); }
      throw new Error('Unexpected path: ' + path);
    }));
    const response = await post('growth/run', { accountId });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, accountId, credit: 100, tasks: [{ task_code: 'chat_5', status: 'claimed', ok: true }] });
    expect(paths.indexOf('/v2/activity/growth/tasks/accept')).toBeLessThan(paths.indexOf('/v2/chat/completions'));
    expect(await store.db.select().from(leases).all()).toHaveLength(0);
  });
  it.each(['growth/run', 'credentials/refresh'])('validates account IDs and reports missing accounts on %s', async path => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    expect((await post(path, { accountId: 'bad' })).status).toBe(400);
    expect((await post(path, {})).status).toBe(400);
    expect((await post(path, { accountId: crypto.randomUUID() })).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('excludes other automation and gateway use of the same account', async () => {
    const owner = await store.lease(`account:${accountId}`, 270000);
    for (const path of ['growth/run', 'credentials/refresh']) expect((await post(path, { accountId })).status).toBe(409);
    expect(await store.db.select().from(leases).all()).toMatchObject([{ owner }]);
  });
  it('does not overwrite good credentials when the upstream refresh fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => success({ accessToken: '' })));
    expect((await post('credentials/refresh', { accountId })).status).toBe(502);
    const saved = await store.db.select().from(accounts).get();
    expect((await open<Credential>(saved!.credential, env)).auth.accessToken).toBe(credential.auth.accessToken);
    expect(await store.db.select().from(leases).all()).toHaveLength(0);
  });
  it('does not execute a rejected acceptance or hide the upstream reason', async () => {
    const upstream = vi.fn(async (url: string) => url.endsWith('/accept')
      ? success({ results: [{ task_code: 'chat_5', status: 'error', message: 'task unavailable' }] })
      : success({ tasks: [{ task_code: 'chat_5', reward_credit: 100, accept_status: 'not_accepted' }] }));
    vi.stubGlobal('fetch', upstream);
    const response = await post('growth/run', { accountId });
    expect(await response.json()).toMatchObject({ ok: false, tasks: [{ ok: false, message: 'task unavailable', fired: 0 }] });
    expect(upstream.mock.calls.some(([url]) => url.endsWith('/completions'))).toBe(false);
  });
  it('keeps an event successful but unverified task incomplete and does not claim it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/completions')) return new Response(eventBody(['[DONE]']), { headers: { 'Content-Type': 'text/event-stream' } });
      if (url.endsWith('/claim')) throw new Error('Must not claim incomplete tasks');
      return success({ tasks: [{ task_code: 'chat_5', reward_credit: 100, accept_status: 'accepted', progress: { current: 0, target: 1 } }] });
    }));
    const result = runGrowth(credential, env, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(15000);
    expect(await result).toMatchObject({ ok: false, tasks: [{ status: 'accepted', ok: false, fired: 1 }] });
  });
  it('does not send telemetry when real object lookup fails', async () => {
    const upstream = vi.fn(async (url: string) => url.endsWith('/tasks')
      ? success({ tasks: [{ task_code: 'expert_5', reward_credit: 100, accept_status: 'accepted', progress: { current: 0, target: 1 } }] })
      : success({ experts: [] }));
    vi.stubGlobal('fetch', upstream);
    expect(await (await post('growth/run', { accountId })).json()).toMatchObject({ ok: false, tasks: [{ fired: 0, message: '未找到可用的真实专家' }] });
    expect(upstream.mock.calls.some(([url]) => url.endsWith('/report'))).toBe(false);
  });
  it('reports claim failures and releases the account lease', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/tasks')
      ? success({ tasks: [{ task_code: 'chat_5', reward_credit: 100, accept_status: 'completed' }] })
      : Response.json({ code: 42 }, { status: 200 })));
    expect(await (await post('growth/run', { accountId })).json()).toMatchObject({ ok: false, credit: 0, tasks: [{ ok: false, status: 'completed' }] });
    expect(await store.db.select().from(leases).all()).toHaveLength(0);
  });
  it('reports unsupported, paid and zero-reward tasks without issuing actions', async () => {
    const tasks = ['unknown', 'Expert_Philanthropy', 'expert_5_paid', 'black_cat'].map(task_code => ({ task_code, accept_status: 'not_accepted', reward_credit: 100 }));
    const upstream = vi.fn(async (_url: string) => success({ tasks })); vi.stubGlobal('fetch', upstream);
    const result = await (await post('growth/run', { accountId })).json() as { tasks: { status: string; message: string }[] };
    expect(result.tasks).toHaveLength(4); expect(result.tasks.every(task => task.status === 'skipped' && task.message)).toBe(true);
    expect(upstream.mock.calls.every(([url]) => String(url).endsWith('/tasks'))).toBe(true);
    expect(taskPlan({ task_code: 'chat_10', reward_credit: 0 }).action).toBeUndefined();
  });
  it.each([
    ['Model_chat_GLM5.2', '/v2/chat/completions'], ['automation_1', '/v2/chat/completions'], ['skill_1', '/v2/chat/completions'],
    ['playbook_prompt', '/v2/report'], ['Library_read', '/v2/report'], ['expert_5', '/v2/report'],
    ['template_3', '/v2/report'], ['Expert_team_use_3', '/v2/report'], ['Expert_lighthouse', '/v2/report'],
    ['Hp_Appearance', '/v2/report'], ['Buddy_App', '/v2/report'], ['Buddy_App_QQ', '/v2/report'],
    ['RichMeow_Chat', '/v2/report'], ['create_canvas', '/v2/report'],
  ])('executes upstream strategy %s using TS', async (code, actionPath) => {
    let state = 'accepted'; const reports: { url: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname, body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (path.endsWith('/tasks')) return success({ tasks: [{ task_code: code, reward_credit: 100, accept_status: state, progress: { current: 0, target: 1 } }] });
      if (path.endsWith('/claim')) { state = 'claimed'; return success({ credit: 100 }); }
      if (path.includes('/expert/list')) return success({ experts: [{ expert_id: 'real-lighthouse-id', display_name_zh: '轻量云', expert_type: code.includes('team') ? 'team' : 'agent' }] });
      if (path.includes('/support/scenes')) return success({ scenes: [{ id: 'real-scene-id', name: '真实模板' }] });
      if (path.endsWith('/appearance/resources')) return success({ resources: [{ id: 'real-theme-id', name: '和平精英' }] });
      if (path.endsWith('/accesstoken')) return success({ access_token: 'ardot-token' });
      if (path === '/mcp') {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ardot-token');
        return Response.json({ jsonrpc: '2.0', id: body.id, result: body.method === 'initialize' ? {} : { structuredContent: { fileId: '1234567890' } } });
      }
      if (path === actionPath) {
        reports.push({ url, body }); state = 'completed';
        if (path.endsWith('/completions')) {
          if (code.startsWith('Model_chat')) expect(body.model).toBe('glm-5.2');
          return new Response(eventBody(['[DONE]']), { headers: { 'Content-Type': 'text/event-stream' } });
        }
        return success({});
      }
      throw new Error('Unexpected path: ' + path);
    }));
    expect(await (await post('growth/run', { accountId })).json()).toMatchObject({ ok: true, credit: 100, tasks: [{ task_code: code, status: 'claimed', fired: 1 }] });
    expect(reports).toHaveLength(1);
    const body = JSON.stringify(reports[0].body);
    if (code === 'create_canvas') expect(body).toContain('1234567890');
    if (code === 'Library_read') expect(reports[0].url.startsWith('https://www.workbuddy.cn/')).toBe(true);
    if (code.startsWith('Buddy') || code === 'RichMeow_Chat' || code === 'create_canvas') {
      expect(reports[0].url.startsWith('https://copilot.tencent.com/')).toBe(true);
      expect(body).toContain('machineId');
    }
  });
  it('unlocks the first conversation and adopts the buddy before dependent tasks', async () => {
    let first = 'not_accepted', next = 'not_accepted', adopted = false, accepted = 0;
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = new URL(url).pathname; paths.push(path);
      if (path.endsWith('/tasks')) return success({ tasks: [
        { task_code: 'first_buddy', reward_credit: 300, accept_status: first },
        { task_code: 'skill_1', reward_credit: 100, accept_status: next, progress: { current: 0, target: 1 } },
      ] });
      if (path.endsWith('/buddy/info')) return success({ buddy: adopted ? { buddy_id: 'real-buddy' } : null });
      if (path.endsWith('/buddy/agreement')) return success({});
      if (path.endsWith('/buddy/first')) { adopted = true; return success({}); }
      if (path.endsWith('/accept')) { accepted++; next = 'accepted'; return success({ results: [{ task_code: 'skill_1', status: 'accepted' }] }); }
      if (path.endsWith('/completions')) { if (first === 'not_accepted') first = 'completed'; else next = 'completed'; return new Response(eventBody(['[DONE]'])); }
      if (path.endsWith('/claim')) return success({ credit: 100 });
      throw new Error('Unexpected path: ' + path);
    }));
    expect(await (await post('growth/run', { accountId })).json()).toMatchObject({ ok: true });
    expect(adopted).toBe(true); expect(accepted).toBe(1);
    expect(paths.indexOf('/activity/growth/buddy/first')).toBeLessThan(paths.indexOf('/v2/activity/growth/tasks/accept'));
  });
  it.each([true, false])('handles persistent MCP SSE and refuses missing file IDs (real ID: %s)', async realId => {
    let state = 'accepted', cancelled = false, reported = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/tasks')) return success({ tasks: [{ task_code: 'create_canvas', reward_credit: 300, accept_status: state }] });
      if (path.endsWith('/accesstoken')) return success({ access_token: 'ardot-token' });
      if (path === '/mcp') {
        const input = JSON.parse(String(init?.body));
        const result = input.id === 1 ? {} : realId ? { content: [{ type: 'text', text: 'Created Ardot design file: test, fileId 654321, url https://ardot.tencent.com/file/654321' }] } : { id: 2, content: [{ type: 'text', text: 'created' }] };
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: input.id, result })}\n\n`)); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (path.endsWith('/report')) { reported = true; state = 'completed'; expect(String(init?.body)).toContain('654321'); return success({}); }
      if (path.endsWith('/claim')) return success({ credit: 300 });
      throw new Error('Unexpected path: ' + path);
    }));
    expect(await (await post('growth/run', { accountId })).json()).toMatchObject({ ok: realId });
    expect(reported).toBe(realId); expect(cancelled).toBe(true);
  });
  it('honors request cancellation and records unattempted tasks without issuing further writes', async () => {
    const controller = new AbortController(); let writes = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/tasks')) return success({ tasks: ['chat_5', 'skill_1'].map(task_code => ({ task_code, reward_credit: 100, accept_status: 'accepted', progress: { current: 0, target: 1 } })) });
      writes++; controller.abort(); throw new Error('aborted');
    }));
    expect(await runGrowth(credential, env, controller.signal)).toMatchObject({ ok: false, interrupted: true, tasks: [{ ok: false }, { ok: false, fired: 0 }] });
    expect(writes).toBe(1);
  });
  it('rotates credentials that would expire during a long task run and persists the new refresh token', async () => {
    await store.db.update(accounts).set({ credential: await seal({ ...credential, auth: { ...credential.auth, expiresAt: Date.now() + 90000 } }, env) }).run();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/refresh')) return success({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600 });
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer new-access');
      return success({ tasks: [] });
    }));
    expect((await post('growth/run', { accountId })).status).toBe(200);
    const saved = await store.db.select().from(accounts).get();
    expect((await open<Credential>(saved!.credential, env)).auth.refreshToken).toBe('new-refresh');
  });
  it('keeps the console task procedure behind management login', async () => {
    const response = await app.fetch(new Request('https://example.test/api/trpc/growth.run', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.test' }, body: JSON.stringify({ id: accountId }) }), env);
    expect(response.status).toBe(401);
  });
  it('does not treat an invalid upstream task list as an empty successful run', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => success({})));
    const response = await post('growth/run', { accountId });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: '上游未返回有效的任务列表' });
    expect(await store.db.select().from(leases).all()).toHaveLength(0);
  });
});
