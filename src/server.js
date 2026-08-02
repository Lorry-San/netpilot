import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { all, db, get, now, run, transaction } from './db.js';
import { hashPassword, hashToken, randomToken, verifyPassword } from './crypto.js';

const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicDir = join(rootDir, 'public');
const port = Number(process.env.PORT || 8080);
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
const githubRepo = process.env.GITHUB_REPO || 'Lorry-San/netpilot';
const sessionTtlMs = 24 * 60 * 60 * 1000;
const agentConnections = new Map();
const agentUpdateJobs = new Map();
const agentUpdateByAgent = new Map();
const uiClients = new Set();

function broadcastTask(task, message) {
  const data = JSON.stringify(message);
  for (const client of uiClients) {
    if (client.role !== 'admin' && client.userId !== task.user_id) continue;
    if (client.socket.readyState === WebSocket.OPEN) client.socket.send(data);
  }
}

function broadcastAgentUpdate(agentId, payload) {
  const data = JSON.stringify({ type: 'agent.update', agentId, payload });
  for (const client of uiClients) {
    if (client.role !== 'admin') continue;
    if (client.socket.readyState === WebSocket.OPEN) client.socket.send(data);
  }
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }));
}

async function bodyJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function audit(userId, action, target, details = {}) {
  run('INSERT INTO audit_logs (user_id, action, target, details_json, created_at) VALUES (?, ?, ?, ?, ?)', userId || null, action, target || null, JSON.stringify(details), now());
}

function cookie(name, value, maxAge) {
  const secure = publicBaseUrl.startsWith('https://') ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

async function seedAdmin() {
  if (get('SELECT id FROM users WHERE id = 1')) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  let password = process.env.ADMIN_PASSWORD;
  if (!password || password.length < 12) {
    password = randomToken(18);
    console.warn(`[netpilot] ADMIN_PASSWORD was not set to a 12+ character value. Generated password for uid=1: ${password}`);
  }
  const timestamp = now();
  run('INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at) VALUES (1, ?, ?, ?, \'admin\', ?, ?)', username, '系统管理员', await hashPassword(password), timestamp, timestamp);
}

async function sessionUser(req) {
  const sessionToken = parseCookies(req).netpilot_session;
  if (!sessionToken) return null;
  return get(`SELECT u.id, u.username, u.display_name, u.role, u.disabled
              FROM sessions s JOIN users u ON u.id = s.user_id
              WHERE s.token_hash = ? AND s.expires_at > ?`, hashToken(sessionToken), now());
}

function requireUser(user) {
  if (!user || user.disabled) throw Object.assign(new Error('Authentication required'), { status: 401 });
  return user;
}

function requireAdmin(user) {
  requireUser(user);
  if (user.role !== 'admin') throw Object.assign(new Error('Administrator role required'), { status: 403 });
  return user;
}

function canUseAgent(user, agentId) {
  if (user.role === 'admin') return true;
  return Boolean(get(`SELECT 1 FROM user_agent_permissions p
                      JOIN agents a ON a.id = p.agent_id
                      WHERE p.user_id = ? AND p.agent_id = ? AND a.deleted_at IS NULL`, user.id, agentId));
}

function agentView(agent) {
  return {
    id: agent.id,
    name: agent.name,
    status: agent.status,
    os: agent.os,
    arch: agent.arch,
    version: agent.version,
    publicIp: agent.public_ip,
    ipLocation: agent.ip_location,
    cpuPercent: agent.cpu_percent,
    memoryPercent: agent.memory_percent,
    uploadPercent: agent.upload_percent,
    downloadPercent: agent.download_percent,
    lastSeenAt: agent.last_seen_at,
    createdAt: agent.created_at
  };
}

function userAgentIds(userId) {
  return all(`SELECT p.agent_id
              FROM user_agent_permissions p
              JOIN agents a ON a.id = p.agent_id
              WHERE p.user_id = ? AND a.deleted_at IS NULL
              ORDER BY a.name`, userId).map((row) => row.agent_id);
}

function userView(user, includeAgentIds = false) {
  const view = {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    disabled: Boolean(user.disabled),
    createdAt: user.created_at,
    updatedAt: user.updated_at
  };
  if (includeAgentIds) view.agentIds = user.role === 'user' ? userAgentIds(user.id) : [];
  return view;
}

function validateDisplayName(displayName) {
  const value = String(displayName || '').trim();
  if (value.length < 1 || value.length > 80) return null;
  return value;
}

function replaceUserAgentPermissions(userId, agentIds) {
  run('DELETE FROM user_agent_permissions WHERE user_id = ?', userId);
  if (!Array.isArray(agentIds)) return;
  for (const agentId of agentIds) {
    run(`INSERT OR IGNORE INTO user_agent_permissions (user_id, agent_id)
         SELECT ?, id FROM agents WHERE id = ? AND deleted_at IS NULL`, userId, String(agentId));
  }
}

const currentVersion = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).version || '0.0.0';

function getSettings() {
  return Object.fromEntries(all('SELECT key, value FROM settings').map((row) => [row.key, row.value]));
}

function setSetting(key, value) {
  run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', key, value, now());
}

function normalizeBaseUrl(value, schemes) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    const scheme = parsed.protocol.slice(0, -1);
    if (!schemes.includes(scheme) || !parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return `${scheme}://${parsed.host}`;
  } catch {
    return null;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((part) => Number(part) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const diff = (pa[index] || 0) - (pb[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

let latestReleaseCache = { checkedAt: 0, data: null };
async function fetchLatestRelease() {
  const nowMs = Date.now();
  if (latestReleaseCache.checkedAt && nowMs - latestReleaseCache.checkedAt < 30 * 60 * 1000) return latestReleaseCache.data;
  latestReleaseCache.checkedAt = nowMs;
  try {
    const settings = getSettings();
    const accel = settings.github_accel_enabled === '1' ? String(settings.github_accel_domain || '').trim() : '';
    const apiUrl = `https://api.github.com/repos/${githubRepo}/releases/latest`;
    const url = accel ? `${accel.endsWith('/') ? accel : `${accel}/`}${apiUrl}` : apiUrl;
    const response = await fetch(url, { headers: { 'user-agent': 'netpilot-version-check', accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error(`GitHub responded ${response.status}`);
    const data = await response.json();
    latestReleaseCache.data = { tag: String(data.tag_name || ''), url: String(data.html_url || ''), publishedAt: String(data.published_at || '') };
  } catch {
    if (!latestReleaseCache.data) latestReleaseCache.data = null;
  }
  return latestReleaseCache.data;
}

function requestBaseUrl(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const proto = forwardedProto === 'https' ? 'https' : 'http';
  const host = String(req.headers.host || '').trim();
  if (!/^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/.test(host)) return publicBaseUrl;
  return `${proto}://${host}`;
}

function installCommands(agent, token, baseUrl = publicBaseUrl) {
  const settings = getSettings();
  const wsBase = settings.agent_ws_base || baseUrl.replace(/^http/, 'ws');
  const scriptBase = settings.script_base || baseUrl;
  const wsUrl = `${wsBase}/ws/agent`;
  const image = `ghcr.io/${githubRepo.toLowerCase()}/netpilot-agent:latest`;
  const script = `${scriptBase}/install-agent.sh`;
  const accel = settings.github_accel_enabled === '1' ? String(settings.github_accel_domain || '').trim() : '';
  const environment = [
    `NETPILOT_REPO=${shellQuote(githubRepo)}`,
    accel ? `NETPILOT_GITHUB_ACCEL=${shellQuote(accel.endsWith('/') ? accel : `${accel}/`)}` : '',
    `NETPILOT_SERVER=${shellQuote(wsUrl)}`,
    `NETPILOT_TOKEN=${shellQuote(token)}`,
    `NETPILOT_AGENT_ID=${shellQuote(agent.id)}`,
    `NETPILOT_AGENT_NAME=${shellQuote(agent.name)}`
  ].filter(Boolean).join(' ');
  return {
    token,
    docker: `docker run -d --name netpilot-agent --restart unless-stopped \\\n  -e NETPILOT_SERVER=${shellQuote(wsUrl)} \\\n  -e NETPILOT_TOKEN=${shellQuote(token)} \\\n  -e NETPILOT_AGENT_ID=${shellQuote(agent.id)} \\\n  -e NETPILOT_AGENT_NAME=${shellQuote(agent.name)} ${shellQuote(image)}`,
    script: `curl -fsSL ${shellQuote(script)} | env ${environment} sh`,
    binary: `${environment} ./netpilot-agent`
  };
}

function agentUpdateCommand(baseUrl = publicBaseUrl) {
  const settings = getSettings();
  const scriptBase = settings.script_base || baseUrl;
  const script = `${scriptBase}/update-agent.sh`;
  const accel = settings.github_accel_enabled === '1' ? String(settings.github_accel_domain || '').trim() : '';
  const environment = [
    `NETPILOT_REPO=${shellQuote(githubRepo)}`,
    accel ? `NETPILOT_GITHUB_ACCEL=${shellQuote(accel.endsWith('/') ? accel : `${accel}/`)}` : ''
  ].filter(Boolean).join(' ');
  return `(tmp="$(mktemp)" && trap 'rm -f "$tmp"' EXIT HUP INT TERM && curl -fsSL ${shellQuote(script)} -o "$tmp" && env ${environment} sh "$tmp")`;
}

function agentUpdatePayload(baseUrl = publicBaseUrl) {
  const settings = getSettings();
  const scriptBase = settings.script_base || baseUrl;
  const accel = settings.github_accel_enabled === '1' ? String(settings.github_accel_domain || '').trim() : '';
  return {
    scriptUrl: `${scriptBase}/update-agent.sh`,
    repo: githubRepo,
    githubAccel: accel ? (accel.endsWith('/') ? accel : `${accel}/`) : ''
  };
}

function completeAgentUpdate(updateId, success, details = {}) {
  const job = agentUpdateJobs.get(updateId);
  if (!job) return;
  clearTimeout(job.timer);
  agentUpdateJobs.delete(updateId);
  if (agentUpdateByAgent.get(job.agentId) === updateId) agentUpdateByAgent.delete(job.agentId);
  const agent = get('SELECT * FROM agents WHERE id = ?', job.agentId);
  const newVersion = String(details.newVersion || agent?.version || job.oldVersion || '');
  const status = agentConnections.has(job.agentId) ? 'online' : 'offline';
  run('UPDATE agents SET status = ?, version = COALESCE(NULLIF(?, \'\'), version), updated_at = ? WHERE id = ?', status, success && newVersion !== 'unknown' ? newVersion : '', now(), job.agentId);
  const payload = {
    id: updateId,
    status: success ? 'success' : 'failed',
    success,
    agentId: job.agentId,
    agentName: agent?.name || job.agentName || job.agentId,
    oldVersion: job.oldVersion || '',
    newVersion,
    error: details.error || '',
    output: details.output || job.output.slice(-30).join('\n')
  };
  broadcastAgentUpdate(job.agentId, payload);
  audit(job.userId, success ? 'agent.update.success' : 'agent.update.failed', job.agentId, { oldVersion: payload.oldVersion, newVersion: payload.newVersion, error: payload.error });
}

function maybeCompleteReconnectUpdate(agentId, newVersion) {
  const updateId = agentUpdateByAgent.get(agentId);
  const job = updateId ? agentUpdateJobs.get(updateId) : null;
  const versionText = String(newVersion || '');
  if (!job || !versionText || !job.oldVersion || versionText === job.oldVersion) return;
  completeAgentUpdate(updateId, true, { newVersion: versionText, output: 'Agent reconnected after the updater restarted the service.' });
}

function handleAgentUpdateMessage(agentId, message) {
  const updateId = message.taskId || message.payload?.updateId;
  const job = updateId ? agentUpdateJobs.get(updateId) : null;
  if (!job || job.agentId !== agentId) return;
  const payload = message.payload || {};
  if (message.type === 'agent.update.started') {
    job.output.push('Agent accepted the automatic update request.');
    broadcastAgentUpdate(agentId, {
      id: updateId,
      status: 'running',
      success: null,
      agentId,
      agentName: job.agentName,
      oldVersion: job.oldVersion || payload.oldVersion || '',
      newVersion: '',
      error: '',
      output: job.output.slice(-30).join('\n')
    });
    return;
  }
  if (message.type === 'agent.update.output') {
    const line = String(payload.line || '').slice(0, 1000);
    if (line) job.output.push(line);
    return;
  }
  if (message.type === 'agent.update.done') {
    const exitCode = Number(payload.exitCode ?? 1);
    completeAgentUpdate(updateId, exitCode === 0, {
      newVersion: String(payload.newVersion || ''),
      error: exitCode === 0 ? '' : String(payload.error || `updater exited with ${exitCode}`),
      output: job.output.slice(-30).join('\n')
    });
  }
}

function startAgentUpdate(user, agent, baseUrl) {
  if (agent.status === 'busy') throw Object.assign(new Error('Agent 正在执行任务，任务结束后再自动更新'), { status: 409 });
  if (agentUpdateByAgent.has(agent.id)) throw Object.assign(new Error('该 Agent 已有自动更新任务正在进行'), { status: 409 });
  const connection = agentConnections.get(agent.id);
  if (!connection || connection.readyState !== WebSocket.OPEN) throw Object.assign(new Error('Agent 不在线，无法自动更新；请使用手动更新命令'), { status: 409 });
  const updateId = `update_${randomToken(12)}`;
  const job = {
    id: updateId,
    userId: user.id,
    agentId: agent.id,
    agentName: agent.name,
    oldVersion: agent.version || 'unknown',
    output: [],
    timer: setTimeout(() => completeAgentUpdate(updateId, false, { error: '自动更新超时：Agent 未在限定时间内回报结果或新版本连接' }), 180000)
  };
  job.timer.unref?.();
  agentUpdateJobs.set(updateId, job);
  agentUpdateByAgent.set(agent.id, updateId);
  run('UPDATE agents SET status = \'busy\', updated_at = ? WHERE id = ?', now(), agent.id);
  const sent = sendAgent(agent.id, { type: 'agent.update.start', taskId: updateId, payload: { ...agentUpdatePayload(baseUrl), oldVersion: job.oldVersion } });
  if (!sent) {
    completeAgentUpdate(updateId, false, { error: 'Agent 连接在自动更新下发前断开' });
    throw Object.assign(new Error('Agent 已断开，自动更新未下发'), { status: 409 });
  }
  broadcastAgentUpdate(agent.id, {
    id: updateId,
    status: 'queued',
    success: null,
    agentId: agent.id,
    agentName: agent.name,
    oldVersion: job.oldVersion,
    newVersion: '',
    error: '',
    output: ''
  });
  audit(user.id, 'agent.update.auto', agent.id, { oldVersion: job.oldVersion });
  return { id: updateId, status: 'queued', oldVersion: job.oldVersion };
}

function createAgent(name, baseUrl) {
  const id = `agent_${randomToken(9)}`;
  const token = randomToken(32);
  const timestamp = now();
  run(`INSERT INTO agents (id, name, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, id, name, hashToken(token), timestamp, timestamp);
  return { agent: get('SELECT * FROM agents WHERE id = ?', id), commands: installCommands({ id, name }, token, baseUrl) };
}

function rotateAgentToken(agent, baseUrl) {
  const token = randomToken(32);
  run('UPDATE agents SET token_hash = ?, updated_at = ? WHERE id = ?', hashToken(token), now(), agent.id);
  return installCommands(agent, token, baseUrl);
}

function remoteIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().replace(/^::ffff:/, '');
}

function sendAgent(agentId, message) {
  const connection = agentConnections.get(agentId);
  if (!connection || connection.readyState !== WebSocket.OPEN) return false;
  connection.send(JSON.stringify(message));
  return true;
}

function taskView(task) {
  const agent = get('SELECT name, deleted_at FROM agents WHERE id = ?', task.agent_id);
  return {
    id: task.id,
    agentId: task.agent_id,
    agentName: agent?.name || '',
    agentDeleted: Boolean(agent?.deleted_at),
    target: task.target,
    port: task.port,
    protocol: task.protocol,
    reverse: Boolean(task.reverse),
    duration: task.duration,
    parallel: task.parallel,
    bandwidth: task.bandwidth,
    status: task.status,
    startedAt: task.started_at,
    finishedAt: task.finished_at,
    createdAt: task.created_at,
    output: all('SELECT stream, line, created_at AS createdAt FROM test_output WHERE test_id = ? ORDER BY id ASC', task.id),
    metrics: all('SELECT second, send_mbps AS sendMbps, recv_mbps AS recvMbps, cpu_percent AS cpuPercent, memory_percent AS memoryPercent FROM test_metrics WHERE test_id = ? ORDER BY second ASC', task.id)
  };
}

function handleAgentMessage(socket, agentId, message) {
  const type = message.type;
  if (type === 'agent.heartbeat') {
    const payload = message.payload || {};
    run(`UPDATE agents SET status = CASE WHEN status = 'busy' THEN 'busy' ELSE 'online' END,
      cpu_percent = ?, memory_percent = ?, upload_percent = ?, download_percent = ?,
      public_ip = COALESCE(NULLIF(?, ''), public_ip), ip_location = COALESCE(NULLIF(?, ''), ip_location),
      last_seen_at = ?, updated_at = ? WHERE id = ?`,
    Number(payload.cpuPercent || 0), Number(payload.memoryPercent || 0), Number(payload.uploadPercent || 0), Number(payload.downloadPercent || 0), payload.publicIp || '', payload.ipLocation || '', now(), now(), agentId);
    return;
  }
  if (type === 'agent.info') {
    const payload = message.payload || {};
    run('UPDATE agents SET os = ?, arch = ?, version = ?, public_ip = COALESCE(NULLIF(?, \'\'), public_ip), ip_location = COALESCE(NULLIF(?, \'\'), ip_location), last_seen_at = ?, updated_at = ? WHERE id = ?', payload.os || 'linux', payload.arch || 'unknown', payload.version || '', payload.publicIp || '', payload.ipLocation || '', now(), now(), agentId);
    maybeCompleteReconnectUpdate(agentId, payload.version);
    return;
  }
  if (type.startsWith('agent.update.')) {
    handleAgentUpdateMessage(agentId, message);
    return;
  }
  const taskId = message.taskId || message.payload?.taskId;
  if (!taskId) return;
  const task = get('SELECT * FROM tests WHERE id = ? AND agent_id = ?', taskId, agentId);
  if (!task) return;
  if (type === 'task.stdout' || type === 'task.stderr') {
    const line = String(message.payload?.line ?? message.line ?? '');
    run('INSERT INTO test_output (test_id, stream, line, created_at) VALUES (?, ?, ?, ?)', taskId, type === 'task.stderr' ? 'stderr' : 'stdout', line, now());
    broadcastTask(task, { type, taskId, payload: { line } });
  } else if (type === 'task.metric') {
    const p = message.payload || {};
    run('INSERT INTO test_metrics (test_id, second, send_mbps, recv_mbps, cpu_percent, memory_percent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', taskId, Number(p.second || 0), p.sendMbps ?? null, p.recvMbps ?? null, p.cpuPercent ?? null, p.memoryPercent ?? null, now());
    broadcastTask(task, { type, taskId, payload: p });
  } else if (type === 'task.done') {
    const status = message.payload?.exitCode === 0 ? 'completed' : 'failed';
    run('UPDATE tests SET status = ?, finished_at = ?, result_json = ? WHERE id = ?', status, now(), JSON.stringify(message.payload || {}), taskId);
    run('UPDATE agents SET status = \'online\', updated_at = ? WHERE id = ?', now(), agentId);
    broadcastTask(task, { type, taskId, payload: { ...(message.payload || {}), status } });
  } else if (type === 'task.error') {
    run('UPDATE tests SET status = \'failed\', finished_at = ?, result_json = ? WHERE id = ?', now(), JSON.stringify(message.payload || {}), taskId);
    run('UPDATE agents SET status = \'online\', updated_at = ? WHERE id = ?', now(), agentId);
    broadcastTask(task, { type, taskId, payload: { ...(message.payload || {}), status: 'failed' } });
  }
}

function handleAgentSocket(socket, req) {
  let agentId = null;
  let authenticated = false;
  const authTimer = setTimeout(() => socket.close(4001, 'authentication timeout'), 10000);
  socket.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { socket.close(4002, 'invalid message'); return; }
    if (!authenticated) {
      if (message.type !== 'agent.auth') { socket.close(4003, 'authentication required'); return; }
      const token = message.token || message.payload?.token;
      const agent = token ? get('SELECT * FROM agents WHERE token_hash = ? AND deleted_at IS NULL', hashToken(token)) : null;
      if (!agent) { socket.close(4003, 'invalid token'); return; }
      const current = agentConnections.get(agent.id);
      if (current && current.readyState === WebSocket.OPEN) { socket.close(4004, 'agent already connected'); return; }
      authenticated = true;
      clearTimeout(authTimer);
      agentId = agent.id;
      agentConnections.set(agentId, socket);
      const payload = message.payload || {};
      run(`UPDATE agents SET status = 'online', os = ?, arch = ?, version = ?, public_ip = ?, last_seen_at = ?, updated_at = ? WHERE id = ?`, payload.os || 'linux', payload.arch || 'unknown', payload.version || '', remoteIp(req), now(), now(), agentId);
      maybeCompleteReconnectUpdate(agentId, payload.version);
      socket.send(JSON.stringify({ type: 'agent.auth.ok', agentId, serverTime: now() }));
      return;
    }
    handleAgentMessage(socket, agentId, message);
  });
  socket.on('close', () => {
    clearTimeout(authTimer);
    if (!agentId || agentConnections.get(agentId) !== socket) return;
    agentConnections.delete(agentId);
    run('UPDATE agents SET status = \'offline\', updated_at = ? WHERE id = ?', now(), agentId);
    const active = get('SELECT id FROM tests WHERE agent_id = ? AND status IN (\'queued\', \'running\')', agentId);
    if (active) run('UPDATE tests SET status = \'failed\', finished_at = ?, result_json = ? WHERE id = ?', now(), JSON.stringify({ error: 'Agent disconnected' }), active.id);
  });
}

function serveStatic(req, res, pathname) {
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  const target = resolve(publicDir, file);
  if (!target.startsWith(publicDir) || !existsSync(target)) return false;
  const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.sh': 'text/plain; charset=utf-8' };
  res.writeHead(200, { 'content-type': contentTypes[extname(target)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(readFileSync(target));
  return true;
}

async function handleApi(req, res, pathname) {
  const user = await sessionUser(req);
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const body = await bodyJson(req);
    const found = get('SELECT * FROM users WHERE username = ?', String(body.username || ''));
    if (!found || found.disabled || !(await verifyPassword(String(body.password || ''), found.password_hash))) return json(res, 401, { error: '用户名或密码错误' });
    const sessionToken = randomToken(32);
    run('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', hashToken(sessionToken), found.id, new Date(Date.now() + sessionTtlMs).toISOString(), now());
    audit(found.id, 'auth.login', `user:${found.id}`);
    return json(res, 200, { user: userView(found) }, { 'set-cookie': cookie('netpilot_session', sessionToken, sessionTtlMs / 1000) });
  }
  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const sessionToken = parseCookies(req).netpilot_session;
    if (sessionToken) run('DELETE FROM sessions WHERE token_hash = ?', hashToken(sessionToken));
    return json(res, 200, { ok: true }, { 'set-cookie': cookie('netpilot_session', '', 0) });
  }
  if (req.method === 'GET' && pathname === '/api/me') return json(res, 200, { user: user ? userView(user) : null });
  requireUser(user);
  if (req.method === 'PATCH' && pathname === '/api/me') {
    const body = await bodyJson(req);
    const displayName = body.displayName === undefined ? user.display_name : validateDisplayName(body.displayName);
    if (!displayName) return json(res, 400, { error: '显示名称无效' });
    const fullUser = get('SELECT * FROM users WHERE id = ?', user.id);
    let passwordHash = fullUser.password_hash;
    if (body.newPassword) {
      if (String(body.newPassword).length < 12) return json(res, 400, { error: '新密码至少需要 12 个字符' });
      if (!(await verifyPassword(String(body.currentPassword || ''), fullUser.password_hash))) return json(res, 403, { error: '当前密码不正确' });
      passwordHash = await hashPassword(String(body.newPassword));
    }
    run('UPDATE users SET display_name = ?, password_hash = ?, updated_at = ? WHERE id = ?', displayName, passwordHash, now(), user.id);
    audit(user.id, 'user.self.update', `user:${user.id}`, { passwordChanged: Boolean(body.newPassword) });
    return json(res, 200, { user: userView(get('SELECT * FROM users WHERE id = ?', user.id)) });
  }
  if (req.method === 'GET' && pathname === '/api/system/version') {
    const refreshRequested = new URL(req.url, 'http://localhost').searchParams.get('refresh') === '1';
    if (refreshRequested && user.id === 1) latestReleaseCache.checkedAt = 0;
    const latest = await fetchLatestRelease();
    const latestVersion = latest?.tag ? latest.tag.replace(/^v/, '') : null;
    return json(res, 200, {
      current: currentVersion,
      latest: latestVersion,
      updateAvailable: latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : null,
      releaseUrl: latest?.url || '',
      checkedAt: latestReleaseCache.checkedAt ? new Date(latestReleaseCache.checkedAt).toISOString() : null
    });
  }
  if (pathname === '/api/settings') {
    if (user.id !== 1) return json(res, 403, { error: '只有系统管理员（uid=1）可以访问系统设置' });
    if (req.method === 'GET') {
      const settings = getSettings();
      return json(res, 200, {
        settings: {
          agentWsBase: settings.agent_ws_base || '',
          scriptBase: settings.script_base || '',
          githubAccelEnabled: settings.github_accel_enabled === '1',
          githubAccelDomain: settings.github_accel_domain || ''
        }
      });
    }
    if (req.method === 'PUT') {
      const body = await bodyJson(req);
      const agentWsBase = normalizeBaseUrl(body.agentWsBase, ['ws', 'wss']);
      const scriptBase = normalizeBaseUrl(body.scriptBase, ['http', 'https']);
      const githubAccelDomain = normalizeBaseUrl(body.githubAccelDomain, ['http', 'https']);
      if (agentWsBase === null) return json(res, 400, { error: 'WS 连接地址格式无效，示例：wss://iperf.example.com 或 ws://1.2.3.4:8080' });
      if (scriptBase === null) return json(res, 400, { error: '脚本拉取地址格式无效，示例：https://iperf.example.com 或 http://1.2.3.4:8080' });
      if (githubAccelDomain === null) return json(res, 400, { error: 'GitHub 加速域名格式无效，示例：https://ghproxy.net' });
      const enabled = Boolean(body.githubAccelEnabled);
      if (enabled && !githubAccelDomain) return json(res, 400, { error: '启用 GitHub 加速时必须填写加速域名' });
      setSetting('agent_ws_base', agentWsBase);
      setSetting('script_base', scriptBase);
      setSetting('github_accel_enabled', enabled ? '1' : '0');
      setSetting('github_accel_domain', githubAccelDomain);
      latestReleaseCache.checkedAt = 0;
      audit(user.id, 'settings.update', 'settings', { agentWsBase, scriptBase, githubAccelEnabled: enabled, githubAccelDomain });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: 'Method not allowed' });
  }
  if (req.method === 'GET' && pathname === '/api/agents') {
    const rows = user.role === 'admin'
      ? all('SELECT * FROM agents WHERE deleted_at IS NULL ORDER BY name')
      : all('SELECT a.* FROM agents a JOIN user_agent_permissions p ON p.agent_id = a.id WHERE p.user_id = ? AND a.deleted_at IS NULL ORDER BY a.name', user.id);
    return json(res, 200, { agents: rows.map(agentView) });
  }
  if (req.method === 'GET' && pathname === '/api/tests') {
    const rows = user.role === 'admin' ? all('SELECT * FROM tests ORDER BY created_at DESC LIMIT 50') : all('SELECT * FROM tests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', user.id);
    return json(res, 200, { tests: rows.map(taskView) });
  }
  if (req.method === 'POST' && pathname === '/api/tests') {
    const body = await bodyJson(req);
    const agent = get('SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL', String(body.agentId || ''));
    if (!agent || !canUseAgent(user, agent.id)) return json(res, 403, { error: '无权使用该 Agent' });
    if (agent.status === 'offline') return json(res, 409, { error: 'Agent 当前离线' });
    if (agent.status === 'busy') return json(res, 409, { error: 'Agent 正在执行其他任务' });
    const target = String(body.target || '').trim();
    const portValue = Number(body.port || 5201);
    const duration = Number(body.duration || 15);
    const parallel = Number(body.parallel || 1);
    const protocol = body.protocol === 'udp' ? 'udp' : 'tcp';
    if (!target || !Number.isInteger(portValue) || portValue < 1 || portValue > 65535 || !Number.isInteger(duration) || duration < 1 || duration > 3600 || !Number.isInteger(parallel) || parallel < 1 || parallel > 32) return json(res, 400, { error: '测试参数无效' });
    const id = `test_${randomToken(12)}`;
    const created = now();
    run('INSERT INTO tests (id, user_id, agent_id, target, port, protocol, reverse, duration, parallel, bandwidth, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'running\', ?)', id, user.id, agent.id, target, portValue, protocol, body.reverse ? 1 : 0, duration, parallel, body.bandwidth || null, created);
    run('UPDATE agents SET status = \'busy\', updated_at = ? WHERE id = ?', now(), agent.id);
    const sent = sendAgent(agent.id, { type: 'task.start', taskId: id, payload: { target, port: portValue, protocol, reverse: Boolean(body.reverse), duration, parallel, bandwidth: body.bandwidth || '' } });
    if (!sent) {
      run('UPDATE tests SET status = \'failed\', finished_at = ?, result_json = ? WHERE id = ?', now(), JSON.stringify({ error: 'Agent disconnected before task dispatch' }), id);
      run('UPDATE agents SET status = \'offline\', updated_at = ? WHERE id = ?', now(), agent.id);
      return json(res, 409, { error: 'Agent 已断开，任务未下发' });
    }
    audit(user.id, 'test.create', id, { agentId: agent.id, target, protocol });
    return json(res, 201, { test: taskView(get('SELECT * FROM tests WHERE id = ?', id)) });
  }
  const testCancel = pathname.match(/^\/api\/tests\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && testCancel) {
    const task = get('SELECT * FROM tests WHERE id = ?', testCancel[1]);
    if (!task || (user.role !== 'admin' && task.user_id !== user.id)) return json(res, 404, { error: '任务不存在' });
    if (['completed', 'failed', 'cancelled', 'timeout'].includes(task.status)) return json(res, 200, { test: taskView(task) });
    sendAgent(task.agent_id, { type: 'task.cancel', taskId: task.id });
    run('UPDATE tests SET status = \'cancelled\', finished_at = ? WHERE id = ?', now(), task.id);
    run('UPDATE agents SET status = \'online\', updated_at = ? WHERE id = ?', now(), task.agent_id);
    return json(res, 200, { test: taskView(get('SELECT * FROM tests WHERE id = ?', task.id)) });
  }
  if (req.method === 'GET' && pathname === '/api/users') {
    requireAdmin(user);
    return json(res, 200, { users: all('SELECT * FROM users ORDER BY id').map((row) => userView(row, true)) });
  }
  if (req.method === 'POST' && pathname === '/api/users') {
    requireAdmin(user);
    const body = await bodyJson(req);
    const username = String(body.username || '').trim();
    const displayName = String(body.displayName || username).trim();
    const role = body.role === 'admin' ? 'admin' : 'user';
    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username) || displayName.length < 1 || displayName.length > 80) return json(res, 400, { error: '用户名或显示名称无效' });
    if (!body.password || String(body.password).length < 12) return json(res, 400, { error: '密码至少需要 12 个字符' });
    try {
      const timestamp = now();
      const passwordHash = await hashPassword(String(body.password));
      const result = transaction(() => {
        const info = run('INSERT INTO users (username, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', username, displayName, passwordHash, role, timestamp, timestamp);
        return info.lastInsertRowid;
      });
      const newUser = get('SELECT * FROM users WHERE id = ?', result);
      if (role === 'user') replaceUserAgentPermissions(result, body.agentIds);
      audit(user.id, 'user.create', `user:${result}`, { role });
      return json(res, 201, { user: userView(newUser, true) });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) return json(res, 409, { error: '用户名已存在' });
      throw error;
    }
  }
  const userMatch = pathname.match(/^\/api\/users\/(\d+)$/);
  if (req.method === 'GET' && userMatch) {
    requireAdmin(user);
    const target = get('SELECT * FROM users WHERE id = ?', Number(userMatch[1]));
    if (!target) return json(res, 404, { error: '用户不存在' });
    return json(res, 200, { user: userView(target, true) });
  }
  if (req.method === 'PATCH' && userMatch) {
    requireAdmin(user);
    const targetId = Number(userMatch[1]);
    const target = get('SELECT * FROM users WHERE id = ?', targetId);
    if (!target) return json(res, 404, { error: '用户不存在' });
    const body = await bodyJson(req);
    if (targetId === 1 && (body.role && body.role !== 'admin' || body.disabled === true)) return json(res, 400, { error: 'uid=1 系统管理员不可降权或禁用' });
    const role = body.role === 'admin' ? 'admin' : body.role === 'user' ? 'user' : target.role;
    const disabled = typeof body.disabled === 'boolean' ? (body.disabled ? 1 : 0) : target.disabled;
    const displayName = body.displayName === undefined ? target.display_name : validateDisplayName(body.displayName);
    if (!displayName) return json(res, 400, { error: '显示名称无效' });
    let passwordHash = target.password_hash;
    if (body.password) {
      if (String(body.password).length < 12) return json(res, 400, { error: '密码至少需要 12 个字符' });
      passwordHash = await hashPassword(String(body.password));
    }
    transaction(() => {
      run('UPDATE users SET display_name = ?, password_hash = ?, role = ?, disabled = ?, updated_at = ? WHERE id = ?', displayName, passwordHash, role, disabled, now(), targetId);
      if (role === 'admin') run('DELETE FROM user_agent_permissions WHERE user_id = ?', targetId);
      else if (Array.isArray(body.agentIds)) replaceUserAgentPermissions(targetId, body.agentIds);
    });
    audit(user.id, 'user.update', `user:${targetId}`, { role, disabled: Boolean(disabled), permissionsChanged: Array.isArray(body.agentIds), passwordChanged: Boolean(body.password) });
    return json(res, 200, { user: userView(get('SELECT * FROM users WHERE id = ?', targetId), true) });
  }
  if (req.method === 'DELETE' && userMatch) {
    requireAdmin(user);
    const targetId = Number(userMatch[1]);
    if (targetId === 1) return json(res, 400, { error: 'uid=1 系统管理员不可删除' });
    if (!get('SELECT id FROM users WHERE id = ?', targetId)) return json(res, 404, { error: '用户不存在' });
    run('DELETE FROM users WHERE id = ?', targetId);
    audit(user.id, 'user.delete', `user:${targetId}`);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && pathname === '/api/admin/agents') {
    requireAdmin(user);
    const body = await bodyJson(req);
    const name = String(body.name || '').trim();
    if (name.length < 1 || name.length > 80) return json(res, 400, { error: 'Agent 名称无效' });
    const created = createAgent(name, requestBaseUrl(req));
    audit(user.id, 'agent.create', created.agent.id, { name });
    return json(res, 201, { agent: agentView(created.agent), install: created.commands });
  }
  const installMatch = pathname.match(/^\/api\/admin\/agents\/([^/]+)\/install$/);
  if (req.method === 'POST' && installMatch) {
    requireAdmin(user);
    const agent = get('SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL', installMatch[1]);
    if (!agent) return json(res, 404, { error: 'Agent 不存在' });
    if (agent.status === 'online' || agentConnections.has(agent.id)) return json(res, 409, { error: 'Agent 在线时不能重新安装，请先断开 Agent' });
    const install = rotateAgentToken(agent, requestBaseUrl(req));
    audit(user.id, 'agent.token.rotate', agent.id);
    return json(res, 200, { agent: agentView(get('SELECT * FROM agents WHERE id = ?', agent.id)), install });
  }
  const updateMatch = pathname.match(/^\/api\/admin\/agents\/([^/]+)\/update-command$/);
  if (req.method === 'POST' && updateMatch) {
    requireAdmin(user);
    const agent = get('SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL', updateMatch[1]);
    if (!agent) return json(res, 404, { error: 'Agent 不存在' });
    if (agent.status === 'busy') return json(res, 409, { error: 'Agent 正在执行测试，请等待任务结束后再更新' });
    const command = agentUpdateCommand(requestBaseUrl(req));
    audit(user.id, 'agent.update.command', agent.id);
    return json(res, 200, { agent: agentView(agent), update: { command } });
  }
  const autoUpdateMatch = pathname.match(/^\/api\/admin\/agents\/([^/]+)\/update$/);
  if (req.method === 'POST' && autoUpdateMatch) {
    requireAdmin(user);
    const agent = get('SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL', autoUpdateMatch[1]);
    if (!agent) return json(res, 404, { error: 'Agent 不存在' });
    const update = startAgentUpdate(user, agent, requestBaseUrl(req));
    return json(res, 202, { agent: agentView(get('SELECT * FROM agents WHERE id = ?', agent.id)), update });
  }
  if (req.method === 'DELETE' && pathname.startsWith('/api/admin/agents/')) {
    requireAdmin(user);
    const agentId = pathname.split('/').pop();
    const agent = get('SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL', agentId);
    if (!agent) return json(res, 404, { error: 'Agent 不存在' });
    if (agent.status === 'online' || agentConnections.has(agent.id)) return json(res, 409, { error: 'Agent 在线时不能删除' });
    const deletedAt = now();
    transaction(() => {
      run('DELETE FROM user_agent_permissions WHERE agent_id = ?', agent.id);
      run('UPDATE agents SET status = \'offline\', deleted_at = ?, updated_at = ? WHERE id = ?', deletedAt, deletedAt, agent.id);
    });
    audit(user.id, 'agent.delete', agent.id);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'Not found' });
}

await seedAdmin();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'OPTIONS') return json(res, 204, {});
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url.pathname);
    if (url.pathname === '/install-agent.sh' || url.pathname === '/update-agent.sh') return serveStatic(req, res, url.pathname);
    if (serveStatic(req, res, url.pathname)) return;
    return text(res, 404, 'Not found');
  } catch (error) {
    console.error(error);
    return json(res, error.status || 500, { error: error.status ? error.message : 'Internal server error' });
  }
});

const wss = new WebSocketServer({ noServer: true });
wss.on('connection', handleAgentSocket);

const uiWss = new WebSocketServer({ noServer: true });
uiWss.on('connection', async (socket, req) => {
  const user = await sessionUser(req);
  if (!user || user.disabled) { socket.close(4401, 'authentication required'); return; }
  const client = { socket, userId: user.id, role: user.role };
  uiClients.add(client);
  const drop = () => uiClients.delete(client);
  socket.on('close', drop);
  socket.on('error', drop);
});
server.on('upgrade', (req, socket, head) => {
  let pathname;
  try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch { socket.destroy(); return; }
  if (pathname === '/ws/agent') wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  else if (pathname === '/ws/ui') uiWss.handleUpgrade(req, socket, head, (ws) => uiWss.emit('connection', ws, req));
  else socket.destroy();
});

server.listen(port, () => console.log(`[netpilot] listening on ${publicBaseUrl}`));
