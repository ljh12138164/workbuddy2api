import { and, asc, eq, lt, or, sql } from 'drizzle-orm';
import { accounts, keys, leases, logs } from './tables.js';
import { accountCredential, credentialHeaders } from './upstream.js';
import type { Store } from './store';
import type { AccountRow, KeyRow, RuntimeEnv } from './types';
import type { Usage } from './protocols';

export class GatewayRejection extends Error {
  constructor(message: string, public status: number) { super(message); }
}

// Owns admission and settlement; callers never manage lease owners or quota state.
export class GatewayRequest {
  readonly usage: Usage = { input: 0, output: 0 };
  private keyLease?: { id: string; owner: string };
  private account?: AccountRow;
  private accountOwner?: string;
  private admitted = false;
  private settlement?: Promise<void>;
  private started = Date.now();

  private constructor(private store: Store, private key: KeyRow, private model: string) {}

  static async start(store: Store, key: KeyRow, model: string) {
    const request = new GatewayRequest(store, key, model);
    try { await request.admit(); return request; }
    catch (error) {
      await request.finish(error instanceof GatewayRejection ? error.status : 502);
      throw error;
    }
  }

  private async admit() {
    const { store, key } = this;
    if (!await store.limit(`gateway:${key.id}`, 60, 60000)) throw new GatewayRejection('请求过于频繁，请稍后重试', 429);
    for (let slot = 0; slot < 4; slot++) {
      const id = `key:${key.id}:${slot}`, owner = await store.lease(id, 270000);
      if (owner) { this.keyLease = { id, owner }; break; }
    }
    if (!this.keyLease) throw new GatewayRejection('此 Key 的并发请求已达上限', 429);
    const candidates = await store.db.select().from(accounts).where(and(eq(accounts.enabled, 1), lt(accounts.cool_until, Date.now()), key.account_id ? eq(accounts.id, key.account_id) : undefined)).orderBy(asc(accounts.last_used_at)).limit(20).all();
    for (const candidate of candidates) {
      const owner = await store.lease(`account:${candidate.id}`, 270000);
      if (owner) { this.account = candidate; this.accountOwner = owner; break; }
    }
    if (!this.account) throw new GatewayRejection('没有可用账号，账号可能被禁用、冷却或正在使用', 503);
    const quota = await store.db.update(keys).set({ requests: sql`${keys.requests} + 1` }).where(and(eq(keys.id, key.id), eq(keys.enabled, 1), or(eq(keys.request_limit, 0), lt(keys.requests, keys.request_limit)))).returning({ id: keys.id }).all();
    if (!quota.length) throw new GatewayRejection('此 Key 已停用或请求配额已用完', 429);
    this.admitted = true;
    await store.db.update(accounts).set({ last_used_at: Date.now() }).where(eq(accounts.id, this.account.id)).run();
  }

  async headers(env: RuntimeEnv) {
    return credentialHeaders(await accountCredential(this.account!, this.store, env), env);
  }

  async upstreamFailed(status: number) {
    if (status === 429 || status >= 500) await this.store.db.update(accounts).set({ cool_until: Date.now() + 60000 }).where(eq(accounts.id, this.account!.id)).run();
  }

  finish(status: number) {
    // Concurrent completion/cancellation must await the same settlement.
    return this.settlement ??= this.settle(status);
  }

  private async settle(status: number) {
    const { store, key, account } = this;
    try {
      if (this.admitted && account) {
        const results = await Promise.allSettled([
          store.db.insert(logs).values({ id: crypto.randomUUID(), key_id: key.id, account_id: account.id, model: this.model, status, input_tokens: this.usage.input, output_tokens: this.usage.output, duration_ms: Date.now() - this.started, created_at: Date.now() }).run(),
          store.db.update(keys).set({ tokens: sql`${keys.tokens} + ${this.usage.input + this.usage.output}` }).where(eq(keys.id, key.id)).run(),
        ]);
        if (results.some(result => result.status === 'rejected')) console.error(JSON.stringify({ event: 'gateway_accounting_failed', status }));
      }
    } finally {
      if (this.keyLease) await store.db.delete(leases).where(or(
        and(eq(leases.id, this.keyLease.id), eq(leases.owner, this.keyLease.owner)),
        account && this.accountOwner ? and(eq(leases.id, `account:${account.id}`), eq(leases.owner, this.accountOwner)) : undefined,
      )).run();
    }
  }
}
