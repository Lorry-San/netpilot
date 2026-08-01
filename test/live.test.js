import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { request as rawHttpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
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

function rawJson(port, path, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = rawHttpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolveRequest({ status: res.statusCode, body: data ? JSON.parse(data) : {} }); }
        catch (error) { rejectRequest(error); }
      });
    });
    req.on('error', rejectRequest);
    if (body) req.write(body);
    req.end();
  });
}

function waitForMessage(socket, predicate, timeoutMs = 3000, label = 'ws message') {
  return new Promise((resolveWait, rejectWait) => {
    const cleanup = () => { clearTimeout(timer); socket.off('message', onMessage); };
    const timer = setTimeout(() => { cleanup(); rejectWait(new Error(`timed out waiting for ${label}`)); }, timeoutMs);
    const onMessage = (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (predicate(message)) { cleanup(); resolveWait(message); }
    };
    socket.on('message', onMessage);
  });
}

test('install commands follow request host and UI websocket streams task events', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'netpilot-live-'));
  const dbPath = join(directory, 'test.sqlite');
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const root = resolve(import.meta.dirname, '..');
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), PUBLIC_BASE_URL: base, DB_PATH: dbPath, ADMIN_PASSWORD: 'Live-Test-Password-2026' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', (chunk) => console.error('[server-stderr]', chunk.toString().trim()));
  child.on('exit', (code) => console.error('[server-exit]', code));
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolvePromise) => setTimeout(resolvePromise, 2000))]);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await waitForServer(child);

  const login = await request(base, '/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'Live-Test-Password-2026' }) });
  const session = login.response.headers.get('set-cookie').split(';', 1)[0];

  const hostAgent = await rawJson(port, '/api/admin/agents', {
    method: 'POST',
    headers: { host: 'netpilot.example.com', cookie: session, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Host Agent' })
  });
  assert.equal(hostAgent.status, 201);
  assert.match(hostAgent.body.install.script, /http:\/\/netpilot\.example\.com\/install-agent\.sh/);
  assert.match(hostAgent.body.install.docker, /ws:\/\/netpilot\.example\.com\/ws\/agent/);

  const created = await request(base, '/api/admin/agents', { method: 'POST', body: JSON.stringify({ name: 'Live Agent' }) }, session);
  const agentID = created.body.agent.id;
  const token = created.body.install.token;

  const agentSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
  sockets.push(agentSocket);
  await once(agentSocket, 'open');
  agentSocket.send(JSON.stringify({ type: 'agent.auth', token, payload: { agentId: agentID, os: 'linux', arch: 'amd64' } }));
  await waitForMessage(agentSocket, (message) => message.type === 'agent.auth.ok', 3000, 'agent.auth.ok');

  const uiSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/ui`, { headers: { cookie: session } });
  sockets.push(uiSocket);
  await once(uiSocket, 'open');

  const viewer = await request(base, '/api/users', { method: 'POST', body: JSON.stringify({ username: 'viewer', displayName: 'Viewer', password: 'Viewer-Password-2026', role: 'user', agentIds: [] }) }, session);
  assert.equal(viewer.response.status, 201);
  const viewerLogin = await request(base, '/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'viewer', password: 'Viewer-Password-2026' }) });
  const viewerSession = viewerLogin.response.headers.get('set-cookie').split(';', 1)[0];
  const viewerSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/ui`, { headers: { cookie: viewerSession } });
  sockets.push(viewerSocket);
  await once(viewerSocket, 'open');
  const viewerMessages = [];
  viewerSocket.on('message', (raw) => viewerMessages.push(JSON.parse(raw.toString())));

  const taskStartWait = waitForMessage(agentSocket, (message) => message.type === 'task.start', 3000, 'task.start');
  const started = await request(base, '/api/tests', { method: 'POST', body: JSON.stringify({ agentId: agentID, target: '127.0.0.1', port: 5201, protocol: 'tcp', duration: 5, parallel: 1 }) }, session);
  assert.equal(started.response.status, 201);
  const taskId = started.body.test.id;

  const taskStart = await taskStartWait;
  assert.equal(taskStart.taskId, taskId);
  assert.equal(taskStart.payload.target, '127.0.0.1');

  agentSocket.send(JSON.stringify({ type: 'task.stdout', taskId, payload: { line: '[  5] 0.00-1.00 sec 110 MBytes 923 Mbits/sec' } }));
  agentSocket.send(JSON.stringify({ type: 'task.metric', taskId, payload: { second: 1, sendMbps: 923, recvMbps: 923 } }));
  const liveLine = await waitForMessage(uiSocket, (message) => message.type === 'task.stdout' && message.taskId === taskId, 3000, 'ui task.stdout');
  assert.match(liveLine.payload.line, /923 Mbits\/sec/);
  const liveMetric = await waitForMessage(uiSocket, (message) => message.type === 'task.metric' && message.taskId === taskId, 3000, 'ui task.metric');
  assert.equal(liveMetric.payload.sendMbps, 923);

  agentSocket.send(JSON.stringify({ type: 'task.done', taskId, payload: { exitCode: 0, durationMs: 5000 } }));
  const liveDone = await waitForMessage(uiSocket, (message) => message.type === 'task.done' && message.taskId === taskId, 3000, 'ui task.done');
  assert.equal(liveDone.payload.status, 'completed');

  agentSocket.send(JSON.stringify({ type: 'task.stdout', taskId, payload: { line: 'post-completion-line' } }));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 600));
  assert.equal(viewerMessages.filter((message) => message.taskId === taskId).length, 0);
});
