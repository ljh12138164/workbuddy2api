import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Load emitted JavaScript with Node, without a bundler resolving extensionless imports.
const root = fileURLToPath(new URL('../', import.meta.url));
const artifactRoot = resolve(root, '.vercel');
mkdirSync(artifactRoot, { recursive: true });
const output = mkdtempSync(join(artifactRoot, 'esm-smoke-'));
try {
  writeFileSync(join(output, 'package.json'), '{"type":"module"}');
  const config = join(output, 'tsconfig.json');
  writeFileSync(config, JSON.stringify({
    extends: join(root, 'tsconfig.json'),
    compilerOptions: { noEmit: false, incremental: false, rootDir: root, outDir: output },
    include: [join(root, 'api/index.ts')],
  }));
  const compiled = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', config], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stdout || compiled.stderr || compiled.error?.message);
  const entry = pathToFileURL(join(output, 'api/index.js')).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const { default: handler } = await import(${JSON.stringify(entry)});
    const response = await handler.fetch(new Request('https://example.test/api/index?__wb_path=/health'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, service: 'workbuddy-web' });
    const rejected = await handler.fetch(new Request('https://example.test/api/index?__wb_path=/api/trpc/auth.login&batch=1', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }));
    assert.equal(rejected.status, 403);
    assert.ok(rejected.headers.get('Content-Type').includes('application/json'));
    await rejected.json();
    for (const path of ['/v1/growth/run', '/v1/credentials/refresh']) {
      const response = await handler.fetch(new Request('https://example.test/api/index?__wb_path=' + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      }));
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /accountId/);
    }
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  console.log('Vercel emitted ESM entry: health, management and public automation routes passed');
} finally {
  assert.equal(dirname(output), artifactRoot);
  assert.ok(resolve(output).startsWith(artifactRoot + sep));
  rmSync(output, { recursive: true, force: true });
}
