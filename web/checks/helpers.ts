import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import * as tables from '../server/tables';
import { Store } from '../server/store';
import type { Credential, RuntimeEnv } from '../server/types';

export const env: RuntimeEnv = {
  ADMIN_JWT_SECRET: 'test-session-secret-01234567890123456789',
  DATA_ENCRYPTION_KEY: 'test-encryption-key-01234567890123456789',
};
export const credential: Credential = {
  auth: { accessToken: 'test-upstream-access', refreshToken: 'test-upstream-refresh', expiresAt: Date.now() + 3600000 },
  account: { uid: 'test-user-0001', nickname: '测试账号', type: 'personal' },
};
export function memoryStore() {
  const database = new DatabaseSync(':memory:');
  const store = new Store(drizzle(async (sql, args, method) => {
    const statement = database.prepare(sql);
    if (!statement.columns().length) { statement.run(...args); return { rows: [] }; }
    statement.setReturnArrays(true);
    const rows = statement.all(...args).map(row => Array.isArray(row) ? row : Object.values(row));
    return { rows: method === 'get' ? rows[0] : rows };
  }, { schema: tables }));
  return { store, close: () => database.close() };
}
export function eventBody(values: unknown[], fragmentSize = 7) {
  const bytes = new TextEncoder().encode(values.map(value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\r\n\r\n`).join(''));
  let position = 0;
  return new ReadableStream<Uint8Array>({ pull(controller) {
    if (position >= bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(position, position += fragmentSize));
  } });
}
