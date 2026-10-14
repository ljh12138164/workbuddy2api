import { app } from './app';
import type { RuntimeEnv } from './types';

export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/') || path.startsWith('/v1/') || path === '/health') return app.fetch(request, env, ctx);
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('请先构建管理页面', { status: 503 });
  },
} satisfies ExportedHandler<RuntimeEnv>;
