import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';
import { and, asc, desc, eq, getTableColumns, lt, or, sql } from 'drizzle-orm';
import { accounts, admins, groups, keys, logs, models } from './tables';
import { storeFor, type Store } from './store';
import { adminToken, assertConfigured, digest, hashPassword, open, parseCredential, sessionUser, verifyPassword } from './security';
import { accountCredential, array, fetchJson, importAccount, object, syncAccount, syncModels } from './upstream';
import { startPhone, sendPhone, verifyPhone } from './phone-login';
import type { RuntimeEnv, Credential } from './types';

export interface Context { env: RuntimeEnv; store: Store; admin: boolean; user?: { username: string; version: number } | null; request: Request; headers: Headers }
export async function createContext(request: Request, env: RuntimeEnv, headers: Headers): Promise<Context> {
  assertConfigured(env);
  const store = storeFor(env);
  await store.initialize();
  const user = await sessionUser(request, env, store);
  return { env, store, user, admin: Boolean(user), request, headers };
}

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    return { ...shape, message: error.code === 'INTERNAL_SERVER_ERROR' ? '请求失败，请检查部署配置、账号状态或稍后重试' : shape.message };
  },
});
const managementProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.admin) throw new TRPCError({ code: 'UNAUTHORIZED', message: '请先登录管理后台' });
  return next();
});
const idInput = z.object({ id: z.string().uuid() });
const keyInput = z.object({ name: z.string().trim().min(1).max(120), requestLimit: z.number().int().min(0).max(100000000).default(0), accountId: z.string().uuid().nullable().default(null), groupId: z.string().uuid().nullable().default(null) });

function cookie(token: string, request: Request, remove = false) {
  return `wb_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${remove ? 0 : 43200}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}

async function account(id: string, store: Store) {
  const row = await store.db.select().from(accounts).where(eq(accounts.id, id)).get();
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: '账号不存在' });
  return row;
}

export const appRouter = t.router({
  auth: t.router({
    login: t.procedure.input(z.object({ username: z.string().max(120), password: z.string().max(256) })).mutation(async ({ ctx, input }) => {
      if (!await ctx.store.limit('admin-login', 10, 300000)) throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: '登录尝试过多，请五分钟后重试' });
      const user = await ctx.store.db.select().from(admins).where(eq(admins.username, 'admin')).get();
      const correctPassword = user && await verifyPassword(input.password, user.password_hash);
      if (!user || input.username !== user.username || !correctPassword) throw new TRPCError({ code: 'UNAUTHORIZED', message: '用户名或密码错误' });
      ctx.headers.append('Set-Cookie', cookie(await adminToken(ctx.env, user), ctx.request));
      return { username: user.username };
    }),
    me: managementProcedure.query(({ ctx }) => ({ username: ctx.user?.username ?? 'admin' })),
    changePassword: managementProcedure.input(z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(8, '新密码至少 8 个字符').max(256) }).refine(input => input.currentPassword !== input.newPassword, { message: '新密码不能与当前密码相同', path: ['newPassword'] })).mutation(async ({ ctx, input }) => {
      const username = ctx.user?.username ?? 'admin';
      if (!await ctx.store.limit(`password-change:${username}`, 5, 300000)) throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: '密码验证过于频繁，请五分钟后重试' });
      const user = await ctx.store.db.select().from(admins).where(eq(admins.username, username)).get();
      if (!user || !await verifyPassword(input.currentPassword, user.password_hash)) throw new TRPCError({ code: 'BAD_REQUEST', message: '当前密码错误' });
      const changed = await ctx.store.db.update(admins).set({ password_hash: await hashPassword(input.newPassword), version: sql`${admins.version} + 1` }).where(and(eq(admins.username, username), eq(admins.password_hash, user.password_hash), eq(admins.version, user.version))).returning({ username: admins.username }).all();
      if (!changed.length) throw new TRPCError({ code: 'CONFLICT', message: '密码已发生变化，请重新登录后重试' });
      ctx.headers.append('Set-Cookie', cookie('', ctx.request, true));
      return { ok: true };
    }),
    logout: t.procedure.mutation(({ ctx }) => { ctx.headers.append('Set-Cookie', cookie('', ctx.request, true)); return { ok: true }; }),
  }),
  accounts: t.router({
    list: managementProcedure.query(({ ctx }) => {
      const { credential, ...columns } = getTableColumns(accounts);
      void credential;
      return ctx.store.db.select(columns).from(accounts).orderBy(asc(accounts.name)).all();
    }),
    import: managementProcedure.input(z.object({ name: z.string().max(120).default(''), credential: z.string().max(1000000) })).mutation(async ({ ctx, input }) => {
      let parsed: unknown;
      try { parsed = JSON.parse(input.credential.replace(/^\uFEFF/, '')); } catch { throw new TRPCError({ code: 'BAD_REQUEST', message: '凭证不是有效 JSON' }); }
      const items = Array.isArray(parsed) ? parsed : Array.isArray(object(parsed).items) ? array(object(parsed).items) : [parsed];
      if (!items.length || items.length > 50) throw new TRPCError({ code: 'BAD_REQUEST', message: '每次请导入 1–50 个账号' });
      const results: { uid?: string; id?: string; error?: string }[] = [];
      for (const value of items) {
        try { results.push(await importAccount(parseCredential(value), input.name, ctx.store, ctx.env)); }
        catch (error) { results.push({ error: error instanceof Error ? error.message : '账号导入失败' }); }
      }
      return { results };
    }),
    export: managementProcedure.input(z.object({ ids: z.array(z.string().uuid()).max(50).default([]) })).mutation(async ({ ctx, input }) => {
      const rows = await ctx.store.db.select().from(accounts).orderBy(asc(accounts.name)).all();
      const selected = input.ids.length ? rows.filter(row => input.ids.includes(row.id)) : rows;
      return { items: await Promise.all(selected.map(row => open<Credential>(row.credential, ctx.env).then(value => JSON.stringify(value)))) };
    }),
    update: managementProcedure.input(idInput.extend({ name: z.string().max(120), enabled: z.boolean() })).mutation(async ({ ctx, input }) => {
      await account(input.id, ctx.store);
      await ctx.store.db.update(accounts).set({ name: input.name, enabled: Number(input.enabled) }).where(eq(accounts.id, input.id)).run();
      return { ok: true };
    }),
    remove: managementProcedure.input(idInput).mutation(async ({ ctx, input }) => {
      // Bound keys remain bound to a missing account and cannot expand to the pool.
      await ctx.store.db.delete(accounts).where(eq(accounts.id, input.id)).run();
      return { ok: true };
    }),
    sync: managementProcedure.input(idInput).mutation(async ({ ctx, input }) => syncAccount(await account(input.id, ctx.store), ctx.store, ctx.env)),
    refresh: managementProcedure.input(idInput).mutation(async ({ ctx, input }) => {
      await accountCredential(await account(input.id, ctx.store), ctx.store, ctx.env, true);
      return { ok: true };
    }),
  }),
  phone: t.router({
    start: managementProcedure.mutation(async ({ ctx }) => {
      if (!await ctx.store.limit('phone-start', 10, 60000)) throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: '登录请求过多，请稍后重试' });
      return startPhone(ctx.store, ctx.env);
    }),
    send: managementProcedure.input(idInput.extend({ mobile: z.string().max(30) })).mutation(({ ctx, input }) => sendPhone(input.id, input.mobile, ctx.store, ctx.env)),
    verify: managementProcedure.input(idInput.extend({ code: z.string().regex(/^\d{4,8}$/) })).mutation(({ ctx, input }) => verifyPhone(input.id, input.code, ctx.store, ctx.env)),
  }),
  keys: t.router({
    list: managementProcedure.query(({ ctx }) => {
      const { key_hash, ...columns } = getTableColumns(keys);
      void key_hash;
      return ctx.store.db.select(columns).from(keys).orderBy(desc(keys.created_at)).all();
    }),
    create: managementProcedure.input(keyInput).mutation(async ({ ctx, input }) => {
      if (input.accountId) await account(input.accountId, ctx.store);
      if (input.groupId && !await ctx.store.db.select({ id: groups.id }).from(groups).where(eq(groups.id, input.groupId)).get()) throw new TRPCError({ code: 'BAD_REQUEST', message: '模型分组不存在' });
      const key = 'sk-wb-' + Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join('');
      const id = crypto.randomUUID();
      await ctx.store.db.insert(keys).values({ id, name: input.name, key_hash: await digest(key), prefix: key.slice(0, 14), request_limit: input.requestLimit, account_id: input.accountId, group_id: input.groupId, created_at: Date.now() }).run();
      return { id, key };
    }),
    update: managementProcedure.input(idInput.extend({ enabled: z.boolean(), requestLimit: z.number().int().min(0).max(100000000) })).mutation(async ({ ctx, input }) => {
      await ctx.store.db.update(keys).set({ enabled: Number(input.enabled), request_limit: input.requestLimit }).where(eq(keys.id, input.id)).run(); return { ok: true };
    }),
    remove: managementProcedure.input(idInput).mutation(async ({ ctx, input }) => { await ctx.store.db.delete(keys).where(eq(keys.id, input.id)).run(); return { ok: true }; }),
  }),
  models: t.router({
    list: managementProcedure.query(({ ctx }) => ctx.store.db.select().from(models).orderBy(asc(models.id)).all()),
    sync: managementProcedure.input(idInput).mutation(async ({ ctx, input }) => syncModels(await account(input.id, ctx.store), ctx.store, ctx.env)),
    toggle: managementProcedure.input(z.object({ id: z.string().min(1).max(120), enabled: z.boolean() })).mutation(async ({ ctx, input }) => { await ctx.store.db.update(models).set({ enabled: Number(input.enabled) }).where(eq(models.id, input.id)).run(); return { ok: true }; }),
  }),
  groups: t.router({
    list: managementProcedure.query(({ ctx }) => ctx.store.db.select().from(groups).orderBy(asc(groups.name)).all()),
    save: managementProcedure.input(z.object({ id: z.string().uuid().optional(), name: z.string().trim().min(1).max(120), models: z.array(z.string().max(120)).max(200) })).mutation(async ({ ctx, input }) => {
      const id = input.id || crypto.randomUUID();
      await ctx.store.db.insert(groups).values({ id, name: input.name, models: JSON.stringify(input.models) }).onConflictDoUpdate({ target: groups.id, set: { name: input.name, models: JSON.stringify(input.models) } }).run(); return { id };
    }),
    remove: managementProcedure.input(idInput).mutation(async ({ ctx, input }) => { await ctx.store.db.delete(groups).where(eq(groups.id, input.id)).run(); return { ok: true }; }),
  }),
  logs: t.router({
    list: managementProcedure.input(z.object({ before: z.number().optional(), beforeId: z.string().uuid().optional(), keyId: z.string().uuid().optional() }).default({})).query(({ ctx, input }) => {
      const before = input.before ?? Date.now() + 1;
      return ctx.store.db.select().from(logs).where(and(or(lt(logs.created_at, before), and(eq(logs.created_at, before), lt(logs.id, input.beforeId ?? ''))), input.keyId ? eq(logs.key_id, input.keyId) : undefined)).orderBy(desc(logs.created_at), desc(logs.id)).limit(100).all();
    }),
  }),
  stats: managementProcedure.query(async ({ ctx }) => {
    const rows = await ctx.store.db.select({ requests: sql<number>`COUNT(*)`, tokens: sql<number>`COALESCE(SUM(${logs.input_tokens} + ${logs.output_tokens}), 0)`, failed: sql<number>`COALESCE(SUM(CASE WHEN ${logs.status} >= 400 THEN 1 ELSE 0 END), 0)` }).from(logs).all();
    return { requests: Number(rows[0].requests), tokens: Number(rows[0].tokens), failed: Number(rows[0].failed) };
  }),
  growth: t.router({
    list: managementProcedure.input(idInput).query(async ({ ctx, input }) => {
      const credential = await accountCredential(await account(input.id, ctx.store), ctx.store, ctx.env);
      return object((await fetchJson('/v2/activity/growth/tasks', credential, ctx.env)).data);
    }),
    accept: managementProcedure.input(idInput.extend({ codes: z.array(z.string().regex(/^[\w-]+$/)).min(1).max(30) })).mutation(async ({ ctx, input }) => {
      const credential = await accountCredential(await account(input.id, ctx.store), ctx.store, ctx.env);
      return object((await fetchJson('/v2/activity/growth/tasks/accept', credential, ctx.env, { task_codes: input.codes })).data);
    }),
    claim: managementProcedure.input(idInput.extend({ code: z.string().regex(/^[\w-]+$/) })).mutation(async ({ ctx, input }) => {
      const credential = await accountCredential(await account(input.id, ctx.store), ctx.store, ctx.env);
      return object((await fetchJson(`/activity/growth/tasks/${encodeURIComponent(input.code)}/claim`, credential, ctx.env, {})).data);
    }),
  }),
});

export type AppRouter = typeof appRouter;
