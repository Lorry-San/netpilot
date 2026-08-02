import { createHash } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';

const api = globalThis.netpilotServerApi;
const db = api?.db;
const PAGE_SIZE = 4;
const activeTests = new Map();
const bindFailures = new Map();
let bot = null;
let stopping = false;
let completionHookRegistered = false;
let botGeneration = 0;

function token() {
  return String(api?.getSettings?.()?.telegram_bot_token || '');
}

function telegramUrl(method) {
  return `https://api.telegram.org/bot${token()}/${method}`;
}

async function call(method, body = {}) {
  const response = await fetch(telegramUrl(method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram API ${response.status}`);
  return result.result;
}

async function safeCall(method, body) {
  try { return await call(method, body); } catch (error) { console.error(`[netpilot] telegram ${method}:`, error.message); return null; }
}

async function upload(method, fields, filename, bytes, contentType) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
  form.set('photo', new Blob([bytes], { type: contentType }), filename);
  const response = await fetch(telegramUrl(method), { method: 'POST', body: form, signal: AbortSignal.timeout(45000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram API ${response.status}`);
  return result.result;
}

function esc(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function boundUser(telegramId) {
  return db.get(`SELECT u.id, u.username, u.display_name AS displayName, u.role, u.disabled,
                t.telegram_id AS telegramId, t.telegram_username AS telegramUsername
                FROM telegram_users t JOIN users u ON u.id = t.user_id
                WHERE t.telegram_id = ? AND u.disabled = 0`, telegramId);
}

function groupFor(chatId) {
  return db.get('SELECT * FROM telegram_groups WHERE chat_id = ?', chatId);
}

function ensureGroup(chat, user) {
  if (!chat || chat.type === 'private' || !user) return null;
  const existing = groupFor(chat.id);
  if (existing) {
    const title = chat.title || chat.username || String(chat.id);
    if (title !== existing.title) db.run('UPDATE telegram_groups SET title = ?, updated_at = ? WHERE chat_id = ?', title, db.now(), chat.id);
    return groupFor(chat.id);
  }
  if (user.role !== 'admin' && db.get('SELECT COUNT(*) AS count FROM telegram_groups WHERE owner_user_id = ?', user.id).count >= 1) return null;
  const now = db.now();
  db.run(`INSERT OR IGNORE INTO telegram_groups (chat_id, title, owner_user_id, mode, created_at, updated_at)
          VALUES (?, ?, ?, 'members_only', ?, ?)`, chat.id, chat.title || chat.username || String(chat.id), user.id, now, now);
  return groupFor(chat.id);
}

function canUseChat(message, user) {
  const chat = message.chat;
  if (!chat || chat.type === 'private') return Boolean(user);
  const group = ensureGroup(chat, user);
  if (!group || !user) return false;
  if (group.mode === 'all_members' && user.role === 'admin') return true;
  if (group.mode === 'all_members') return true;
  return group.owner_user_id === user.id;
}

function accessibleAgents(user) {
  if (!user) return [];
  if (user.role === 'admin') return db.all("SELECT * FROM agents WHERE deleted_at IS NULL AND status = 'online' ORDER BY name");
  return db.all(`SELECT a.* FROM agents a JOIN user_agent_permissions p ON p.agent_id = a.id
                 WHERE p.user_id = ? AND a.deleted_at IS NULL AND a.status = 'online' ORDER BY a.name`, user.id);
}

function makeId(prefix = 'tg') {
  return `${prefix}_${createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 18)}`;
}

function selectionKeyboard(test) {
  const agents = test.agents;
  const pages = Math.max(1, Math.ceil(agents.length / PAGE_SIZE));
  const start = test.page * PAGE_SIZE;
  const pageAgents = agents.slice(start, start + PAGE_SIZE);
  const rows = pageAgents.map((agent) => {
    const selected = test.selected.has(agent.id) ? '☑' : '☐';
    const suffix = agent.status === 'online' ? '在线' : agent.status;
    return [{ text: `${selected} ${agent.name} [${suffix}]`, callback_data: `tg:${test.id}:toggle:${agent.id}:${test.telegramId}` }];
  });
  const nav = [];
  if (test.page > 0) nav.push({ text: '⬅ 上一页', callback_data: `tg:${test.id}:page:${test.page - 1}:${test.telegramId}` });
  nav.push({ text: `${test.page + 1}/${pages}`, callback_data: `tg:${test.id}:noop:${test.telegramId}` });
  if (test.page + 1 < pages) nav.push({ text: '下一页 ➡', callback_data: `tg:${test.id}:page:${test.page + 1}:${test.telegramId}` });
  rows.push(nav);
  rows.push([
    { text: '👋取消任务', callback_data: `tg:${test.id}:cancel:${test.telegramId}` },
    { text: '👌完成选择', callback_data: `tg:${test.id}:done:${test.telegramId}` }
  ]);
  return { inline_keyboard: rows };
}

function chartSvg(metrics = []) {
  const width = 720;
  const height = 280;
  const left = 58;
  const top = 24;
  const plotW = 625;
  const plotH = 195;
  const max = Math.max(100, ...metrics.flatMap((m) => [Number(m.sendMbps || 0), Number(m.recvMbps || 0)]));
  const maxSecond = Math.max(1, ...metrics.map((m) => Number(m.second || 0)));
  const point = (key, index, metric) => {
    const second = Number(metric.second || index);
    const x = left + (second / maxSecond) * plotW;
    const y = top + plotH - (Number(metric[key] || 0) / max) * plotH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };
  const send = metrics.map((m, i) => point('sendMbps', i, m)).join(' ');
  const recv = metrics.map((m, i) => point('recvMbps', i, m)).join(' ');
  const grid = Array.from({ length: 5 }, (_, i) => {
    const y = top + (plotH * i) / 4;
    const value = Math.round(max - (max * i) / 4);
    return `<line x1="${left}" y1="${y}" x2="${left + plotW}" y2="${y}" stroke="#ccd6dc"/><text x="${left - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="#53616b">${value}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fff"/><text x="12" y="16" font-family="sans-serif" font-size="11" fill="#53616b">Mbps</text>${grid}<line x1="${left}" y1="${top + plotH}" x2="${left + plotW}" y2="${top + plotH}" stroke="#53616b"/><line x1="${left}" y1="${top}" x2="${left}" y2="${top + plotH}" stroke="#53616b"/><text x="${left + plotW}" y="${top + plotH + 30}" text-anchor="end" font-family="sans-serif" font-size="11" fill="#53616b">Time (s)</text><polyline fill="none" stroke="#12a594" stroke-width="3" points="${send}"/><polyline fill="none" stroke="#2379bd" stroke-width="2" points="${recv}"/><text x="${width - 145}" y="18" font-family="sans-serif" font-size="11" fill="#12a594">Send</text><text x="${width - 72}" y="18" font-family="sans-serif" font-size="11" fill="#2379bd">Receive</text></svg>`;
}

async function sendChart(chatId, metrics) {
  const svg = chartSvg(metrics);
  try {
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1440 } }).render().asPng();
    await upload('sendPhoto', { chat_id: chatId, caption: '速度 / 时间曲线' }, 'netpilot-chart.png', png, 'image/png');
  } catch (error) {
    console.error('[netpilot] telegram chart:', error.message);
  }
}

function resultText(view) {
  const status = view.status === 'completed' ? '完成' : view.status === 'cancelled' ? '已取消' : '失败';
  const last = view.metrics.at(-1);
  const rate = Number(last?.sendMbps || last?.recvMbps || 0).toFixed(2);
  const raw = view.output.map((line) => line.line).join('\n');
  const tail = raw.length > 3500 ? `…${raw.slice(-3500)}` : raw;
  return `测试${status}\nAgent：${esc(view.agentName)}\n目标：${esc(view.target)}:${view.port}\n协议：${view.protocol.toUpperCase()}${view.reverse ? ' -R' : ''}\n时长：${view.duration}s\n末速：${rate} Mbps\n\n<blockquote expandable>${esc(tail || '无原始输出')}</blockquote>`;
}

async function sendHelp(chatId) {
  await safeCall('sendMessage', { chat_id: chatId, text: '/bind <网页生成的6位验证码>\n/agents 查看可用 Agent\n/iperf <IP> <端口> [线程] [时长]\n在群组中首次使用会自动登记，管理员可在网页设置群组模式。', parse_mode: 'HTML' });
}

async function startTestFromTelegram(chatId, telegramId, user, args) {
  const target = args[0];
  const port = Number(args[1] || 5201);
  const parallel = Number(args[2] || 1);
  const duration = Number(args[3] || 10);
  if (!target || !Number.isInteger(port) || !Number.isInteger(parallel) || !Number.isInteger(duration)) {
    await safeCall('sendMessage', { chat_id: chatId, text: '格式：/iperf IP 端口 [线程] [时长]' });
    return;
  }
  const agents = accessibleAgents(user);
  if (!agents.length) {
    await safeCall('sendMessage', { chat_id: chatId, text: '没有可用的在线 Agent。' });
    return;
  }
  const id = makeId();
  const test = { id, chatId, telegramId, user, target, port, parallel, duration, agents, selected: new Set(), page: 0 };
  activeTests.set(id, test);
  const message = await safeCall('sendMessage', { chat_id: chatId, text: `请选择 Agent\n目标：${target}:${port}，${parallel} 线程，${duration} 秒`, reply_markup: selectionKeyboard(test) });
  test.messageId = message?.message_id;
  if (!test.messageId) activeTests.delete(id);
}

async function finishTest(test) {
  if (!test.selected.size) {
    await safeCall('answerCallbackQuery', { callback_query_id: test.queryId, text: '请至少选择一个 Agent', show_alert: true });
    return;
  }
  const created = [];
  const errors = [];
  for (const agentId of test.selected) {
    try {
      const task = api.createTest(test.user, { agentId, target: test.target, port: test.port, parallel: test.parallel, duration: test.duration, protocol: 'tcp', reverse: true });
      created.push(task);
      api.audit(test.user.id, 'test.create.telegram', task.id, { agentId, target: test.target, chatId: test.chatId });
    } catch (error) {
      errors.push(`${test.agents.find((agent) => agent.id === agentId)?.name || agentId}: ${error.message}`);
    }
  }
  if (!created.length) {
    await safeCall('answerCallbackQuery', { callback_query_id: test.queryId, text: errors.join('\n').slice(0, 180), show_alert: true });
    return;
  }
  test.taskIds = new Set(created.map((task) => task.id));
  test.completedTaskIds = new Set();
  const names = created.map((task) => test.agents.find((agent) => agent.id === task.agent_id)?.name || task.agent_id);
  await safeCall('editMessageText', { chat_id: test.chatId, message_id: test.messageId, text: `测试已开始：${test.target}:${test.port}\nAgent：${esc(names.join('、'))}\n运行中…${errors.length ? `\n未启动：${esc(errors.join('；'))}` : ''}`, parse_mode: 'HTML' });
  const timer = setInterval(async () => {
    const running = [...test.taskIds].filter((taskId) => !test.completedTaskIds.has(taskId));
    if (!running.length) return;
    const outputLines = running.reduce((sum, taskId) => sum + Number(db.get('SELECT COUNT(*) AS count FROM test_output WHERE test_id = ?', taskId)?.count || 0), 0);
    await safeCall('editMessageText', { chat_id: test.chatId, message_id: test.messageId, text: `测试运行中：${test.target}:${test.port}\nAgent：${names.join('、')}\n进度：${test.completedTaskIds.size}/${test.taskIds.size}，已产生 ${outputLines} 行输出…` });
  }, 5000);
  timer.unref?.();
  test.timer = timer;
}

async function completeTelegramTask(task, view) {
  const test = [...activeTests.values()].find((item) => item.taskIds?.has(task.id));
  if (!test) return;
  test.completedTaskIds.add(task.id);
  await safeCall('sendMessage', { chat_id: test.chatId, text: resultText(view), parse_mode: 'HTML' });
  await sendChart(test.chatId, view.metrics);
  if (test.completedTaskIds.size === test.taskIds.size) {
    clearInterval(test.timer);
    activeTests.delete(test.id);
    await safeCall('editMessageText', { chat_id: test.chatId, message_id: test.messageId, text: `全部测试已结束：${test.completedTaskIds.size}/${test.taskIds.size}` });
  }
}

async function callbackQuery(query) {
  const data = String(query.data || '').split(':');
  if (data[0] !== 'tg') return;
  const test = activeTests.get(data[1]);
  const expected = Number(data.at(-1));
  const currentUser = boundUser(query.from?.id);
  if (!test || expected !== Number(query.from?.id) || test.telegramId !== expected || currentUser?.id !== test.user.id) {
    await safeCall('answerCallbackQuery', { callback_query_id: query.id, text: '无权操作此任务', show_alert: true });
    return;
  }
  test.queryId = query.id;
  const action = data[2];
  if (action === 'toggle') {
    const agentId = data[3];
    if (test.selected.has(agentId)) test.selected.delete(agentId); else test.selected.add(agentId);
    await safeCall('answerCallbackQuery', { callback_query_id: query.id, text: test.selected.size ? `已选择 ${test.selected.size} 个` : '已取消选择' });
    await safeCall('editMessageReplyMarkup', { chat_id: test.chatId, message_id: test.messageId, reply_markup: selectionKeyboard(test) });
  } else if (action === 'page') {
    test.page = Math.max(0, Number(data[3]) || 0);
    await safeCall('answerCallbackQuery', { callback_query_id: query.id });
    await safeCall('editMessageReplyMarkup', { chat_id: test.chatId, message_id: test.messageId, reply_markup: selectionKeyboard(test) });
  } else if (action === 'done') {
    await finishTest(test);
  } else if (action === 'cancel') {
    activeTests.delete(test.id);
    await safeCall('answerCallbackQuery', { callback_query_id: query.id, text: '已取消' });
    await safeCall('editMessageText', { chat_id: test.chatId, message_id: test.messageId, text: '任务已取消。' });
  } else {
    await safeCall('answerCallbackQuery', { callback_query_id: query.id });
  }
}

async function handleMessage(message) {
  const from = message.from;
  const chat = message.chat;
  const text = String(message.text || '').trim();
  if (!from || !chat || !text) return;
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  let user = boundUser(from.id);
  if (command === '/start' || command === '/help') {
    if (user && chat.type !== 'private' && !canUseChat(message, user)) {
      await safeCall('sendMessage', { chat_id: chat.id, text: '此群组当前不可用，或普通用户已登记过其他群组。' });
      return;
    }
    return sendHelp(chat.id);
  }
  if (command === '/bind') {
    const failure = bindFailures.get(from.id);
    if (failure && failure.blockedUntil > Date.now()) {
      await safeCall('sendMessage', { chat_id: chat.id, text: '绑定尝试过多，请稍后再试。' });
      return;
    }
    const code = parts[1] || '';
    const row = db.get(`SELECT c.* FROM telegram_bind_codes c JOIN users u ON u.id = c.user_id
                        WHERE c.code = ? AND c.expires_at > ? AND u.disabled = 0`, code, db.now());
    if (!row) {
      const attempts = (failure?.attempts || 0) + 1;
      bindFailures.set(from.id, { attempts: attempts >= 5 ? 0 : attempts, blockedUntil: attempts >= 5 ? Date.now() + 10 * 60 * 1000 : 0 });
      await safeCall('sendMessage', { chat_id: chat.id, text: '验证码无效或已过期。' });
      return;
    }
    db.run('DELETE FROM telegram_users WHERE user_id = ? OR telegram_id = ?', row.user_id, from.id);
    db.run('INSERT INTO telegram_users (telegram_id, user_id, telegram_username, chat_id, bound_at) VALUES (?, ?, ?, ?, ?)', from.id, row.user_id, from.username || '', chat.id, db.now());
    db.run('DELETE FROM telegram_bind_codes WHERE code = ?', code);
    bindFailures.delete(from.id);
    await safeCall('sendMessage', { chat_id: chat.id, text: '绑定成功，现在可以使用 /agents 和 /iperf。' });
    return;
  }
  user = boundUser(from.id);
  if (!user) { await safeCall('sendMessage', { chat_id: chat.id, text: '请先在网页账户设置生成验证码，然后发送 /bind 验证码。' }); return; }
  if (!canUseChat(message, user)) { await safeCall('sendMessage', { chat_id: chat.id, text: '此群组当前仅允许群组所有者使用。' }); return; }
  if (command === '/agents') {
    const agents = accessibleAgents(user);
    await safeCall('sendMessage', { chat_id: chat.id, text: agents.length ? agents.map((a) => `${a.name} - ${a.status}`).join('\n') : '没有可用的在线 Agent。' });
    return;
  }
  if (command === '/iperf') return startTestFromTelegram(chat.id, from.id, user, parts.slice(1));
}

async function poll(generation, botToken) {
  let offset = Number(api.getSettings().telegram_update_offset || 0);
  while (generation === botGeneration && bot && !stopping && token() === botToken) {
    try {
      const updates = await call('getUpdates', { offset, timeout: 35, allowed_updates: ['message', 'callback_query'] });
      if (generation !== botGeneration || token() !== botToken) break;
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.callback_query) await callbackQuery(update.callback_query);
        else if (update.message) await handleMessage(update.message);
      }
      if (updates.length) db.run(`INSERT INTO settings (key, value, updated_at) VALUES ('telegram_update_offset', ?, ?)
                                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, String(offset), db.now());
    } catch (error) {
      if (!stopping) { console.error('[netpilot] telegram polling:', error.message); await new Promise((resolve) => setTimeout(resolve, 3000)); }
    }
  }
}

export async function startTelegramBot() {
  if (!api || !db) return;
  const generation = ++botGeneration;
  const botToken = token();
  if (!botToken) { bot = null; globalThis.netpilotTelegramReload = startTelegramBot; return; }
  stopping = false;
  bot = { token: botToken };
  const me = await safeCall('getMe');
  if (me) console.log(`[netpilot] telegram bot @${me.username} enabled`);
  globalThis.netpilotTelegramReload = async () => {
    stopping = true;
    bot = null;
    botGeneration += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    startTelegramBot();
  };
  poll(generation, botToken);
  if (!completionHookRegistered) {
    api.onTaskComplete(completeTelegramTask);
    completionHookRegistered = true;
  }
}

export const telegramTest = { activeTests, callbackQuery, chartSvg, selectionKeyboard };
