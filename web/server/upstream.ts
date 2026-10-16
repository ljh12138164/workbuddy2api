import { open, seal, parseCredential } from './security.js';
import type { AccountRow, Credential, RuntimeEnv } from './types';
import type { Store } from './store';
import { eq } from 'drizzle-orm';
import { accounts, models } from './tables.js';

export type ObjectValue = Record<string, unknown>;
export const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const BACKEND = 'https://copilot.tencent.com';

export class UpstreamError extends Error {
  constructor(public status: number, public code?: number) {
    super(code ? `上游返回业务码 ${code}` : `上游请求失败（HTTP ${status}）`);
  }
}

export function credentialHeaders(credential: Credential, env: RuntimeEnv) {
  const enterprise = credential.account.enterpriseId ?? '';
  const headers = new Headers({
    'Content-Type': 'application/json', Accept: 'application/json',
    Authorization: `Bearer ${credential.auth.accessToken}`,
    'X-User-Id': credential.account.uid, 'X-Enterprise-Id': enterprise,
    'X-Tenant-Id': enterprise, 'X-Domain': credential.auth.domain ?? 'www.codebuddy.cn',
  });
  if (env.WORKBUDDY_DEVICE_TOKEN) headers.set('X-Device-Token', env.WORKBUDDY_DEVICE_TOKEN);
  return headers;
}

export async function fetchJson(path: string, credential: Credential, env: RuntimeEnv, body?: unknown) {
  const response = await fetch(BACKEND + path, {
    method: body === undefined ? 'GET' : 'POST', headers: credentialHeaders(credential, env),
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000), redirect: 'manual',
  });
  if (!response.ok) { await response.body?.cancel(); throw new UpstreamError(response.status); }
  let result: ObjectValue;
  try { result = object(await response.json()); }
  catch { throw new UpstreamError(502); }
  if (result.code !== undefined && Number(result.code) !== 0) throw new UpstreamError(502, Number(result.code));
  return result;
}

function expiration(credential: Credential) {
  if (credential.auth.expiresAt) return credential.auth.expiresAt;
  try {
    const payload = credential.auth.accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return Number(object(JSON.parse(atob(payload))).exp) * 1000;
  } catch { return 0; }
}

export async function refreshCredential(credential: Credential, env: RuntimeEnv) {
  const headers = credentialHeaders(credential, env);
  headers.set('X-Refresh-Token', credential.auth.refreshToken);
  headers.set('X-Auth-Refresh-Source', 'plugin');
  const response = await fetch(BACKEND + '/v2/plugin/auth/token/refresh', {
    method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(20000), redirect: 'manual',
  });
  if (!response.ok) { await response.body?.cancel(); throw new UpstreamError(response.status); }
  const result = object(await response.json());
  const auth = object(result.data);
  if (Number(result.code) !== 0 || typeof auth.accessToken !== 'string' || !auth.accessToken) throw new Error('凭证刷新失败，请重新登录账号');
  return { ...credential, auth: { ...credential.auth, ...auth, accessToken: auth.accessToken,
    expiresAt: Number(auth.expiresAt) || Date.now() + Number(auth.expiresIn || 3600) * 1000,
  } } satisfies Credential;
}

export async function accountCredential(account: AccountRow, store: Store, env: RuntimeEnv, force = false, validFor = 60000) {
  let credential = await open<Credential>(account.credential, env);
  const expires = expiration(credential);
  if (!force && (!expires || expires > Date.now() + validFor)) return credential;
  const leaseId = `refresh:${account.id}`;
  const owner = await store.lease(leaseId, 30000);
  if (!owner) throw new Error('账号正在刷新凭证，请稍后重试');
  try {
    const fresh = await store.db.select().from(accounts).where(eq(accounts.id, account.id)).get();
    if (!fresh) throw new Error('账号已删除');
    credential = await open<Credential>(fresh.credential, env);
    if (fresh.credential !== account.credential && expiration(credential) > Date.now() + validFor) return credential;
    credential = await refreshCredential(credential, env);
    const encrypted = await seal(credential, env);
    await store.db.update(accounts).set({ credential: encrypted, updated_at: Date.now() }).where(eq(accounts.id, account.id)).run();
    account.credential = encrypted;
    return credential;
  } finally { await store.release(leaseId, owner); }
}

export async function importAccount(raw: unknown, name: string, store: Store, env: RuntimeEnv) {
  const credential = parseCredential(raw);
  const result = await fetchJson('/v2/plugin/accounts', credential, env);
  const profile = object(array(object(result.data).accounts).find(value => object(value).uid === credential.account.uid));
  if (!profile.uid) throw new Error('上游账号与凭证 uid 不匹配，请重新导出凭证');
  credential.account = { ...credential.account, ...profile, uid: String(profile.uid) };
  const encrypted = await seal(credential, env);
  const id = crypto.randomUUID();
  const values = { id, uid: credential.account.uid, name: name || credential.account.nickname || credential.account.uid, credential: encrypted, updated_at: Date.now() };
  const rows = await store.db.insert(accounts).values(values).onConflictDoUpdate({ target: accounts.uid, set: { name: values.name, credential: encrypted, updated_at: values.updated_at } }).returning({ id: accounts.id }).all();
  return { id: rows[0].id, uid: credential.account.uid };
}

export async function syncAccount(account: AccountRow, store: Store, env: RuntimeEnv) {
  const credential = await accountCredential(account, store, env);
  const result = await fetchJson('/v2/billing/meter/get-user-resource', credential, env, {});
  const data = object(object(object(result.data).Response).Data);
  const packages = array(data.Accounts).map(object).filter(row => row.CapacityUnit === 'credits');
  const remain = packages.reduce((sum, row) => sum + Number(row.CycleCapacityRemainPrecise ?? row.CycleCapacityRemain ?? 0), 0);
  const total = packages.reduce((sum, row) => sum + Number(row.CapacitySize ?? 0), 0);
  await store.db.update(accounts).set({ balance: remain, balance_total: total, credits: JSON.stringify(packages), updated_at: Date.now() }).where(eq(accounts.id, account.id)).run();
  return { balance: remain, total, packages };
}

export async function syncModels(account: AccountRow, store: Store, env: RuntimeEnv) {
  const credential = await accountCredential(account, store, env);
  const enterprise = credential.account.type === 'personal' ? 'personal' : credential.account.enterpriseId || 'personal';
  const result = await fetchJson(`/v2/enterprises/${encodeURIComponent(enterprise)}/models`, credential, env);
  const data = object(result.data);
  const rows = array(data.models).length ? array(data.models) : array(data.agents).flatMap(value => array(object(value).models));
  const seen = new Set<string>();
  for (const value of rows) {
    const model = typeof value === 'string' ? { id: value } : object(value);
    if (typeof model.id !== 'string' || seen.has(model.id)) continue;
    seen.add(model.id);
    await store.db.insert(models).values({ id: model.id, detail: JSON.stringify(model) }).onConflictDoUpdate({ target: models.id, set: { detail: JSON.stringify(model) } }).run();
  }
  if (!seen.size) throw new Error('上游没有返回可用模型');
  return { count: seen.size };
}
