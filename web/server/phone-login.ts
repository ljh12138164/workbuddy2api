import { CookieJar, type SerializedCookieJar } from 'tough-cookie';
import { open, seal } from './security';
import { importAccount, object, array, type ObjectValue } from './upstream';
import type { Store } from './store';
import type { Credential, RuntimeEnv } from './types';
import { and, eq, gt, lt } from 'drizzle-orm';
import { loginSessions } from './tables';

const HOST = 'https://www.workbuddy.cn';
const OAUTH = 'https://oauth2.account.tencent.com';
interface LoginState {
  cookies: SerializedCookieJar;
  state: string;
  oneidState: string;
  keycloakUrl: string;
  smsToken?: string;
  mobile?: string;
  sentAt?: number;
  consumed?: boolean;
  result?: { id: string; uid: string };
}

function allowed(url: string) {
  const parsed = new URL(url);
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password && (!parsed.port || parsed.port === '443') &&
    ['workbuddy.cn', 'codebuddy.cn', 'tencent.com'].some(domain => parsed.hostname === domain || parsed.hostname.endsWith('.' + domain));
}

class LoginHttp {
  constructor(public jar: CookieJar) {}

  async request(url: string, body?: unknown, extra: Record<string, string> = {}) {
    if (!allowed(url)) throw new Error('上游登录跳转地址不受信任');
    const headers = new Headers({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      Origin: HOST, Referer: HOST + '/', Accept: 'application/json,text/html,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9', ...extra,
    });
    const cookie = await this.jar.getCookieString(url);
    if (cookie) headers.set('Cookie', cookie);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers,
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(10000) });
    for (const value of response.headers.getSetCookie()) await this.jar.setCookie(value, url, { ignoreError: true });
    if (response.status >= 400) { await response.body?.cancel(); throw new Error(`上游登录失败（HTTP ${response.status}）`); }
    return response;
  }

  async follow(url: string) {
    for (let hop = 0; hop < 12; hop++) {
      const response = await this.request(url);
      const location = response.headers.get('location');
      if (!location || ![301, 302, 303, 307, 308].includes(response.status)) return response;
      const next = new URL(location, url).href;
      await response.body?.cancel();
      if (!allowed(next)) throw new Error('请使用浏览器完成官方授权，当前跳转需要客户端');
      url = next;
    }
    throw new Error('登录跳转次数过多');
  }
}

async function json(response: Response): Promise<ObjectValue> {
  const result = object(await response.json());
  if (result.errCode || (typeof result.code === 'number' && result.code !== 0)) throw new Error('上游拒绝本次授权，请检查验证码或稍后重试');
  return result;
}

export async function startPhone(store: Store, env: RuntimeEnv) {
  const http = new LoginHttp(new CookieJar());
  const result = object((await json(await http.request(HOST + '/v2/plugin/auth/state?platform=workbuddy', {}, { 'X-Requested-With': 'XMLHttpRequest' }))).data);
  if (typeof result.state !== 'string' || !result.state) throw new Error('上游未返回授权 state');
  const consoleUrl = `${HOST}/console/auth/login?platform=workbuddy&state=${encodeURIComponent(result.state)}&domain=www.workbuddy.cn`;
  const consoleResponse = await http.request(consoleUrl, undefined, { 'X-Domain': 'www.workbuddy.cn' });
  const location = consoleResponse.headers.get('location');
  await consoleResponse.body?.cancel();
  if (!location) throw new Error('上游未返回登录地址');
  const keycloakUrl = new URL(location, HOST).href;
  const page = await (await http.request(keycloakUrl)).text();
  const link = /data-idp="oneid"[^>]*href="([^"]+)"/.exec(page)?.[1]?.replaceAll('&amp;', '&');
  if (!link) throw new Error('上游登录页面已调整，请改用凭证导入');
  const broker = await http.request(new URL(link, HOST).href);
  const authorize = broker.headers.get('location');
  await broker.body?.cancel();
  if (!authorize) throw new Error('上游未返回 OneID 授权地址');
  const oneidState = new URL(authorize).searchParams.get('state');
  if (!oneidState) throw new Error('OneID 授权缺少 state');
  await (await http.request(authorize)).body?.cancel();
  const id = crypto.randomUUID();
  const state: LoginState = { state: result.state, keycloakUrl, oneidState, cookies: await http.jar.serialize() };
  await store.db.delete(loginSessions).where(lt(loginSessions.expires_at, Date.now())).run();
  await store.db.insert(loginSessions).values({ id, payload: await seal(state, env), expires_at: Date.now() + 900000 }).run();
  return { id };
}

async function withSession<T>(id: string, store: Store, env: RuntimeEnv, run: (state: LoginState, http: LoginHttp) => Promise<T>): Promise<T> {
  const owner = await store.lease(`phone:${id}`, 240000);
  if (!owner) throw new Error('登录请求正在处理，请稍后重试');
  try {
    const row = await store.db.select({ payload: loginSessions.payload }).from(loginSessions).where(and(eq(loginSessions.id, id), gt(loginSessions.expires_at, Date.now()))).get();
    if (!row) throw new Error('登录会话已过期，请重新开始');
    const state = await open<LoginState>(row.payload, env);
    const http = new LoginHttp(await CookieJar.deserialize(state.cookies));
    try { return await run(state, http); }
    finally {
      state.cookies = await http.jar.serialize();
      await store.db.update(loginSessions).set({ payload: await seal(state, env) }).where(eq(loginSessions.id, id)).run();
    }
  } finally { await store.release(`phone:${id}`, owner); }
}

export async function sendPhone(id: string, mobile: string, store: Store, env: RuntimeEnv) {
  return withSession(id, store, env, async (state, http) => {
    if (state.consumed) throw new Error('登录已完成，请重新开始');
    const digits = mobile.replace(/\D/g, '').replace(/^86(?=\d{11}$)/, '');
    if (!/^1[3-9]\d{9}$/.test(digits)) throw new Error('请输入正确的大陆手机号');
    if ((state.sentAt ?? 0) > Date.now() - 60000) throw new Error('请等待 60 秒后再发送验证码');
    if (!await store.limit(`sms:${digits}`, 5, 86400000)) throw new Error('该号码今日发码次数已达限制');
    // Persist the cooldown even when upstream requires a captcha.
    state.sentAt = Date.now();
    const result = await json(await http.request(OAUTH + '/v1/auth/sms/code/send', { client_code: 'codebuddy', mobile: '+86 ' + digits, scopes: ['openid', 'mobile', 'profile'] }, { 'X-TOA-LANG': 'zh-CN' }));
    if (typeof result.state_token !== 'string') throw new Error(result.captcha || result.status === 'need_captcha' ? '上游要求安全验证，请在官方客户端登录后导出凭证' : '上游未返回短信状态，请稍后重试');
    state.smsToken = result.state_token;
    state.mobile = digits;
    return { expiresIn: Number(result.expires_in || 60) };
  });
}

export async function verifyPhone(id: string, code: string, store: Store, env: RuntimeEnv) {
  return withSession(id, store, env, async (state, http) => {
    if (state.result) return state.result;
    if (state.consumed) throw new Error('授权已消费，请重新开始登录');
    if (!state.smsToken) throw new Error('请先发送验证码');
    if (!await store.limit(`verify:${id}`, 8, 900000)) throw new Error('验证码尝试次数过多，请重新登录');
    const verified = await json(await http.request(OAUTH + '/v1/auth/sms/code/verify', { state_token: state.smsToken, code }, { 'X-TOA-LANG': 'zh-CN' }));
    if (typeof verified.state_token === 'string') state.smsToken = verified.state_token;
    // This endpoint consumes the one-time token; never call it twice.
    state.consumed = true;
    state.cookies = await http.jar.serialize();
    await store.db.update(loginSessions).set({ payload: await seal(state, env) }).where(eq(loginSessions.id, id)).run();
    const result = await json(await http.request(OAUTH + '/v1/auth/accounts?state_token=' + encodeURIComponent(state.smsToken)));
    let authorizationCode = typeof result.code === 'string' ? result.code : '';
    if (!authorizationCode) {
      const first = object(array(result.accounts)[0]);
      const selected = await json(await http.request(OAUTH + '/v1/auth/select_account', { state_token: state.smsToken, account_id: first.id || 'codebuddy@' }));
      authorizationCode = String(selected.code || '');
    }
    if (!authorizationCode) throw new Error('上游未返回账号授权码');
    await (await http.follow(`${HOST}/auth/realms/copilot/broker/oneid/endpoint?code=${encodeURIComponent(authorizationCode)}&state=${encodeURIComponent(state.oneidState)}`)).body?.cancel();
    await (await http.follow(`${HOST}/console/auth/login?platform=workbuddy&state=${encodeURIComponent(state.state)}&domain=www.workbuddy.cn`)).body?.cancel();
    const auth = object((await json(await http.request(HOST + '/v2/plugin/auth/token?state=' + encodeURIComponent(state.state), undefined, { 'X-No-Authorization': 'true' }))).data);
    if (typeof auth.accessToken !== 'string' || typeof auth.refreshToken !== 'string') throw new Error('未取得完整账号凭证');
    const profileResult = await json(await http.request(HOST + '/v2/plugin/accounts', undefined, { Authorization: 'Bearer ' + auth.accessToken, 'X-Domain': String(auth.domain || 'www.workbuddy.cn'), 'X-No-User-Id': 'true', 'X-No-Enterprise-Id': 'true' }));
    const profile = object(array(object(profileResult.data).accounts)[0]);
    const credential: Credential = { auth: { ...auth, accessToken: auth.accessToken, refreshToken: auth.refreshToken, expiresAt: Date.now() + Number(auth.expiresIn || 3600) * 1000 }, account: { ...profile, uid: String(profile.uid || '') } };
    state.result = await importAccount(credential, '', store, env);
    return state.result;
  });
}
