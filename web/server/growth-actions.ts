import { digest } from './security.js';
import { sseData } from './protocols.js';
import { array, BACKEND, credentialHeaders, object, type ObjectValue } from './upstream.js';
import type { Credential, RuntimeEnv } from './types';

const WEB = 'https://www.workbuddy.cn', BILL = 'https://www.codebuddy.cn', ARDOT = 'https://ardot.tencent.com';
const DESKTOP_UA = 'WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1';
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
export type TaskAction = 'chat' | 'automation' | 'skill' | 'playbook' | 'library' | 'expert' | 'team' | 'template' | 'lighthouse' | 'appearance' | 'buddy-app' | 'desktop-chat' | 'canvas';

export class GrowthError extends Error {}

// One client per run: credential, cancellation and endpoint-specific headers stay together.
export class GrowthClient {
  constructor(private credential: Credential, private env: RuntimeEnv, readonly signal: AbortSignal) {}

  async request(url: string, body?: unknown, headers = credentialHeaders(this.credential, this.env)) {
    this.signal.throwIfAborted();
    return fetch(url, { method: body === undefined ? 'GET' : 'POST', headers,
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(20000)]),
    });
  }

  async json(path: string, body?: unknown, base = BACKEND, headers?: Headers) {
    const response = await this.request(base + path, body, headers);
    const payload = object(await response.json().catch(() => ({})));
    if (!response.ok || Number(payload.code) !== 0) throw new GrowthError(`上游请求失败（HTTP ${response.status}，业务码 ${Number(payload.code) || 0}）`);
    return object(payload.data);
  }

  async tasks() {
    const data = await this.json('/v2/activity/growth/tasks');
    if (!Array.isArray(data.tasks)) throw new GrowthError('上游未返回有效的任务列表');
    return data.tasks.map(object);
  }
  claim(code: string) { return this.json(`/activity/growth/tasks/${encodeURIComponent(code)}/claim`, {}); }
  async accept(codes: string[]) {
    const data = await this.json('/v2/activity/growth/tasks/accept', { task_codes: codes });
    return array(data.results).map(object);
  }

  async pause(ms: number) {
    this.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(this.signal.reason); };
      const timer = setTimeout(() => { this.signal.removeEventListener('abort', abort); resolve(); }, ms);
      this.signal.addEventListener('abort', abort, { once: true });
    });
  }

  async chat(eventCodes = ['chat_request_send'], model = 'hy3') {
    const id = crypto.randomUUID();
    const response = await this.request(BACKEND + '/v2/chat/completions', {
      model, stream: true, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }],
      extra_vars: { growthEvent: JSON.stringify(eventCodes.map(eventCode => ({ eventCode, id }))) },
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new GrowthError(`任务对话失败（HTTP ${response.status}）`); }
    for await (const data of sseData(response.body)) {
      if (data === '[DONE]') return;
      const chunk = object(JSON.parse(data));
      if (chunk.error || (chunk.code !== undefined && Number(chunk.code) !== 0)) throw new GrowthError('任务对话返回上游错误');
      if (array(chunk.choices).some(choice => object(choice).finish_reason)) return;
    }
    throw new GrowthError('任务对话未完整返回');
  }

  async ensureBuddy() {
    if (Object.keys(object((await this.json('/activity/growth/buddy/info')).buddy)).length) return;
    await this.json('/activity/growth/buddy/agreement', { agree: true });
    await this.json('/activity/growth/buddy/first', {});
  }

  private headers(kind: 'billing' | 'desktop' | 'web' | 'connector') {
    const headers = credentialHeaders(this.credential, this.env);
    headers.set('User-Agent', kind === 'web' ? WEB_UA : kind === 'billing' ? 'CLI/2.63.2 CodeBuddy/2.63.2' : DESKTOP_UA);
    if (kind === 'web') {
      headers.set('x-client-platform', 'web'); headers.set('Origin', WEB); headers.set('X-Domain', WEB);
      headers.set('Referer', WEB + '/space/d/o0KWYeynteVv06UnAZqIFm');
    } else if (kind === 'billing') { headers.set('Origin', BILL); headers.set('Referer', BILL + '/'); }
    else { headers.set('X-Product', 'SaaS'); headers.set('X-CodeBuddy-Request', '1'); }
    return headers;
  }

  private async report(events: ObjectValue[], kind: 'billing' | 'desktop' | 'web' = 'billing') {
    const uid = this.credential.account.uid, timestamp = Date.now();
    let common: ObjectValue = { userId: uid, timestamp, reportDelay: 0 };
    if (kind === 'desktop') common = { ...common, presentAt: timestamp,
      machineId: (await digest(`machine:${uid}`)).slice(0, 32), sessionId: (await digest(`session:${uid}`)).slice(0, 32),
      timezone: 'Asia/Shanghai', reportDelay: 2000, product: 'SaaS', ideName: 'WorkBuddy', ideType: 'WorkBuddy',
      ideVersion: '5.5.6', extName: 'workbuddy-desktop', extVersion: '5.5.6', os: 'win32', arch: 'x64',
      osVersion: '10.0.26220', cpuCores: 20, memorySize: 24,
      username: this.credential.account.nickname || '', userNickname: this.credential.account.nickname || '',
    };
    await this.json('/v2/report', events.map(event => ({ ...event, ...common })), kind === 'web' ? WEB : kind === 'desktop' ? BACKEND : BILL, this.headers(kind));
  }

  private async experts(team = false, keyword?: string) {
    const data = await this.json('/v2/operation-platform/market/expert/list', {
      page: 1, page_size: 50, ...(team ? { expert_type: 'team' } : {}), ...(keyword ? { keyword } : {}),
    });
    return array(data.experts).map(object).filter(e => (e.expert_id || e.source_id) && (!team || e.expert_type === 'team'));
  }

  async execute(action: TaskAction, index: number, model?: string) {
    const timestamp = Date.now(), cid = crypto.randomUUID(), requestId = `${cid}-${timestamp}`;
    if (action === 'chat' || action === 'automation' || action === 'skill') return this.chat([
      action === 'chat' ? 'chat_request_send' : action === 'automation' ? 'automated_task_create_suc' : 'skill_info',
    ], model);
    if (action === 'playbook') return this.report([{ eventCode: 'playbook_prompt_send', id: `pb-${timestamp}`, name: 'playbook',
      type: 'other', promptLength: 12, isOfficial: 1, skills: '', skillNames: '', expertId: '', expertName: '',
      categoryId: '', categoryName: '', query: '', source: 'discover', conversationId: cid, requestId, ext1: 'discover',
    }]);
    if (action === 'library') return this.report([{ eventCode: 'web_element_click', pageURL: WEB + '/space/d/o0KWYeynteVv06UnAZqIFm',
      elementId: 'library_doc_intro_click', elementName: 'WorkBuddy资料库介绍', os: 'Win32', arch: '', osVersion: '10.0',
      userAgent: WEB_UA, machineId: (await digest(`webmachine:${this.credential.account.uid}`)).slice(0, 32), userNickname: this.credential.account.nickname || '',
    }], 'web');
    if (action === 'expert' || action === 'team' || action === 'lighthouse') {
      let experts = await this.experts(action === 'team', action === 'lighthouse' ? 'lighthouse' : undefined);
      if (action === 'lighthouse') {
        experts = experts.filter(e => /lighthouse|轻量|light/i.test(String(e.expert_id || e.source_id) + String(e.display_name_zh || e.profession_zh || '')));
        if (!experts.length) experts = (await this.experts(false, '轻量云')).filter(e => /lighthouse|轻量|light/i.test(String(e.expert_id || e.source_id) + String(e.display_name_zh || e.profession_zh || '')));
      }
      if (!experts.length) throw new GrowthError('未找到可用的真实专家');
      const e = experts[index % experts.length], id = e.expert_id || e.source_id, name = e.display_name_zh || e.profession_zh || id;
      return this.report([{ eventCode: 'expert_actual_use', mode: 'CLOUD', id, name, expertTitle: name,
        type: array(e.categories)[0] || '', expertType: action === 'team' ? 'team' : e.expert_type || 'agent', source: 'builtin',
        version: e.version || '', cost: 0, characterCount: 12, conversationId: cid, requestId, messageId: requestId,
        requestModelId: 'deepseek-v4-flash', requestModelName: 'DeepSeek V4 Flash',
      }]);
    }
    if (action === 'template') {
      const scenes = array((await this.json('/console/as/support/scenes?locale=zh-CN')).scenes).map(object).filter(s => s.id !== undefined && s.id !== null);
      if (!scenes.length) throw new GrowthError('未找到可用的真实模板');
      const scene = scenes[index % scenes.length];
      return this.report([{ eventCode: 'agent_task_created_with_template', isCustomModel: true, id: String(scene.id), name: scene.name || '', conversationId: cid, requestId }]);
    }
    if (action === 'appearance') {
      const themes = array((await this.json('/v2/operation-platform/appearance/resources', { platform: 'client', kind: 'theme', version: '2.63.2', lang: 'zh-CN' }, BILL, this.headers('billing'))).resources).map(object);
      const theme = themes.find(t => t.id && /和平精英/.test(String(t.name)));
      if (!theme) throw new GrowthError('未找到和平精英主题资源');
      return this.report([{ eventCode: 'appearance_skin_apply', action: 'apply', source: 'settings_close', id: theme.id,
        vipLevel: theme.vip_level || 'free', series: theme.series || 'craft', type: 'unknown', name: theme.name,
      }]);
    }
    if (action === 'buddy-app') {
      const buddyId = 'cb_y5Dy46tPQGGWtueMxXbe', buddyName = '企鹅教师助手';
      return this.report([
        { eventCode: 'buddyapp_discover_click' },
        { eventCode: 'buddyapp_show', elementId: buddyId, elementName: buddyName, position: 2 },
        { eventCode: 'buddyapp_enter_click', elementId: buddyId, elementName: buddyName, position: 2, isFirstPage: '1' },
        { eventCode: 'buddyapp_auth_confirm_click', elementId: buddyId, elementName: buddyName },
        { eventCode: 'buddyapp_bindaccount_skip_click', elementId: buddyId, elementName: buddyName },
      ].map(event => ({ ...event, mode: 'LOCAL', buddyId, buddyName })), 'desktop');
    }
    if (action === 'desktop-chat') return this.report(desktopChat(cid, requestId), 'desktop');
    return this.canvas(cid, requestId);
  }

  private async connectorToken() {
    // Credential domains are untrusted input; never send bearer tokens to arbitrary hosts.
    const domain = this.credential.auth.domain?.replace(/^https:\/\//, '').replace(/\/$/, '');
    const bases = [...new Set([...(domain && ['www.workbuddy.cn', 'www.codebuddy.cn', 'copilot.tencent.com'].includes(domain) ? ['https://' + domain] : [WEB]), BACKEND])];
    const headers = this.headers('connector');
    const token = async () => {
      for (const base of bases) for (const route of ['v2', 'console']) {
        try {
          const data = await this.json(`/${route}/as/connector/oauth/ardot/accesstoken`, undefined, base, headers);
          const value = data.access_token || data.token;
          if (typeof value === 'string' && value) return value;
        } catch { this.signal.throwIfAborted(); }
      }
      return '';
    };
    let value = await token();
    if (value) return value;
    let alreadyConnected = false;
    for (const route of ['v2', 'console']) for (const base of bases) {
      const response = await this.request(base + `/${route}/as/connector/oauth/ardot/connect?code=shadow_account_grant`, {}, headers);
      const data = object(await response.json().catch(() => ({})));
      alreadyConnected ||= data.code === 10096 || /already connect/i.test(String(data.msg) + (response.headers.get('Location') || ''));
      if (response.ok && Number(data.code) === 0) { value = await token(); if (value) return value; }
    }
    if (alreadyConnected && !(value = await token())) {
      for (const base of bases) {
        try {
          await this.json('/v2/as/connector/oauth/ardot/revoke', {}, base, headers);
          await this.json('/v2/as/connector/oauth/ardot/connect?code=shadow_account_grant', {}, base, headers);
          value = await token(); if (value) return value;
        } catch { this.signal.throwIfAborted(); }
      }
    }
    if (value) return value;
    throw new GrowthError('无法绑定 Ardot 或获取画布访问凭证');
  }

  private async canvas(cid: string, requestId: string) {
    const token = await this.connectorToken();
    const headers = new Headers({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' });
    const call = async (id: number, method: string, params: ObjectValue) => {
      const response = await this.request(ARDOT + '/mcp', { jsonrpc: '2.0', id, method, params }, headers);
      if (!response.ok) { await response.body?.cancel(); throw new GrowthError(`Ardot MCP 请求失败（HTTP ${response.status}）`); }
      let payload: ObjectValue = {};
      if (response.headers.get('Content-Type')?.includes('text/event-stream') && response.body) {
        for await (const data of sseData(response.body)) { const item = object(JSON.parse(data)); if (item.id === id) { payload = item; break; } }
      } else payload = object(await response.json());
      if (payload.id !== id || payload.error || object(payload.result).isError) throw new GrowthError('Ardot MCP 未返回成功的调用结果');
      return object(payload.result);
    };
    await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'workbuddy2api', version: '1.0' } });
    const result = await call(2, 'tools/call', { name: 'create_design', arguments: { fileName: 'WorkBuddy 设计画布' } });
    const fileId = canvasId(result);
    if (!fileId) throw new GrowthError('Ardot 未返回真实画布 ID，未上报画布事件');
    await this.report([...desktopChat(cid, requestId),
      { eventCode: 'wbx_design_canvas_task_create', conversationId: cid, requestId, source: 'summon_keyword', isCustomModel: false,
        name: 'WorkBuddy 设计画布', inputLength: 24, id: fileId, cost: 12000, isSuccessful: true },
      { eventCode: 'wbx_design_canvas_open', conversationId: cid, requestId, id: fileId, source: 'summon_keyword', type: 'page', cost: 13000, isSuccessful: true },
    ], 'desktop');
  }
}

function canvasId(value: unknown): string {
  if (typeof value === 'string') {
    try { const id = canvasId(JSON.parse(value)); if (id) return id; } catch { /* MCP text is usually prose. */ }
    return value.match(/(?:\bfileId\s+|\bOpening Ardot editor for file\s+|\/file\/)(\d+)\b/i)?.[1] || '';
  }
  if (Array.isArray(value)) return value.map(canvasId).find(Boolean) || '';
  const data = object(value);
  for (const key of ['fileId', 'file_id']) if (/^\d+$/.test(String(data[key] ?? ''))) return String(data[key]);
  return Object.values(data).map(canvasId).find(Boolean) || '';
}

function desktopChat(conv: string, reqId: string): ObjectValue[] {
  const msg = conv + '-user', mid = 'fast-model', now = Date.now();
  const trace = { traceId: reqId, rootRequestId: reqId, parentConversationId: conv, agentName: 'cli', agentType: 'main' };
  const session = { 'codebuddy.session_id': conv, 'codebuddy.conversation_request_id': reqId };
  const usage = { inputToken: 120, outputToken: 80, totalToken: 200, cachedTokens: 0, cachedWriteTokens: 0, cachedMissTokens: 0 };
  return [
    { eventCode: 'agent_task_created', source: 'LOCAL', name: 'working', task_target: 'local', mode: 'craft', requestModelId: mid,
      requestModelName: mid, has_repo: false, repo_type: 'none', workspace_type: 'empty', has_connector: false, connector_types: [],
      has_mention: false, mention_types: [], has_template: false, action: '', template_name: '', has_expert: false, expert_id: '',
      expert_name: '', expert_industry_id: '', has_skill: false, skill_names: [], conversationId: conv, messageId: msg, buddyId: '', buddyName: '' },
    { eventCode: 'chat_message_send', messageId: msg + '-assistant', historyCount: 0, isContextTruncated: false, currentStepCount: 1, ...trace },
    { eventCode: 'chat_request_send', inputLength: 24, isPlan: false, isAutoExecuteTerminal: false, isAutoModify: false, codebaseEnable: false,
      maxToken: 0, maxSteps: 500, temperature: 0, maxRetries: 0, mentionContexts: [], knowledgeId: [], knowledgeName: [], codebaseId: '',
      mentionContextCount: 0, command: '', recommendId: '', skillId: '', skillCount: 0, totalCount: 0, ...trace, ...session },
    { eventCode: 'chat_message_response', messageId: msg + '-assistant', responseModelId: mid, ...usage, isSuccessful: true,
      messageErrorCode: '', finishReason: 'stop', firstTokenAt: now, conversationId: conv, ...trace, ...session },
    { eventCode: 'chat_message_status', messageId: msg + '-assistant', messageErrorCode: '0', ...trace },
    { eventCode: 'chat_request_response', mode: 'craft', toolCallCount: 1, ...usage, isSuccessful: true, messageErrorCode: '',
      finishReason: 'stop', rootRequestId: reqId, parentConversationId: conv },
  ];
}
