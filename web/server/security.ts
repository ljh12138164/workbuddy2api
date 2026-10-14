import type { RuntimeEnv, Credential } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export async function digest(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
}

export function assertConfigured(env: RuntimeEnv) {
  if ((env.ADMIN_JWT_SECRET?.length ?? 0) < 32 || (env.DATA_ENCRYPTION_KEY?.length ?? 0) < 32) {
    throw new Error('请设置至少 32 字符的会话签名密钥和凭证加密密钥');
  }
}

async function passwordBits(password: string, salt: Uint8Array<ArrayBuffer>) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256));
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$100000$${base64(salt)}$${base64(await passwordBits(password, salt))}`;
}

export async function verifyPassword(password: string, hash: string) {
  const [algorithm, iterations, salt, expected] = hash.split('$');
  if (algorithm !== 'pbkdf2-sha256' || iterations !== '100000' || !salt || !expected) return false;
  const actual = await passwordBits(password, Uint8Array.from(atob(salt), c => c.charCodeAt(0)));
  const saved = Uint8Array.from(atob(expected), c => c.charCodeAt(0));
  if (actual.length !== saved.length) return false;
  let different = 0;
  for (let index = 0; index < actual.length; index++) different |= actual[index] ^ saved[index];
  return different === 0;
}

export async function adminToken(env: RuntimeEnv, user: { username: string; version: number }) {
  return sign({ role: 'admin', sub: user.username, version: user.version, iss: 'workbuddy-web', exp: Math.floor(Date.now() / 1000) + 43200 }, env.ADMIN_JWT_SECRET!, 'HS256');
}

export async function sessionUser(request: Request, env: RuntimeEnv, store: Store) {
  const token = request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith('wb_session='))?.slice(11);
  if (!token) return null;
  try {
    const data = await verify(token, env.ADMIN_JWT_SECRET!, 'HS256');
    if (data.role !== 'admin' || data.iss !== 'workbuddy-web' || typeof data.sub !== 'string') return null;
    const user = await store.db.select({ username: admins.username, version: admins.version }).from(admins).where(eq(admins.username, data.sub)).get();
    return user && user.version === data.version ? user : null;
  } catch { return null; }
}

function base64(bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

async function encryptionKey(env: RuntimeEnv) {
  if ((env.DATA_ENCRYPTION_KEY?.length ?? 0) < 32) throw new Error('未配置凭证加密密钥');
  const raw = await crypto.subtle.digest('SHA-256', encoder.encode(env.DATA_ENCRYPTION_KEY!));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(value: unknown, env: RuntimeEnv) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, await encryptionKey(env), encoder.encode(JSON.stringify(value)));
  return `${base64(nonce)}.${base64(new Uint8Array(encrypted))}`;
}

export async function open<T>(value: string, env: RuntimeEnv): Promise<T> {
  const [nonce, encrypted] = value.split('.').map(x => Uint8Array.from(atob(x), ch => ch.charCodeAt(0)));
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await encryptionKey(env), encrypted);
  return JSON.parse(decoder.decode(raw)) as T;
}

export function parseCredential(raw: unknown): Credential {
  let value: unknown;
  try { value = typeof raw === 'string' ? JSON.parse(raw.replace(/^\uFEFF/, '')) : raw; }
  catch { throw new Error('凭证不是有效 JSON'); }
  if (!value || typeof value !== 'object') throw new Error('请导入完整凭证');
  if (JSON.stringify(value).includes('"$wbEncrypted"')) throw new Error('新版桌面加密凭证请先在桌面版导入后导出，或使用手机号登录');
  const credential = value as Credential;
  if (typeof credential.auth?.accessToken !== 'string' || !credential.auth.accessToken ||
      typeof credential.auth?.refreshToken !== 'string' || !credential.auth.refreshToken ||
      typeof credential.account?.uid !== 'string' || !/^[\w.@-]{6,120}$/.test(credential.account.uid)) {
    throw new Error('凭证缺少 accessToken、refreshToken 或有效 uid');
  }
  return credential;
}
import { sign, verify } from 'hono/jwt';
import { eq } from 'drizzle-orm';
import type { Store } from './store';
import { admins } from './tables';
