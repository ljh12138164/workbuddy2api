import { eq } from 'drizzle-orm';
import { GrowthClient, GrowthError, type TaskAction } from './growth-actions.js';
import { accountCredential, object, type ObjectValue } from './upstream.js';
import { accounts } from './tables.js';
import type { Store } from './store';
import type { Credential, RuntimeEnv } from './types';

interface Plan { action?: TaskAction; model?: string; reason: string }
const aliases: Record<string, string> = { 'GLM5.2': 'glm-5.2', 'GLM4.6': 'glm-4.6', GPT5: 'gpt-5', DeepSeekV4: 'deepseek-v4-flash' };
export function taskPlan(task: ObjectValue): Plan {
  const code = String(task.task_code || '');
  if (Number(task.reward_credit) <= 0 || code === 'black_cat') return { reason: '无积分奖励，跳过' };
  if (code === 'Expert_Philanthropy') return { reason: '需要真实捐款，请手动完成' };
  if (code === 'expert_5_paid') return { reason: '付费专家任务需手动完成' };
  if (/^chat_\d+$/.test(code) || code === 'first_buddy') return { action: 'chat', reason: '对话任务' };
  const model = code.match(/^Model_chat_(.+)$/)?.[1];
  if (model) return { action: 'chat', model: aliases[model] || model.toLowerCase(), reason: '使用指定模型对话' };
  const rules: [RegExp, TaskAction][] = [
    [/^automation_\d+$/, 'automation'], [/^skill_\d+$/, 'skill'], [/^expert_\d+$/, 'expert'],
    [/^template_\d+$/, 'template'], [/^Expert_team_use_\d+$/, 'team'], [/^Expert_lighthouse/, 'lighthouse'],
    [/appearance/i, 'appearance'], [/^playbook_prompt$/, 'playbook'], [/^Library_read$/, 'library'],
    [/^Buddy_App(?:_QQ)?$/, 'buddy-app'], [/^RichMeow_Chat$/, 'desktop-chat'], [/^create_canvas$/, 'canvas'],
  ];
  const action = rules.find(([pattern]) => pattern.test(code))?.[1];
  return { action, reason: action ? '可自动执行' : '暂无自动执行策略，请在官方客户端完成' };
}

export interface TaskResult {
  task_code: string; title: string; status: string; ok: boolean; fired: number; credit: number;
  message?: string; progress?: unknown;
}

export async function runGrowth(credential: Credential, env: RuntimeEnv, requestSignal: AbortSignal) {
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(230000)]);
  const client = new GrowthClient(credential, env, signal);
  const safeMessage = (error: unknown) => {
    const text = error instanceof GrowthError ? error.message : signal.aborted ? '执行已中断或达到时间上限，未完成任务可再次执行' : '上游操作失败，请稍后重试';
    return text.replaceAll(credential.auth.accessToken, '[redacted]').replaceAll(credential.auth.refreshToken, '[redacted]').slice(0, 240);
  };
  let tasks = await client.tasks();
  const results: TaskResult[] = [];
  let prerequisiteError = '';
  const gate = tasks.find(task => task.task_code === 'first_buddy');
  if (gate && !['completed', 'claimed'].includes(String(gate.accept_status))) {
    try {
      await client.chat();
      for (let i = 0; i < 12; i++) {
        tasks = await client.tasks();
        if (tasks.some(task => task.task_code === 'first_buddy' && ['completed', 'claimed'].includes(String(task.accept_status)))) break;
        await client.pause(1000);
      }
      await client.ensureBuddy();
      tasks = await client.tasks();
    } catch (error) { prerequisiteError = safeMessage(error); }
  }
  for (const task of tasks) {
    const code = String(task.task_code || '');
    if (!code) continue;
    const plan = taskPlan(task);
    const result: TaskResult = { task_code: code, title: String(task.title || code), status: String(task.accept_status || 'unknown'), ok: false, fired: 0, credit: 0, progress: task.progress };
    results.push(result);
    if (result.status === 'claimed' || result.status === 'completed') { result.ok = true; continue; }
    if (code === 'first_buddy') { result.message = prerequisiteError || '首次对话进度尚未完成'; continue; }
    if (!plan.action) { result.status = 'skipped'; result.ok = true; result.message = plan.reason; continue; }
    if (signal.aborted) { result.message = safeMessage(signal.reason); continue; }
    try {
      if (result.status === 'not_accepted') {
        let accepted = (await client.accept([code])).find(item => item.task_code === code);
        if (!['accepted', 'already_accepted'].includes(String(accepted?.status)) && String(accepted?.message).includes('first_buddy')) {
          await client.ensureBuddy();
          accepted = (await client.accept([code])).find(item => item.task_code === code);
        }
        if (!['accepted', 'already_accepted'].includes(String(accepted?.status))) throw new GrowthError(String(accepted?.message || '参与任务失败'));
        // Acceptance can be eventually consistent; do not send events until it is stored.
        for (let i = 0; i < 6; i++) {
          const latest = (await client.tasks()).find(item => item.task_code === code);
          if (latest && latest.accept_status !== 'not_accepted') { Object.assign(task, latest); break; }
          await client.pause(1000);
        }
        if (task.accept_status === 'not_accepted') throw new GrowthError('参与状态尚未生效，请稍后重试');
        result.status = String(task.accept_status);
        if (result.status === 'completed' || result.status === 'claimed') { result.ok = true; continue; }
      }
      if (task.accept_status !== 'accepted') throw new GrowthError('任务状态不支持执行，请刷新任务列表');
      const progress = object(task.progress), remaining = Number(progress.target) - Number(progress.current || 0);
      const times = plan.model ? 1 : Number.isFinite(remaining) && remaining > 0 ? Math.min(remaining, 50) : 1;
      for (let index = 0; index < times; index++) {
        await client.execute(plan.action, index, plan.model);
        result.fired++;
        if (index + 1 < times) await client.pause(1200);
      }
    } catch (error) { result.message = safeMessage(error); }
  }
  // Reconcile once for the batch, then poll only while observed writes are pending.
  try {
    for (let i = 0; i < 12; i++) {
      tasks = await client.tasks();
      const pending = results.filter(result => result.fired > 0).some(result => !tasks.some(task => task.task_code === result.task_code && ['completed', 'claimed'].includes(String(task.accept_status))));
      if (!pending || i === 11) break;
      await client.pause(1000);
    }
  } catch (error) {
    for (const result of results.filter(result => !result.ok)) result.message ||= safeMessage(error);
  }
  for (const result of results) {
    if (result.status === 'skipped') continue;
    const latest = tasks.find(task => task.task_code === result.task_code);
    if (latest) { result.status = String(latest.accept_status); result.progress = latest.progress; }
    if (result.status === 'completed' && !signal.aborted) {
      try {
        const claimed = await client.claim(result.task_code);
        if (claimed.status === 'error') throw new GrowthError('奖励领取失败');
        result.status = 'claimed'; result.credit = Number(claimed.credit) || 0;
      } catch (error) { result.message = safeMessage(error); result.ok = false; continue; }
    }
    result.ok = result.status === 'claimed';
    if (result.ok) delete result.message;
    else result.message ||= signal.aborted ? safeMessage(signal.reason) : '上游进度尚未完成，可稍后再次执行';
  }
  return { ok: results.every(result => result.ok), interrupted: signal.aborted, credit: results.reduce((total, result) => total + result.credit, 0), tasks: results };
}

// Both public endpoints and the console share account lookup, credential rotation and exclusion.
export async function automateAccount(id: string, store: Store, env: RuntimeEnv, signal: AbortSignal, refreshOnly = false) {
  const account = await store.db.select().from(accounts).where(eq(accounts.id, id)).get();
  if (!account) return { status: 404 as const, body: { error: '账号不存在' } };
  const leaseId = `account:${id}`, owner = await store.lease(leaseId, 270000);
  if (!owner) return { status: 409 as const, body: { error: '账号正在执行任务或请求，请稍后重试' } };
  try {
    const credential = await accountCredential(account, store, env, refreshOnly, 300000);
    if (refreshOnly) return { status: 200 as const, body: { ok: true, accountId: id, expiresAt: credential.auth.expiresAt || 0 } };
    return { status: 200 as const, body: { accountId: id, ...await runGrowth(credential, env, signal) } };
  } finally { await store.release(leaseId, owner); }
}
