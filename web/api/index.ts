import { app } from '../server/app';
import type { RuntimeEnv } from '../server/types';

export const config = { maxDuration: 300 };
export default { fetch(request: Request) {
  const url = new URL(request.url);
  const path = url.searchParams.get('__wb_path');
  if (path) { url.pathname = path; url.searchParams.delete('__wb_path'); }
  const env: RuntimeEnv = {
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    D1_DATABASE_ID: process.env.D1_DATABASE_ID,
    D1_API_TOKEN: process.env.D1_API_TOKEN,
    ADMIN_JWT_SECRET: process.env.ADMIN_JWT_SECRET,
    DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY,
    WORKBUDDY_DEVICE_TOKEN: process.env.WORKBUDDY_DEVICE_TOKEN,
  };
  return app.fetch(new Request(url, request), env);
} };
