import type { Context } from 'hono';
import { digest } from './security';
import { storeFor, type Store } from './store';
import { accountCredential, array, BACKEND, credentialHeaders, object, UpstreamError } from './upstream';
import { fromChat, toChat, translateStream, type Protocol, type Usage } from './protocols';
import type { AccountRow, KeyRow, RuntimeEnv } from './types';
import { and, asc, eq, lt, or, sql } from 'drizzle-orm';
import { accounts, groups, keys, logs, models as modelTable } from './tables';

type GatewayContext = Context<{ Bindings: RuntimeEnv }>;
function failure(message: string, status: number) {
  return Response.json({ error: { message, type: 'gateway_error', code: status } }, { status });
}

export async function authenticate(request: Request, store: Store) {
  const authorization = request.headers.get('authorization');
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : request.headers.get('x-api-key');
  if (!token) return null;
  return await store.db.select().from(keys).where(and(eq(keys.key_hash, await digest(token)), eq(keys.enabled, 1))).get() ?? null;
}

export async function allowedModels(key: KeyRow, store: Store) {
  const models = await store.db.select({ id: modelTable.id }).from(modelTable).where(eq(modelTable.enabled, 1)).orderBy(asc(modelTable.id)).all();
  if (!key.group_id) return models.map(row => row.id);
  const group = await store.db.select({ models: groups.models }).from(groups).where(eq(groups.id, key.group_id)).get();
  if (!group) return [];
  const allowed = new Set(array(JSON.parse(group.models)).filter(value => typeof value === 'string'));
  return models.filter(row => allowed.has(row.id)).map(row => row.id);
}

export async function modelsEndpoint(c: GatewayContext) {
  const store = storeFor(c.env);
  const key = await authenticate(c.req.raw, store);
  if (!key) return failure('API Key 无效', 401);
  const models = await allowedModels(key, store);
  return Response.json({ object: 'list', data: models.map(id => ({ id, object: 'model', created: 0, owned_by: 'workbuddy' })) });
}

export async function balanceEndpoint(c: GatewayContext) {
  const store = storeFor(c.env);
  const key = await authenticate(c.req.raw, store);
  if (!key) return failure('API Key 无效', 401);
  const rows = await store.db.select({ remain: sql<number>`COALESCE(SUM(${accounts.balance}), 0)`, total: sql<number>`COALESCE(SUM(${accounts.balance_total}), 0)` }).from(accounts).where(and(eq(accounts.enabled, 1), key.account_id ? eq(accounts.id, key.account_id) : undefined)).all();
  return Response.json({ ...rows[0], cached: true });
}

export async function gateway(c: GatewayContext, protocol: Protocol) {
  const store = storeFor(c.env);
  const key = await authenticate(c.req.raw, store);
  if (!key) return failure('API Key 无效', 401);
  let body: ReturnType<typeof toChat>;
  try {
    const input = object(await c.req.json());
    if (typeof input.model !== 'string' || !input.model.trim()) return failure('请指定 model', 400);
    if (input.stream !== undefined && typeof input.stream !== 'boolean') return failure('stream 必须是布尔值', 400);
    body = toChat(input, protocol);
  } catch (error) { return failure(error instanceof Error && !error.message.startsWith('Unexpected') ? error.message : '请求格式无效', 400); }
  if (!array(body.messages).length) return failure('对话消息不能为空', 400);
  const model = String(body.model);
  if (!(await allowedModels(key, store)).includes(model)) return failure('模型未启用或不在此 Key 的分组中，请在后台同步模型', 403);
  if (!await store.limit(`gateway:${key.id}`, 60, 60000)) return failure('请求过于频繁，请稍后重试', 429);
  let keyLease: { id: string; owner: string } | undefined;
  for (let slot = 0; slot < 4; slot++) {
    const id = `key:${key.id}:${slot}`, owner = await store.lease(id, 270000);
    if (owner) { keyLease = { id, owner }; break; }
  }
  if (!keyLease) return failure('此 Key 的并发请求已达上限', 429);
  let account: AccountRow | undefined, accountOwner: string | undefined;
  const started = Date.now();
  const usage: Usage = { input: 0, output: 0 };
  let completed = false, admitted = false;
  const abort = new AbortController();
  const cleanup = async (status: number) => {
    if (completed) return;
    completed = true;
    try {
      if (admitted && account) {
        await store.db.insert(logs).values({ id: crypto.randomUUID(), key_id: key.id, account_id: account.id, model, status, input_tokens: usage.input, output_tokens: usage.output, duration_ms: Date.now() - started, created_at: Date.now() }).run();
        await store.db.update(keys).set({ tokens: sql`${keys.tokens} + ${usage.input + usage.output}` }).where(eq(keys.id, key.id)).run();
      }
    } catch { console.error(JSON.stringify({ event: 'gateway_accounting_failed', status })); }
    finally {
      try { if (account && accountOwner) await store.release(`account:${account.id}`, accountOwner); }
      finally { await store.release(keyLease!.id, keyLease!.owner); }
    }
  };
  try {
    const candidates = await store.db.select().from(accounts).where(and(eq(accounts.enabled, 1), lt(accounts.cool_until, Date.now()), key.account_id ? eq(accounts.id, key.account_id) : undefined)).orderBy(asc(accounts.last_used_at)).limit(20).all();
    for (const candidate of candidates) {
      const owner = await store.lease(`account:${candidate.id}`, 270000);
      if (owner) { account = candidate; accountOwner = owner; break; }
    }
    if (!account) { await cleanup(503); return failure('没有可用账号，账号可能被禁用、冷却或正在使用', 503); }
    const quota = await store.db.update(keys).set({ requests: sql`${keys.requests} + 1` }).where(and(eq(keys.id, key.id), eq(keys.enabled, 1), or(eq(keys.request_limit, 0), lt(keys.requests, keys.request_limit)))).returning({ id: keys.id }).all();
    if (!quota.length) { await cleanup(429); return failure('此 Key 已停用或请求配额已用完', 429); }
    admitted = true;
    await store.db.update(accounts).set({ last_used_at: Date.now() }).where(eq(accounts.id, account.id)).run();
    const credential = await accountCredential(account, store, c.env);
    const response = await fetch(BACKEND + '/v2/chat/completions', {
      method: 'POST', headers: credentialHeaders(credential, c.env), body: JSON.stringify(body), redirect: 'manual',
      signal: AbortSignal.any([c.req.raw.signal, abort.signal, AbortSignal.timeout(250000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429 || response.status >= 500) await store.db.update(accounts).set({ cool_until: Date.now() + 60000 }).where(eq(accounts.id, account.id)).run();
      throw new UpstreamError(response.status);
    }
    if (!body.stream) {
      const result = object(await response.json());
      if (result.error || (result.code !== undefined && Number(result.code) !== 0)) throw new UpstreamError(502, Number(result.code) || undefined);
      if (!array(result.choices).length) throw new Error('上游没有返回对话结果');
      const observed = object(result.usage);
      usage.input = Number(observed.prompt_tokens || 0); usage.output = Number(observed.completion_tokens || 0);
      const output = fromChat(result, protocol);
      await cleanup(200);
      return Response.json(output);
    }
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel();
      throw new Error('上游没有返回有效的事件流');
    }
    const iterator = translateStream(response.body, protocol, model, usage);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) { await cleanup(200); controller.close(); }
          else controller.enqueue(encoder.encode(next.value));
        } catch {
          await cleanup(502);
          const error = { error: { type: 'upstream_error', message: '上游流中断，请重试' } };
          controller.enqueue(encoder.encode(protocol === 'chat' ? `data: ${JSON.stringify(error)}\n\n` : `event: error\ndata: ${JSON.stringify({ type: 'error', ...error })}\n\n`));
          controller.close();
        }
      },
      async cancel() {
        abort.abort();
        try { await iterator.return(); } catch { /* Upstream cancellation already interrupted its reader. */ }
        await cleanup(499);
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' } });
  } catch (error) {
    await cleanup(error instanceof UpstreamError ? error.status : 502);
    return failure(error instanceof UpstreamError ? error.message : '上游请求失败，请检查账号凭证或稍后重试', error instanceof UpstreamError && error.status !== 401 ? error.status : 502);
  }
}
