import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../server/router';
export const rpc = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: '/api/trpc', fetch: (url, options) => fetch(url, { ...options, credentials: 'same-origin' }) })],
});
export type Outputs = inferRouterOutputs<AppRouter>;
export interface Data {
  accounts: Outputs['accounts']['list']; keys: Outputs['keys']['list'];
  models: Outputs['models']['list']; groups: Outputs['groups']['list']; stats: Outputs['stats'];
}
export type Run = <T>(operation: () => Promise<T>, message?: string) => Promise<T | undefined>;
