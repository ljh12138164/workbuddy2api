import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter, createContext } from './router.js';
import { balanceEndpoint, gateway, modelsEndpoint } from './gateway.js';
import type { RuntimeEnv } from './types';
import { z } from 'zod';
import { automateAccount } from './growth.js';
import { storeFor } from './store.js';
import { GrowthError } from './growth-actions.js';
import { UpstreamError } from './upstream.js';

export const app = new Hono<{ Bindings: RuntimeEnv }>();
app.use('*', secureHeaders({ referrerPolicy: 'no-referrer', xFrameOptions: 'DENY' }));
app.use('*', bodyLimit({ maxSize: 4 * 1024 * 1024, onError: c => c.json({ error: '请求体过大' }, 413) }));
app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  const origin = c.req.header('Origin');
  // Management mutations require same-origin browser requests.
  if (c.req.method !== 'GET' && origin !== new URL(c.req.url).origin) return c.json({ error: '请从本站页面执行管理操作' }, 403);
  if (c.req.method === 'GET' && origin && origin !== new URL(c.req.url).origin) return c.json({ error: '不允许跨站管理请求' }, 403);
  await next();
});
app.use('/v1/*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
app.use('/v1/*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Authorization', 'Content-Type', 'x-api-key', 'anthropic-version', 'anthropic-beta'] }));
app.all('/api/trpc/*', c => fetchRequestHandler({
  endpoint: '/api/trpc', req: c.req.raw, router: appRouter,
  createContext: ({ resHeaders }) => createContext(c.req.raw, c.env, resHeaders),
}));
app.get('/v1/models', modelsEndpoint);
app.get('/v1/balance', balanceEndpoint);
// Public automation routes intentionally require neither a management session nor an API key.
for (const [path, refreshOnly] of [['/v1/growth/run', false], ['/v1/credentials/refresh', true]] as const) {
  app.post(path, async c => {
    const input = z.object({ accountId: z.string().uuid() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: '请提供有效的 accountId（UUID）' }, 400);
    const store = storeFor(c.env);
    await store.initialize();
    try {
      const result = await automateAccount(input.data.accountId, store, c.env, c.req.raw.signal, refreshOnly);
      return c.json(result.body, result.status);
    } catch (error) {
      return c.json({ error: error instanceof GrowthError || error instanceof UpstreamError ? error.message : '账号操作失败，请检查凭证或稍后重试' }, 502);
    }
  });
}
app.post('/v1/chat/completions', c => gateway(c, 'chat'));
app.post('/v1/responses', c => gateway(c, 'responses'));
app.post('/v1/messages', c => gateway(c, 'anthropic'));
app.get('/health', c => c.json({ ok: true, service: 'workbuddy-web' }));
app.notFound(c => c.json({ error: '接口不存在' }, 404));
app.onError(() => Response.json({ error: '请求失败，请检查部署配置或稍后重试' }, { status: 500 }));
