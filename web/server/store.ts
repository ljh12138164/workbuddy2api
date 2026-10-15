import { and, eq, lt, sql } from 'drizzle-orm';
import { drizzle as d1Drizzle } from 'drizzle-orm/d1';
import { drizzle as proxyDrizzle } from 'drizzle-orm/sqlite-proxy';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type { RuntimeEnv } from './types';
import { schema } from './schema.js';
import * as tables from './tables.js';
import { hashPassword } from './security.js';

export class Store {
  private initialization?: Promise<void>;
  private limitsCleanupAt = 0;

  constructor(public db: BaseSQLiteDatabase<'async', unknown, typeof tables>) {}

  initialize() {
    return this.initialization ??= this.initializeSchema().catch(error => {
      this.initialization = undefined;
      throw error;
    });
  }

  private async initializeSchema() {
    // DDL only: CRUD uses Drizzle's typed query builders.
    for (const statement of schema) await this.db.run(sql.raw(statement));
    if (!(await this.db.select().from(tables.admins).where(eq(tables.admins.username, 'admin')).all()).length) {
      await this.db.insert(tables.admins).values({ username: 'admin', password_hash: await hashPassword('admin123'), created_at: Date.now() }).onConflictDoNothing().run();
    }
  }

  async lease(id: string, milliseconds: number) {
    const owner = crypto.randomUUID(), now = Date.now();
    const rows = await this.db.insert(tables.leases).values({ id, owner, until_at: now + milliseconds }).onConflictDoUpdate({
      target: tables.leases.id, set: { owner, until_at: now + milliseconds }, setWhere: lt(tables.leases.until_at, now),
    }).returning({ owner: tables.leases.owner }).all();
    return rows[0]?.owner === owner ? owner : null;
  }

  async release(id: string, owner: string) {
    await this.db.delete(tables.leases).where(and(eq(tables.leases.id, id), eq(tables.leases.owner, owner))).run();
  }

  async limit(id: string, maximum: number, windowMs: number) {
    const now = Date.now(), bucket = `${id}:${Math.floor(now / windowMs)}`;
    const result = await this.db.insert(tables.limits).values({ id: bucket, count: 1, expires_at: now + windowMs }).onConflictDoUpdate({
      target: tables.limits.id, set: { count: sql`${tables.limits.count} + 1` }, setWhere: lt(tables.limits.count, maximum),
    }).returning({ count: tables.limits.count }).all();
    // Expired buckets cannot affect admission; prune once a minute per instance.
    if (now >= this.limitsCleanupAt) {
      this.limitsCleanupAt = now + 60000;
      try { await this.db.delete(tables.limits).where(lt(tables.limits.expires_at, now)).run(); }
      catch (error) { this.limitsCleanupAt = 0; throw error; }
    }
    return result.length !== 0;
  }
}

const boundStores = new WeakMap<D1Database, Store>();
let httpStore: { account: string; database: string; token: string; store: Store } | undefined;

export function storeFor(env: RuntimeEnv): Store {
  if (env.DB) {
    let store = boundStores.get(env.DB);
    if (!store) { store = new Store(d1Drizzle(env.DB, { schema: tables })); boundStores.set(env.DB, store); }
    return store;
  }
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.D1_DATABASE_ID || !env.D1_API_TOKEN) throw new Error('请配置 D1 绑定或 D1 服务端访问凭证');
  const account = env.CLOUDFLARE_ACCOUNT_ID, database = env.D1_DATABASE_ID, token = env.D1_API_TOKEN;
  if (httpStore?.account === account && httpStore.database === database && httpStore.token === token) return httpStore.store;
  const store = new Store(proxyDrizzle(async (statement, params, method) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/d1/database/${encodeURIComponent(database)}/raw`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: statement, params }), redirect: 'manual', signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error('D1 数据库请求失败');
    const payload = await response.json() as { success: boolean; result?: { success: boolean; results?: { rows?: unknown[][] } }[] };
    const result = payload.result?.[0];
    if (!payload.success || !result?.success) throw new Error('D1 数据库查询失败');
    const rows = result.results?.rows ?? [];
    return { rows: method === 'get' ? rows[0] : rows };
  }, { schema: tables }));
  httpStore = { account, database, token, store };
  return store;
}
