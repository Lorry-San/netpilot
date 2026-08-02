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
  let response;
  try {
    response = await fetch(base + path, {
      ...options,
      headers: { 'content-type': 'application/json', ...(session ? { cookie: session } : {}), ...(options.headers || {}) }
    });
  } catch (error) {
    throw new Error(`${options.method || 'GET'} ${path} failed: ${error.message}`, { cause: error });
  }
  return { response, body: await response.json() };
}

function waitForMessage(socket, predicate, timeoutMs, label) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`timed out waiting for ${label}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onError);
    };
    const onError = (error) => {
      cleanup();
      rejectPromise(error);
    };
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      cleanup();
      resolvePromise(message);
    };
    socket.on('message', onMessage);
    socket.on('error', onError);
  });
}

test('security invariants, roles and Agent installation lock', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'netpilot-test-'));
  const dbPath = join(directory, 'test.sqlite');
  const legacyDatabase = new DatabaseSync(dbPath);
  legacyDatabase.exec(`CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'busy')),
    os TEXT NOT NULL DEFAULT 'linux',
    arch TEXT NOT NULL DEFAULT 'unknown',
    version TEXT NOT NULL DEFAULT '',
    public_ip TEXT NOT NULL DEFAULT '',
    ip_location TEXT NOT NULL DEFAULT '',
    cpu_percent REAL NOT NULL DEFAULT 0,
    memory_percent REAL NOT NULL DEFAULT 0,
    upload_percent REAL NOT NULL DEFAULT 0,
    download_percent REAL NOT NULL DEFAULT 0,
    last_seen_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  legacyDatabase.close();
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const root = resolve(import.meta.dirname, '..');
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), PUBLIC_BASE_URL: base, DB_PATH: dbPath, ADMIN_PASSWORD: 'Integration-Test-Password-2026', NETPILOT_DISABLE_TELEGRAM: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', (chunk) => process.stderr.write(`[server-stderr] ${chunk}`));
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
  database.exec('PRAGMA busy_timeout = 3000;');
  assert.ok(database.prepare('PRAGMA table_info(agents)').all().some((column) => column.name === 'deleted_at'));
  assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'telegram_users'").get());
  assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'telegram_groups'").get());
  assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'telegram_bind_codes'").get());
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
    githubAccelDomain: '',
    telegramBotToken: '',
    telegramBotEnabled: false,
    telegramBotUsername: ''
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
    githubAccelDomain: 'https://ghproxy.example.com',
    telegramBotToken: '',
    telegramBotEnabled: false,
    telegramBotUsername: ''
  });
  const invalidTelegramToken = await request(base, '/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ agentWsBase: '', scriptBase: '', githubAccelEnabled: false, githubAccelDomain: '', telegramBotToken: 'not-a-token' })
  }, session);
  assert.equal(invalidTelegramToken.response.status, 400);
  database.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('telegram_bot_token', '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(new Date().toISOString());
  const legacySettingsSave = await request(base, '/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ agentWsBase: 'wss://agents.example.com:8443', scriptBase: 'https://downloads.example.com', githubAccelEnabled: true, githubAccelDomain: 'https://ghproxy.example.com' })
  }, session);
  assert.equal(legacySettingsSave.response.status, 200);
  assert.equal(database.prepare("SELECT value FROM settings WHERE key = 'telegram_bot_token'").get().value, '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  database.prepare("DELETE FROM settings WHERE key IN ('telegram_bot_token', 'telegram_bot_username')").run();

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
  socket.send(JSON.stringify({ type: 'agent.auth', token: rotated.body.install.token, payload: { agentId: agentID, os: 'linux', arch: 'amd64', version: 'v0.1.4' } }));
  const [reply] = await once(socket, 'message');
  assert.equal(JSON.parse(reply.toString()).type, 'agent.auth.ok');

  const onlineInstall = await request(base, `/api/admin/agents/${agentID}/install`, { method: 'POST', body: '{}' }, session);
  assert.equal(onlineInstall.response.status, 409);

  const uiSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/ui`, { headers: { cookie: session } });
  await once(uiSocket, 'open');
  const oldAgentAutoUpdate = await request(base, `/api/admin/agents/${agentID}/update`, { method: 'POST', body: '{}' }, session);
  assert.equal(oldAgentAutoUpdate.response.status, 409);
  assert.match(oldAgentAutoUpdate.body.error, /不支持网页自动更新/);
  database.prepare("UPDATE agents SET version = 'v0.1.7' WHERE id = ?").run(agentID);
  const updateStartWait = waitForMessage(socket, (message) => message.type === 'agent.update.start', 3000, 'agent.update.start');
  const autoUpdate = await request(base, `/api/admin/agents/${agentID}/update`, { method: 'POST', body: '{}' }, session);
  assert.equal(autoUpdate.response.status, 202);
  assert.equal(autoUpdate.body.update.oldVersion, 'v0.1.7');
  const updateStart = await updateStartWait;
  assert.match(updateStart.taskId, /^update_/);
  assert.equal(updateStart.payload.scriptUrl, 'https://downloads.example.com/update-agent.sh');
  assert.equal(updateStart.payload.repo, 'Lorry-San/netpilot');
  assert.equal(updateStart.payload.githubAccel, 'https://ghproxy.example.com/');
  const updateDoneWait = waitForMessage(uiSocket, (message) => message.type === 'agent.update' && message.payload?.status === 'success', 3000, 'ui agent.update success');
  socket.send(JSON.stringify({ type: 'agent.update.started', taskId: updateStart.taskId, payload: { oldVersion: 'v0.1.7' } }));
  socket.send(JSON.stringify({ type: 'agent.update.output', taskId: updateStart.taskId, payload: { line: '>>> upgrading v0.1.7 -> v9.9.9' } }));
  socket.send(JSON.stringify({ type: 'agent.update.done', taskId: updateStart.taskId, payload: { exitCode: 0, oldVersion: 'v0.1.7', newVersion: 'v9.9.9' } }));
  const updateDone = await updateDoneWait;
  assert.equal(updateDone.payload.oldVersion, 'v0.1.7');
  assert.equal(updateDone.payload.newVersion, 'v9.9.9');
  assert.equal(database.prepare('SELECT version FROM agents WHERE id = ?').get(agentID).version, 'v9.9.9');
  uiSocket.close();
  await once(uiSocket, 'close');

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
  const bindCode = await request(base, '/api/telegram/bind-code', { method: 'POST', body: '{}' }, userSession);
  assert.equal(bindCode.response.status, 200);
  assert.match(bindCode.body.code, /^\d{6}$/);
  assert.equal(database.prepare('SELECT user_id FROM telegram_bind_codes WHERE code = ?').get(bindCode.body.code).user_id, newUser.body.user.id);
  const groupTime = new Date().toISOString();
  database.prepare("INSERT INTO telegram_groups (chat_id, title, owner_user_id, mode, created_at, updated_at) VALUES (-100123, 'CI Group', ?, 'members_only', ?, ?)").run(newUser.body.user.id, groupTime, groupTime);
  const forbiddenGroups = await request(base, '/api/admin/telegram/groups', {}, userSession);
  assert.equal(forbiddenGroups.response.status, 403);
  const groups = await request(base, '/api/admin/telegram/groups', {}, session);
  assert.equal(groups.response.status, 200);
  assert.equal(groups.body.groups[0].title, 'CI Group');
  const groupMode = await request(base, '/api/admin/telegram/groups/mode', { method: 'POST', body: JSON.stringify({ chatIds: ['-100123'], mode: 'all_members' }) }, session);
  assert.equal(groupMode.response.status, 200);
  assert.equal(database.prepare('SELECT mode FROM telegram_groups WHERE chat_id = -100123').get().mode, 'all_members');
  const badSelfPassword = await request(base, '/api/me', { method: 'PATCH', body: JSON.stringify({ displayName: 'Operator Renamed', currentPassword: 'wrong-password', newPassword: 'Operator-New-Password-2026' }) }, userSession);
  assert.equal(badSelfPassword.response.status, 403);
  const uidMutation = await request(base, '/api/me', { method: 'PATCH', body: JSON.stringify({ uid: 1, displayName: 'Root Maybe' }) }, userSession);
  assert.equal(uidMutation.response.status, 400);
  const selfProfile = await request(base, '/api/me', { method: 'PATCH', body: JSON.stringify({ displayName: 'Operator Renamed', currentPassword: 'Operator-Password-2026', newPassword: 'Operator-New-Password-2026' }) }, userSession);
  assert.equal(selfProfile.response.status, 200);
  assert.equal(selfProfile.body.user.displayName, 'Operator Renamed');
  assert.match(database.prepare('SELECT password_hash FROM users WHERE id = ?').get(newUser.body.user.id).password_hash, /^scrypt\$/);
  const userDetail = await request(base, `/api/users/${newUser.body.user.id}`, {}, session);
  assert.equal(userDetail.response.status, 200);
  assert.deepEqual(userDetail.body.user.agentIds, [agentID]);
  const adminUidMutation = await request(base, `/api/users/${newUser.body.user.id}`, { method: 'PATCH', body: JSON.stringify({ id: 1, displayName: 'Root Maybe' }) }, session);
  assert.equal(adminUidMutation.response.status, 400);
  const clearUserAgents = await request(base, `/api/users/${newUser.body.user.id}`, { method: 'PATCH', body: JSON.stringify({ displayName: 'Operator Limited', role: 'user', disabled: false, agentIds: [] }) }, session);
  assert.equal(clearUserAgents.response.status, 200);
  assert.deepEqual(clearUserAgents.body.user.agentIds, []);
  const assignedAfterClear = await request(base, '/api/agents', {}, userSession);
  assert.deepEqual(assignedAfterClear.body.agents.map((agent) => agent.id), []);
  const restoreUserAgents = await request(base, `/api/users/${newUser.body.user.id}`, { method: 'PATCH', body: JSON.stringify({ displayName: 'Operator Limited', role: 'user', disabled: false, agentIds: [agentID] }) }, session);
  assert.equal(restoreUserAgents.response.status, 200);
  assert.deepEqual(restoreUserAgents.body.user.agentIds, [agentID]);
  const forbiddenSettings = await request(base, '/api/settings', {}, userSession);
  assert.equal(forbiddenSettings.response.status, 403);
  const forbiddenUpdate = await request(base, `/api/admin/agents/${agentID}/update-command`, { method: 'POST', body: '{}' }, userSession);
  assert.equal(forbiddenUpdate.response.status, 403);
  const forbiddenAutoUpdate = await request(base, `/api/admin/agents/${agentID}/update`, { method: 'POST', body: '{}' }, userSession);
  assert.equal(forbiddenAutoUpdate.response.status, 403);

  const secondAdmin = await request(base, '/api/users', { method: 'POST', body: JSON.stringify({ username: 'backup-admin', displayName: 'Backup Admin', password: 'Backup-Admin-Password-2026', role: 'admin' }) }, session);
  assert.equal(secondAdmin.response.status, 201);
  const secondAdminLogin = await request(base, '/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'backup-admin', password: 'Backup-Admin-Password-2026' }) });
  const secondAdminSession = secondAdminLogin.response.headers.get('set-cookie').split(';', 1)[0];
  const adminForbiddenSettings = await request(base, '/api/settings', {}, secondAdminSession);
  assert.equal(adminForbiddenSettings.response.status, 403);

  const version = await request(base, '/api/system/version', {}, session);
  assert.equal(version.response.status, 200);
  assert.equal(version.body.current, '0.1.11');
  assert.ok(Object.hasOwn(version.body, 'updateAvailable'));

  socket.close();
  await once(socket, 'close');

  const historicalTestId = 'test_agent_soft_delete';
  const timestamp = new Date().toISOString();
  database.prepare(`INSERT INTO tests
    (id, user_id, agent_id, target, port, protocol, reverse, duration, parallel, status, started_at, finished_at, created_at)
    VALUES (?, 1, ?, '127.0.0.1', 5201, 'tcp', 0, 10, 1, 'completed', ?, ?, ?)`)
    .run(historicalTestId, agentID, timestamp, timestamp, timestamp);
  database.prepare("INSERT INTO test_output (test_id, stream, line, created_at) VALUES (?, 'stdout', 'historical output', ?)").run(historicalTestId, timestamp);

  const deleted = await request(base, `/api/admin/agents/${agentID}`, { method: 'DELETE' }, session);
  assert.equal(deleted.response.status, 200);
  assert.ok(database.prepare('SELECT deleted_at FROM agents WHERE id = ?').get(agentID).deleted_at);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tests WHERE agent_id = ?').get(agentID).count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM test_output WHERE test_id = ?').get(historicalTestId).count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM user_agent_permissions WHERE agent_id = ?').get(agentID).count, 0);

  const adminAgentsAfterDelete = await request(base, '/api/agents', {}, session);
  assert.ok(!adminAgentsAfterDelete.body.agents.some((agent) => agent.id === agentID));
  const userAgentsAfterDelete = await request(base, '/api/agents', {}, userSession);
  assert.ok(!userAgentsAfterDelete.body.agents.some((agent) => agent.id === agentID));
  const testsAfterDelete = await request(base, '/api/tests', {}, session);
  const preservedTest = testsAfterDelete.body.tests.find((item) => item.id === historicalTestId);
  assert.equal(preservedTest.agentName, "CI Agent's node");
  assert.equal(preservedTest.agentDeleted, true);
  const deletedInstall = await request(base, `/api/admin/agents/${agentID}/install`, { method: 'POST', body: '{}' }, session);
  assert.equal(deletedInstall.response.status, 404);
  const deletedAgain = await request(base, `/api/admin/agents/${agentID}`, { method: 'DELETE' }, session);
  assert.equal(deletedAgain.response.status, 404);
});
