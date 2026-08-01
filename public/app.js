const state = { user: null, agents: [], users: [], tests: [], activeTestId: null, pollTimer: null };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body;
}

function toast(message) {
  const target = $('#toast');
  target.textContent = message;
  target.classList.add('show');
  clearTimeout(target.timer);
  target.timer = setTimeout(() => target.classList.remove('show'), 2600);
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function cell(value) {
  const td = document.createElement('td');
  if (value instanceof Node) td.appendChild(value); else td.textContent = String(value ?? '');
  return td;
}

function button(label, className, handler, disabled = false) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  node.disabled = disabled;
  node.addEventListener('click', handler);
  return node;
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString('zh-CN') : '--';
}

function roleLabel(role) {
  return role === 'admin' ? '管理员' : '普通用户';
}

function statusLabel(status) {
  return { online: '在线', offline: '离线', busy: '测试中', running: '运行中', queued: '排队中', completed: '已完成', failed: '失败', cancelled: '已取消', timeout: '超时' }[status] || status;
}

function percentText(value) {
  return value === null || value === undefined || Number.isNaN(Number(value)) ? '--' : `${Number(value).toFixed(1)}%`;
}

function appendOutput(line) {
  const output = $('#raw-output');
  if (output.dataset.streaming !== '1') { output.textContent = ''; output.dataset.streaming = '1'; }
  output.textContent += `${line}\n`;
  output.scrollTop = output.scrollHeight;
}

function handleLiveMessage(message) {
  const taskId = message.taskId;
  if (!taskId) return;
  const test = state.tests.find((item) => item.id === taskId);
  if (test && !state.activeTestId) state.activeTestId = taskId;
  if (message.type === 'task.stdout' || message.type === 'task.stderr') {
    const line = String(message.payload?.line ?? '');
    if (test) test.output.push({ stream: message.type === 'task.stderr' ? 'stderr' : 'stdout', line });
    if (state.activeTestId === taskId) appendOutput(line);
  } else if (message.type === 'task.metric') {
    if (test) test.metrics.push(message.payload || {});
    if (state.activeTestId === taskId && test) {
      const metric = message.payload || {};
      $('#current-rate').textContent = `${Number(metric.sendMbps || metric.recvMbps || 0).toFixed(1)} Mbps`;
      drawChart(test.metrics);
    }
  } else if (message.type === 'task.done' || message.type === 'task.error') {
    Promise.all([loadAgents(), loadTests()]).catch(() => {});
  }
}

function connectLive() {
  disconnectLive();
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${location.host}/ws/ui`);
  state.liveSocket = socket;
  socket.addEventListener('message', (event) => {
    try { handleLiveMessage(JSON.parse(event.data)); } catch { /* ignore malformed frames */ }
  });
  socket.addEventListener('close', () => {
    if (state.liveSocket === socket) {
      state.liveSocket = null;
      if (state.user) setTimeout(connectLive, 3000);
    }
  });
}

function disconnectLive() {
  if (!state.liveSocket) return;
  const socket = state.liveSocket;
  state.liveSocket = null;
  socket.close();
}

function showLogin() {
  $('#login-view').hidden = false;
  $('#app-view').hidden = true;
  clearInterval(state.pollTimer);
  disconnectLive();
}

async function showApp(user) {
  state.user = user;
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  $('#account-name').textContent = user.displayName;
  $('#account-role').textContent = `${user.username} · ${roleLabel(user.role)}`;
  $$('[data-admin-only]').forEach((node) => { node.hidden = user.role !== 'admin'; });
  setView('tests');
  try {
    await Promise.all([loadAgents(), loadTests(), user.role === 'admin' ? loadUsers() : Promise.resolve()]);
  } catch (error) {
    console.error(error);
    toast(`数据加载失败：${error.message}`);
  }
  connectLive();
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    if ($('#app-view').hidden) return;
    try { await Promise.all([loadAgents(), loadTests()]); } catch { /* a transient poll error is surfaced on the next action */ }
  }, 4000);
}

function setView(name) {
  if (name === 'users' && state.user?.role !== 'admin') return;
  $$('.page').forEach((node) => { node.hidden = node.id !== `view-${name}`; });
  $('.sidebar nav').querySelectorAll('button').forEach((node) => node.classList.toggle('active', node.dataset.view === name));
  $('#page-title').textContent = { tests: '网络性能测试', agents: 'Agent 管理', users: '用户管理' }[name];
}

function renderAgentSelect() {
  const select = $('#test-agent');
  const selected = select.value;
  clear(select);
  if (!state.agents.length) {
    const option = document.createElement('option');
    option.textContent = '暂无可用 Agent';
    option.value = '';
    select.appendChild(option);
  }
  for (const agent of state.agents) {
    const option = document.createElement('option');
    option.value = agent.id;
    option.textContent = `${agent.name} · ${statusLabel(agent.status)}`;
    option.disabled = agent.status === 'offline';
    select.appendChild(option);
  }
  if ([...select.options].some((option) => option.value === selected && !option.disabled)) select.value = selected;
  else {
    const available = [...select.options].find((option) => !option.disabled && option.value);
    if (available) select.value = available.value;
  }
  updateSelectedAgent();
}

function updateSelectedAgent() {
  const agent = state.agents.find((item) => item.id === $('#test-agent').value);
  $('#metric-agent').textContent = agent?.name || '未选择';
  $('#metric-cpu').textContent = agent ? percentText(agent.cpuPercent) : '--';
  $('#metric-memory').textContent = agent ? percentText(agent.memoryPercent) : '--';
  $('#metric-upload').textContent = agent ? percentText(agent.uploadPercent) : '--';
  $('#metric-download').textContent = agent ? percentText(agent.downloadPercent) : '--';
  $('#start-test').disabled = !agent || agent.status !== 'online';
}

function showInstall(install) {
  $('#install-docker').value = install.docker;
  $('#install-script').value = install.script;
  $('#install-panel').hidden = false;
  $('#install-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderAgents() {
  const tbody = $('#agents-body');
  clear(tbody);
  for (const agent of state.agents) {
    const tr = document.createElement('tr');
    const status = document.createElement('span');
    status.className = agent.status;
    status.textContent = statusLabel(agent.status);
    const platform = `${agent.os || 'linux'} / ${agent.arch || 'unknown'}${agent.version ? ` · ${agent.version}` : ''}`;
    const location = [agent.publicIp, agent.ipLocation].filter(Boolean).join(' · ') || '--';
    const resources = agent.cpuPercent === null || agent.cpuPercent === undefined ? '--' : `CPU ${percentText(agent.cpuPercent)} / MEM ${percentText(agent.memoryPercent)}`;
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    if (state.user.role === 'admin') {
      const connected = agent.status === 'online' || agent.status === 'busy';
      actions.appendChild(button(connected ? '在线不可安装' : '安装命令', 'secondary', async () => {
        try {
          const result = await api(`/api/admin/agents/${encodeURIComponent(agent.id)}/install`, { method: 'POST', body: '{}' });
          showInstall(result.install);
        } catch (error) { toast(error.message); }
      }, connected));
      actions.appendChild(button('删除', 'secondary', async () => {
        if (!confirm(`删除 Agent「${agent.name}」？`)) return;
        try { await api(`/api/admin/agents/${encodeURIComponent(agent.id)}`, { method: 'DELETE' }); await loadAgents(); }
        catch (error) { toast(error.message); }
      }, connected));
    }
    tr.append(cell(agent.name), cell(status), cell(platform), cell(location), cell(resources), cell(actions));
    tbody.appendChild(tr);
  }
  if (!state.agents.length) {
    const tr = document.createElement('tr');
    const td = cell('暂无 Agent。管理员可通过“添加 Agent”生成安装命令。');
    td.colSpan = 6;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

async function loadAgents() {
  const result = await api('/api/agents');
  state.agents = result.agents;
  renderAgents();
  renderAgentSelect();
  populateAgentPermissions();
}

function renderTests() {
  const tbody = $('#tests-body');
  clear(tbody);
  for (const test of state.tests) {
    const tr = document.createElement('tr');
    const agent = state.agents.find((item) => item.id === test.agentId);
    tr.append(cell(`${test.target}:${test.port}`), cell(agent?.name || test.agentId), cell(`${test.protocol.toUpperCase()}${test.reverse ? ' -R' : ''}`), cell(statusLabel(test.status)), cell(formatDate(test.createdAt)));
    tbody.appendChild(tr);
  }
  const active = state.tests.find((test) => test.id === state.activeTestId) || state.tests.find((test) => test.status === 'running');
  if (active) {
    state.activeTestId = active.id;
    $('#test-state').textContent = statusLabel(active.status);
    $('#cancel-test').disabled = active.status !== 'running';
    const outputText = active.output.map((line) => line.line).join('\n');
    $('#raw-output').textContent = outputText || '等待 Agent 输出。';
    $('#raw-output').dataset.streaming = outputText ? '1' : '0';
    $('#raw-output').scrollTop = $('#raw-output').scrollHeight;
    const lastMetric = active.metrics.at(-1);
    $('#current-rate').textContent = `${Number(lastMetric?.sendMbps || lastMetric?.recvMbps || 0).toFixed(1)} Mbps`;
    drawChart(active.metrics);
  } else {
    $('#cancel-test').disabled = true;
  }
}

async function loadTests() {
  const result = await api('/api/tests');
  state.tests = result.tests;
  renderTests();
}

function drawChart(metrics) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const grid = $('#chart-grid');
  const axis = $('#chart-axis');
  clear(grid);
  clear(axis);
  const left = 52;
  const top = 20;
  const width = 610;
  const height = 182;
  const bottom = top + height;
  const max = Math.max(100, ...metrics.flatMap((item) => [Number(item.sendMbps || 0), Number(item.recvMbps || 0)]));
  const maxSecond = Math.max(1, ...metrics.map((item) => Number(item.second || 0)));
  const text = (x, y, content, anchor = 'middle', className = '') => {
    const node = document.createElementNS(svgNS, 'text');
    node.setAttribute('x', x);
    node.setAttribute('y', y);
    node.setAttribute('text-anchor', anchor);
    if (className) node.setAttribute('class', className);
    node.textContent = content;
    axis.appendChild(node);
  };
  const segment = (x1, y1, x2, y2, className = '') => {
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', x1); line.setAttribute('y1', y1);
    line.setAttribute('x2', x2); line.setAttribute('y2', y2);
    if (className) line.setAttribute('class', className);
    return line;
  };
  for (let index = 0; index <= 4; index += 1) {
    const y = top + (index * height) / 4;
    grid.appendChild(segment(left, y, left + width, y));
    const value = max - (index * max) / 4;
    text(left - 8, y + 4, value >= 100 ? String(Math.round(value)) : value.toFixed(1), 'end');
  }
  text(6, top - 6, 'Mbps', 'start', 'axis-unit');
  axis.appendChild(segment(left, bottom, left + width, bottom, 'axis-line'));
  axis.appendChild(segment(left, top, left, bottom, 'axis-line'));
  for (let index = 0; index <= 4; index += 1) {
    const x = left + (index * width) / 4;
    axis.appendChild(segment(x, bottom, x, bottom + 5, 'axis-line'));
    text(x, bottom + 18, `${Math.round((maxSecond * index) / 4)}s`);
  }
  text(left + width, bottom + 34, '时间（秒）', 'end', 'axis-unit');
  axis.appendChild(segment(left + width - 168, top - 9, left + width - 146, top - 9, 'legend-send'));
  text(left + width - 140, top - 5, '发送', 'start');
  axis.appendChild(segment(left + width - 88, top - 9, left + width - 66, top - 9, 'legend-recv'));
  text(left + width - 60, top - 5, '接收', 'start');
  const points = (key) => metrics.map((metric, index) => {
    const second = Number(metric.second || 0);
    const x = second > 0 ? left + (second / maxSecond) * width : left + (index / Math.max(metrics.length - 1, 1)) * width;
    const y = top + height - (Number(metric[key] || 0) / max) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  $('#send-line').setAttribute('points', points('sendMbps'));
  $('#recv-line').setAttribute('points', points('recvMbps'));
}

function renderUsers() {
  const tbody = $('#users-body');
  clear(tbody);
  for (const user of state.users) {
    const tr = document.createElement('tr');
    const identity = document.createElement('span');
    identity.textContent = `${user.displayName} (${user.username})`;
    const role = document.createElement('select');
    role.className = 'role-select';
    for (const value of ['user', 'admin']) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = roleLabel(value);
      option.selected = value === user.role;
      role.appendChild(option);
    }
    role.disabled = user.id === 1;
    role.addEventListener('change', async () => {
      try { await api(`/api/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ role: role.value }) }); await loadUsers(); }
      catch (error) { toast(error.message); role.value = user.role; }
    });
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.appendChild(button(user.disabled ? '启用' : '禁用', 'secondary', async () => {
      try { await api(`/api/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ disabled: !user.disabled }) }); await loadUsers(); }
      catch (error) { toast(error.message); }
    }, user.id === 1));
    actions.appendChild(button('删除', 'secondary', async () => {
      if (!confirm(`删除用户「${user.displayName}」？`)) return;
      try { await api(`/api/users/${user.id}`, { method: 'DELETE' }); await loadUsers(); }
      catch (error) { toast(error.message); }
    }, user.id === 1));
    tr.append(cell(user.id), cell(identity), cell(role), cell(user.disabled ? '已禁用' : '已启用'), cell(actions));
    tbody.appendChild(tr);
  }
}

async function loadUsers() {
  if (state.user?.role !== 'admin') return;
  const result = await api('/api/users');
  state.users = result.users;
  renderUsers();
}

function populateAgentPermissions() {
  const select = $('#new-agent-ids');
  clear(select);
  for (const agent of state.agents) {
    const option = document.createElement('option');
    option.value = agent.id;
    option.textContent = agent.name;
    select.appendChild(option);
  }
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#login-error').textContent = '';
  try {
    const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: $('#login-username').value, password: $('#login-password').value }) });
    $('#login-password').value = '';
    await showApp(result.user);
  } catch (error) { $('#login-error').textContent = error.message; }
});

$('#logout-button').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
  state.user = null;
  showLogin();
});

$('.sidebar nav').addEventListener('click', (event) => {
  const target = event.target.closest('[data-view]');
  if (target) setView(target.dataset.view);
});

$('#test-agent').addEventListener('change', updateSelectedAgent);
$$('input[name="protocol"]').forEach((input) => input.addEventListener('change', () => { $('#bandwidth-row').hidden = input.value !== 'udp' || !input.checked; }));
$('#test-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = {
    agentId: $('#test-agent').value,
    target: $('#test-target').value,
    port: Number($('#test-port').value),
    protocol: $('input[name="protocol"]:checked').value,
    reverse: $('#test-reverse').checked,
    duration: Number($('#test-duration').value),
    parallel: Number($('#test-parallel').value),
    bandwidth: $('#test-bandwidth').value
  };
  try {
    const result = await api('/api/tests', { method: 'POST', body: JSON.stringify(data) });
    state.activeTestId = result.test.id;
    $('#raw-output').textContent = '任务已下发，等待 Agent 输出。';
    $('#raw-output').dataset.streaming = '0';
    await Promise.all([loadAgents(), loadTests()]);
  } catch (error) { toast(error.message); }
});

$('#cancel-test').addEventListener('click', async () => {
  if (!state.activeTestId) return;
  try { await api(`/api/tests/${state.activeTestId}/cancel`, { method: 'POST', body: '{}' }); await Promise.all([loadAgents(), loadTests()]); }
  catch (error) { toast(error.message); }
});
$('#refresh-tests').addEventListener('click', () => loadTests().catch((error) => toast(error.message)));

$('#add-agent').addEventListener('click', () => $('#agent-dialog').showModal());
$('#agent-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') { $('#agent-dialog').close(); return; }
  if (!event.currentTarget.reportValidity()) return;
  try {
    const result = await api('/api/admin/agents', { method: 'POST', body: JSON.stringify({ name: $('#agent-name').value }) });
    $('#agent-dialog').close();
    event.currentTarget.reset();
    showInstall(result.install);
    await loadAgents();
  } catch (error) { toast(error.message); }
});
$('#close-install').addEventListener('click', () => { $('#install-panel').hidden = true; });
$$('.copy-command').forEach((node) => node.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($(`#${node.dataset.target}`).value); toast('命令已复制'); }
  catch { toast('复制失败，请手动选择命令'); }
}));

$('#add-user').addEventListener('click', () => $('#user-dialog').showModal());
$('#new-role').addEventListener('change', () => { $('#new-agent-access-row').hidden = $('#new-role').value === 'admin'; });
$('#user-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') { $('#user-dialog').close(); return; }
  if (!event.currentTarget.reportValidity()) return;
  const agentIds = [...$('#new-agent-ids').selectedOptions].map((option) => option.value);
  try {
    await api('/api/users', { method: 'POST', body: JSON.stringify({ username: $('#new-username').value, displayName: $('#new-display-name').value, password: $('#new-password').value, role: $('#new-role').value, agentIds }) });
    $('#user-dialog').close();
    event.currentTarget.reset();
    $('#new-agent-access-row').hidden = false;
    await loadUsers();
  } catch (error) { toast(error.message); }
});

drawChart([]);
api('/api/me').then((result) => result.user ? showApp(result.user) : showLogin()).catch(showLogin);
