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

  const createdAgent = await request(base, '/api/admin/agents', { method: 'POST', body: JSON.stringify({ name: 'CI Agent' }) }, session);
  assert.equal(createdAgent.response.status, 201);
  assert.ok(createdAgent.body.install.token.length > 30);
  assert.match(createdAgent.body.install.docker, /^docker run -d/);
  assert.doesNotMatch(createdAgent.body.install.docker, /\+\s+-e/);
  assert.match(createdAgent.body.install.docker, /\\\n\s+-e NETPILOT_SERVER=/);
  const agentID = createdAgent.body.agent.id;
  const storedAgent = database.prepare('SELECT * FROM agents WHERE id = ?').get(agentID);
  assert.equal(storedAgent.token_hash.length, 64);
  assert.ok(!storedAgent.token_hash.includes(createdAgent.body.install.token));

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

  socket.close();
  await once(socket, 'close');
});
