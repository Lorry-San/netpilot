import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import WebSocket from 'ws';

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

async function request(base, path, options = {}, session = '') {
  const response = await fetch(base + path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(session ? { cookie: session } : {}), ...(options.headers || {}) }
  });
  return { response, body: await response.json() };
}

test('security invariants, roles and Agent installation lock', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'netpilot-test-'));
  const dbPath = join(directory, 'test.sqlite');
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const root = resolve(import.meta.dirname, '..');
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), PUBLIC_BASE_URL: base, DB_PATH: dbPath, ADMIN_PASSWORD: 'Integration-Test-Password-2026' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let database;
  t.after(async () => {
    if (database) database.close();
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolvePromise) => setTimeout(resolvePromise, 2000))]);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await waitForServer(child);

  const login = await request(base, '/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'Integration-Test-Password-2026' }) });
  assert.equal(login.response.status, 200);
  assert.equal(login.body.user.id, 1);
  assert.equal(login.body.user.role, 'admin');
  const session = login.response.headers.get('set-cookie').split(';', 1)[0];

  database = new DatabaseSync(dbPath);
  const admin = database.prepare('SELECT * FROM users WHERE id = 1').get();
  assert.equal(admin.id, 1);
  assert.equal(admin.role, 'admin');
  assert.match(admin.password_hash, /^scrypt\$/);
  assert.ok(!admin.password_hash.includes('Integration-Test-Password-2026'));

  const demote = await request(base, '/api/users/1', { method: 'PATCH', body: JSON.stringify({ role: 'user' }) }, session);
  assert.equal(demote.response.status, 400);
  const disable = await request(base, '/api/users/1', { method: 'PATCH', body: JSON.stringify({ disabled: true }) }, session);
  assert.equal(disable.response.status, 400);
  const remove = await request(base, '/api/users/1', { method: 'DELETE' }, session);
  assert.equal(remove.response.status, 400);

  const defaultSettings = await request(base, '/api/settings', {}, session);
  assert.equal(defaultSettings.response.status, 200);
  assert.deepEqual(defaultSettings.body.settings, {
    agentWsBase: '',
    scriptBase: '',
    githubAccelEnabled: false,
    githubAccelDomain: ''
  });
  const invalidSettings = await request(base, '/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ agentWsBase: 'wss://agents.example.com/path', scriptBase: '', githubAccelEnabled: false, githubAccelDomain: '' })
  }, session);
  assert.equal(invalidSettings.response.status, 400);
  const savedSettings = await request(base, '/api/settings', {
    method: 'PUT',
    body: JSON.stringify({
      agentWsBase: 'wss://agents.example.com:8443/',
      scriptBase: 'https://downloads.example.com/',
      githubAccelEnabled: true,
      githubAccelDomain: 'https://ghproxy.example.com/'
    })
  }, session);
  assert.equal(savedSettings.response.status, 200);
  const settings = await request(base, '/api/settings', {}, session);
  assert.deepEqual(settings.body.settings, {
    agentWsBase: 'wss://agents.example.com:8443',
    scriptBase: 'https://downloads.example.com',
    githubAccelEnabled: true,
    githubAccelDomain: 'https://ghproxy.example.com'
  });

  const createdAgent = await request(base, '/api/admin/agents', { method: 'POST', body: JSON.stringify({ name: "CI Agent's node" }) }, session);
  assert.equal(createdAgent.response.status, 201);
  assert.ok(createdAgent.body.install.token.length > 30);
  assert.match(createdAgent.body.install.docker, /^docker run -d/);
  assert.doesNotMatch(createdAgent.body.install.docker, /\+\s+-e/);
  assert.match(createdAgent.body.install.docker, /\\\n\s+-e NETPILOT_SERVER=/);
  assert.match(createdAgent.body.install.docker, /wss:\/\/agents\.example\.com:8443\/ws\/agent/);
  assert.match(createdAgent.body.install.docker, /CI Agent'"'"'s node/);
  assert.match(createdAgent.body.install.script, /^curl -fsSL 'https:\/\/downloads\.example\.com\/install-agent\.sh'/);
  assert.match(createdAgent.body.install.script, /NETPILOT_REPO='Lorry-San\/netpilot'/);
  assert.match(createdAgent.body.install.script, /NETPILOT_GITHUB_ACCEL='https:\/\/ghproxy\.example\.com\/'/);
  const agentID = createdAgent.body.agent.id;
  const storedAgent = database.prepare('SELECT * FROM agents WHERE id = ?').get(agentID);
  assert.equal(storedAgent.token_hash.length, 64);
  assert.ok(!storedAgent.token_hash.includes(createdAgent.body.install.token));

  const updateCommand = await request(base, `/api/admin/agents/${agentID}/update-command`, { method: 'POST', body: '{}' }, session);
  assert.equal(updateCommand.response.status, 200);
  assert.match(updateCommand.body.update.command, /^\(tmp="\$\(mktemp\)"/);
  assert.match(updateCommand.body.update.command, /https:\/\/downloads\.example\.com\/update-agent\.sh/);
  assert.match(updateCommand.body.update.command, /NETPILOT_REPO='Lorry-San\/netpilot'/);
  assert.match(updateCommand.body.update.command, /NETPILOT_GITHUB_ACCEL='https:\/\/ghproxy\.example\.com\/'/);
  assert.doesNotMatch(updateCommand.body.update.command, new RegExp(createdAgent.body.install.token));
  database.prepare("UPDATE agents SET status = 'busy' WHERE id = ?").run(agentID);
  const busyUpdate = await request(base, `/api/admin/agents/${agentID}/update-command`, { method: 'POST', body: '{}' }, session);
  assert.equal(busyUpdate.response.status, 409);
  database.prepare("UPDATE agents SET status = 'offline' WHERE id = ?").run(agentID);

  const rotated = await request(base, `/api/admin/agents/${agentID}/install`, { method: 'POST', body: '{}' }, session);
  assert.equal(rotated.response.status, 200);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'agent.auth', token: rotated.body.install.token, payload: { agentId: agentID, os: 'linux', arch: 'amd64', version: 'test' } }));
  const [reply] = await once(socket, 'message');
  assert.equal(JSON.parse(reply.toString()).type, 'agent.auth.ok');

  const onlineInstall = await request(base, `/api/admin/agents/${agentID}/install`, { method: 'POST', body: '{}' }, session);
  assert.equal(onlineInstall.response.status, 409);

  const newUser = await request(base, '/api/users', { method: 'POST', body: JSON.stringify({ username: 'operator', displayName: 'Operator', password: 'Operator-Password-2026', role: 'user', agentIds: [agentID] }) }, session);
  assert.equal(newUser.response.status, 201);
  assert.equal(newUser.body.user.role, 'user');
  const userLogin = await request(base, '/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'operator', password: 'Operator-Password-2026' }) });
  const userSession = userLogin.response.headers.get('set-cookie').split(';', 1)[0];
  const forbiddenUsers = await request(base, '/api/users', {}, userSession);
  assert.equal(forbiddenUsers.response.status, 403);
  const assignedAgents = await request(base, '/api/agents', {}, userSession);
  assert.equal(assignedAgents.response.status, 200);
  assert.deepEqual(assignedAgents.body.agents.map((agent) => agent.id), [agentID]);
  const forbiddenSettings = await request(base, '/api/settings', {}, userSession);
  assert.equal(forbiddenSettings.response.status, 403);
  const forbiddenUpdate = await request(base, `/api/admin/agents/${agentID}/update-command`, { method: 'POST', body: '{}' }, userSession);
  assert.equal(forbiddenUpdate.response.status, 403);

  const secondAdmin = await request(base, '/api/users', { method: 'POST', body: JSON.stringify({ username: 'backup-admin', displayName: 'Backup Admin', password: 'Backup-Admin-Password-2026', role: 'admin' }) }, session);
  assert.equal(secondAdmin.response.status, 201);
  const secondAdminLogin = await request(base, '/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'backup-admin', password: 'Backup-Admin-Password-2026' }) });
  const secondAdminSession = secondAdminLogin.response.headers.get('set-cookie').split(';', 1)[0];
  const adminForbiddenSettings = await request(base, '/api/settings', {}, secondAdminSession);
  assert.equal(adminForbiddenSettings.response.status, 403);

  const version = await request(base, '/api/system/version', {}, session);
  assert.equal(version.response.status, 200);
  assert.equal(version.body.current, '0.1.3');
  assert.ok(Object.hasOwn(version.body, 'updateAvailable'));

  socket.close();
  await once(socket, 'close');
});
