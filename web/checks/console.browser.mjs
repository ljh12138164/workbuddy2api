import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Optional browser check against the production export, with no live backend.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../out/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) { response.writeHead(403).end(); return; }
    response.setHeader('Content-Type', types[extname(path)] || 'application/octet-stream');
    response.end(await readFile(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.__copied = text; } } }));
  const calls = [];
  let failKeys = false, enabled = true;
  const data = {
    'auth.me': { username: 'admin' },
    'keys.list': [], 'models.list': [], 'groups.list': [],
    stats: { requests: 0, tokens: 0, failed: 0 },
    'growth.list': { tasks: [] },
    'keys.create': { id: 'test-key', key: 'sk-once-only' },
    'accounts.update': { ok: true },
  };
  await page.route('**/api/trpc/**', async route => {
    const url = new URL(route.request().url());
    const names = decodeURIComponent(url.pathname.slice('/api/trpc/'.length)).split(',');
    const result = names.map(name => {
      calls.push(name);
      if (name === 'keys.create') failKeys = true;
      if (name === 'accounts.update') enabled = !enabled;
      if (name === 'keys.list' && failKeys) return { error: { message: 'Test refresh failure', code: -32603, data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500, path: name } } };
      const value = name === 'accounts.list' ? [{ id: 'test-account', uid: 'test-user', name: '测试账号', enabled: Number(enabled), balance: 0, balance_total: 0, credits: '{}' }] : data[name];
      assert.notEqual(value, undefined, `Unexpected procedure: ${name}`);
      return { result: { data: value } };
    });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(url.searchParams.has('batch') ? result : result[0]) });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const refresh = page.getByRole('button', { name: '刷新数据', exact: true });
  const idle = async () => { await page.waitForFunction(() => !document.querySelector('.operation-status')); };
  await page.goto(origin);
  await page.locator('.metrics-strip').waitFor(); await idle();
  calls.length = 0;
  await refresh.click(); await idle();
  assert.deepEqual([...calls].sort(), ['accounts.list', 'groups.list', 'keys.list', 'models.list', 'stats'].sort());

  calls.length = 0;
  await page.getByRole('button', { name: '复制 API 地址' }).click();
  await page.getByText('API 地址已复制', { exact: true }).waitFor(); await idle();
  assert.equal(await page.evaluate(() => window.__copied), origin + '/v1');
  assert.deepEqual(calls, []);

  await page.locator('details[data-panel="导入账号"] > summary').click();
  await page.getByLabel('凭证文件').setInputFiles({ name: 'account.json', mimeType: 'application/json', buffer: Buffer.from('{"auth":{}}') });
  await page.waitForFunction(() => document.querySelector('textarea')?.value === '{"auth":{}}'); await idle();
  assert.deepEqual(calls, []);

  await page.getByRole('button', { name: '停用', exact: true }).click();
  await page.getByRole('button', { name: '启用', exact: true }).waitFor(); await idle();
  assert.deepEqual(calls, ['accounts.update', 'accounts.list']);

  calls.length = 0;
  await page.getByRole('button', { name: '成长任务', exact: true }).click();
  await page.locator('[data-panel="手动成长任务"] select').selectOption('test-account');
  await page.getByRole('button', { name: '查询任务', exact: true }).click();
  await page.getByText('没有可展示的任务', { exact: true }).waitFor(); await idle();
  assert.deepEqual(calls, ['growth.list']);

  calls.length = 0;
  await page.getByRole('button', { name: 'API Key', exact: true }).click();
  await page.locator('[data-panel="创建 API Key"]').getByLabel('名称', { exact: true }).fill('browser-test');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '操作已完成，但数据刷新失败' }).waitFor(); await idle();
  assert.equal(await page.getByLabel('完整 Key（只显示这一次）').inputValue(), 'sk-once-only');
  assert.deepEqual(calls, ['keys.create', 'keys.list']);
  assert.deepEqual(browserErrors, []);
  console.log('Console browser checks passed: single refresh, local actions, selective updates, task queries and successful mutation with failed refresh');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
