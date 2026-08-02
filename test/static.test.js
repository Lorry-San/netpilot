import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

async function unusedPort() {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForServer(child) {
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (output.includes('listening on')) return;
    if (child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
  }
  throw new Error('server did not start in time');
}

test('static assets and installer script are served', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'netpilot-static-'));
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const root = resolve(import.meta.dirname, '..');
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), PUBLIC_BASE_URL: base, DB_PATH: join(directory, 'test.sqlite'), ADMIN_PASSWORD: 'Static-Test-Password-2026' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolvePromise) => setTimeout(resolvePromise, 2000))]);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await waitForServer(child);

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.equal(index.headers.get('cache-control'), 'no-cache');
  const indexHtml = await index.text();
  assert.match(indexHtml, /password/i);
  assert.doesNotMatch(indexHtml, /id="login-username"[^>]*value=/);
  assert.equal((indexHtml.match(/formnovalidate/g) || []).length, 8);
  assert.match(indexHtml, /id="account-button"/);
  assert.match(indexHtml, /id="account-menu"/);
  assert.match(indexHtml, /id="profile-dialog"/);
  assert.match(indexHtml, /id="user-edit-dialog"/);
  assert.doesNotMatch(indexHtml, /id="profile-uid"[^>]*input/);
  assert.match(indexHtml, /class="readonly-field"><span>UID<\/span><strong id="profile-uid"/);
  assert.match(indexHtml, /id="update-banner"/);
  assert.match(indexHtml, /data-action="all"/);
  assert.match(indexHtml, /data-action="invert"/);
  assert.match(indexHtml, /data-action="clear"/);
  assert.match(indexHtml, /id="view-settings"[^>]*data-system-admin-only/);
  assert.match(indexHtml, /id="setting-agent-ws"/);
  assert.match(indexHtml, /id="setting-script-base"/);
  assert.match(indexHtml, /id="setting-github-accel-enabled"/);
  assert.match(indexHtml, /id="setting-telegram-token"/);
  assert.match(indexHtml, /id="setting-telegram-status"/);
  assert.match(indexHtml, /\/app\.js\?v=0\.1\.9/);
  assert.match(indexHtml, /id="generate-telegram-code"/);
  assert.match(indexHtml, /id="telegram-group-choices"/);
  assert.match(indexHtml, /id="telegram-groups-all-members"/);
  assert.match(indexHtml, /id="current-version"/);
  assert.match(indexHtml, /id="update-agent-panel"/);
  assert.match(indexHtml, /id="agent-update-command"/);
  assert.match(indexHtml, /id="test-reverse"[^>]*checked/);
  assert.match(indexHtml, /id="test-duration"[^>]*value="10"/);
  assert.match(indexHtml, /id="test-parallel"><option selected>1<\/option>/);

  for (const asset of ['/app.js', '/styles.css']) {
    const response = await fetch(base + asset);
    assert.equal(response.status, 200, asset);
    assert.ok((await response.text()).length > 1000, asset);
  }

  const appScript = await (await fetch(`${base}/app.js`)).text();
  assert.match(appScript, /loadTests\(\{ preserveActiveOutput: true \}\)/);
  assert.match(appScript, /preserveActiveOutput && active\.status === 'running'/);
  assert.match(appScript, /output\.append\(document\.createTextNode/);
  assert.match(appScript, /\/api\/me/);
  assert.match(appScript, /agent\.update/);
  assert.match(appScript, /autoUpdateSupported/);
  assert.match(appScript, /先手动更新/);
  assert.match(appScript, /\/update`/);
  assert.match(appScript, /selectedAgentIds/);
  assert.match(appScript, /\/api\/telegram\/bind-code/);
  assert.match(appScript, /\/api\/admin\/telegram\/groups/);

  const installer = await fetch(`${base}/install-agent.sh`);
  assert.equal(installer.status, 200);
  const script = await installer.text();
  assert.match(script, /x86_64\|amd64/);
  assert.match(script, /aarch64\|arm64/);
  assert.match(script, /systemctl/);
  assert.match(script, /openrc-run/);
  assert.match(script, /NETPILOT_GITHUB_ACCEL/);

  const updater = await fetch(`${base}/update-agent.sh`);
  assert.equal(updater.status, 200);
  const updateScript = await updater.text();
  assert.match(updateScript, /SHA256SUMS/);
  assert.match(updateScript, /x86_64\|amd64/);
  assert.match(updateScript, /aarch64\|arm64/);
  assert.match(updateScript, /ROLLBACK="native"/);
  assert.match(updateScript, /ROLLBACK="docker"/);
  assert.match(updateScript, /systemctl/);
  assert.match(updateScript, /rc-service/);
  assert.match(updateScript, /docker pull/);

  const missing = await fetch(`${base}/../src/server.js`);
  assert.notEqual(missing.status, 200);
  const traversal = await fetch(`${base}/%2e%2e/%2e%2e/package.json`);
  assert.notEqual(traversal.status, 200);
});
