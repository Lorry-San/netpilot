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

function botUsername() {
  return String(api?.getSettings?.()?.telegram_bot_username || '').replace(/^@/, '');
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

function replyTo(messageId) {
  return messageId ? { reply_parameters: { message_id: messageId } } : {};
}

async function upload(method, fields, fileField, filename, bytes, contentType) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value && typeof value === 'object' ? JSON.stringify(value) : String(value));
  form.set(fileField, new Blob([bytes], { type: contentType }), filename);
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
  if (!chat || chat.type === 'private') return null;
  const existing = groupFor(chat.id);
  if (existing) {
    const title = chat.title || chat.username || String(chat.id);
    if (title !== existing.title) db.run('UPDATE telegram_groups SET title = ?, updated_at = ? WHERE chat_id = ?', title, db.now(), chat.id);
    return groupFor(chat.id);
  }
  if (!user) return null;
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
  return Boolean(group && user);
}

function publicGroupUser(chat) {
  if (!chat || chat.type === 'private') return null;
  const group = groupFor(chat.id);
  if (!group || group.mode !== 'all_members') return null;
  return db.get(`SELECT id, username, display_name AS displayName, role, disabled
                 FROM users WHERE id = ? AND disabled = 0`, group.owner_user_id);
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

function directionKeyboard(test) {
  const username = botUsername();
  const directionButton = (text, direction) => test.chatType !== 'private' && username
    ? { text, url: `https://t.me/${username}?start=iperf_${test.id}_${direction}` }
    : { text, callback_data: `tg:${test.id}:direction:${direction}:${test.telegramId}` };
  return { inline_keyboard: [
    [
      directionButton('上行测试', 'up'),
      directionButton('下行测试', 'down')
    ],
    [{ text: '关闭页面', callback_data: `tg:${test.id}:close:${test.telegramId}` }]
  ] };
}

function privateTargetKeyboard(test) {
  const username = botUsername();
  if (!username) return { inline_keyboard: [[{ text: '关闭页面', callback_data: `tg:${test.id}:close:${test.telegramId}` }]] };
  return { inline_keyboard: [
    [{ text: '前往私聊输入 IP:端口', url: `https://t.me/${username}?start=iperf_${test.id}` }],
    [{ text: '关闭页面', callback_data: `tg:${test.id}:close:${test.telegramId}` }]
  ] };
}

function chartSvg(metrics = [], options = {}) {
  const rows = metrics
    .map((metric, index) => ({
      second: Number.isFinite(Number(metric.second)) ? Number(metric.second) : index + 1,
      sendMbps: Number.isFinite(Number(metric.sendMbps)) ? Number(metric.sendMbps) : null,
      recvMbps: Number.isFinite(Number(metric.recvMbps)) ? Number(metric.recvMbps) : null
    }))
    .sort((a, b) => a.second - b.second);
  const width = Math.max(960, Math.min(2400, 210 + rows.length * 72));
  const height = 520;
  const left = 92;
  const right = 38;
  const top = 72;
  const bottom = 82;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const values = rows.flatMap((row) => [row.sendMbps, row.recvMbps]).filter((value) => value !== null && value >= 0);
  const rawMax = Math.max(1, ...values);
  const magnitude = 10 ** Math.floor(Math.log10(rawMax * 1.15));
  const scaled = (rawMax * 1.15) / magnitude;
  const niceFactor = [1, 1.25, 1.5, 2, 2.5, 5, 10].find((factor) => scaled <= factor) || 10;
  const maxRate = niceFactor * magnitude;
  const minSecond = Math.min(0, ...rows.map((row) => row.second));
  const maxSecond = Math.max(1, ...rows.map((row) => row.second));
  const xFor = (second) => left + ((second - minSecond) / Math.max(1, maxSecond - minSecond)) * plotW;
  const yFor = (value) => top + plotH - (Math.max(0, value || 0) / maxRate) * plotH;
  const formatRate = (value) => value >= 1000 ? value.toFixed(0) : value >= 100 ? value.toFixed(1) : value.toFixed(2);
  const sameSeries = rows.length > 0 && rows.every((row) => row.sendMbps === null || row.recvMbps === null || Math.abs(row.sendMbps - row.recvMbps) < 0.005);
  const available = [
    { key: 'sendMbps', label: sameSeries ? 'Rate' : 'Send', color: '#079a87' },
    { key: 'recvMbps', label: 'Receive', color: '#226fb3' }
  ].filter((series, index) => rows.some((row) => row[series.key] !== null) && !(sameSeries && index === 1));
  const yTicks = Array.from({ length: 6 }, (_, index) => {
    const value = (maxRate * index) / 5;
    const y = top + plotH - (plotH * index) / 5;
    return `<line x1="${left}" y1="${y}" x2="${left + plotW}" y2="${y}" stroke="#d8e0e5" stroke-width="1"/><line x1="${left - 6}" y1="${y}" x2="${left}" y2="${y}" stroke="#33434d" stroke-width="2"/><text x="${left - 12}" y="${y + 5}" text-anchor="end" font-size="14" fill="#33434d">${formatRate(value)}</text>`;
  }).join('');
  const tickRows = rows.length <= 16 ? rows : rows.filter((_, index) => index % Math.ceil(rows.length / 12) === 0 || index === rows.length - 1);
  const xTicks = tickRows.map((row) => {
    const x = xFor(row.second);
    return `<line x1="${x}" y1="${top + plotH}" x2="${x}" y2="${top + plotH + 7}" stroke="#33434d" stroke-width="2"/><text x="${x}" y="${top + plotH + 27}" text-anchor="middle" font-size="14" fill="#33434d">${row.second.toFixed(row.second % 1 ? 1 : 0)}</text>`;
  }).join('');
  const renderedSeries = available.map((series, seriesIndex) => {
    const points = rows.filter((row) => row[series.key] !== null).map((row) => `${xFor(row.second).toFixed(1)},${yFor(row[series.key]).toFixed(1)}`).join(' ');
    const marks = rows.filter((row) => row[series.key] !== null).map((row, pointIndex) => {
      const x = xFor(row.second);
      const y = yFor(row[series.key]);
      const labelY = Math.max(top + 13, Math.min(top + plotH - 8, y + (seriesIndex === 0 ? (pointIndex % 2 ? 22 : -12) : 22)));
      return `<circle cx="${x}" cy="${y}" r="4.5" fill="#fff" stroke="${series.color}" stroke-width="3"/><text x="${x}" y="${labelY}" text-anchor="middle" font-size="13" font-weight="600" fill="${series.color}" stroke="#fff" stroke-width="4" paint-order="stroke">${formatRate(row[series.key])}</text>`;
    }).join('');
    return `<polyline fill="none" stroke="${series.color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" points="${points}"/>${marks}`;
  }).join('');
  const legend = available.map((series, index) => `<line x1="${left + index * 118}" y1="46" x2="${left + 28 + index * 118}" y2="46" stroke="${series.color}" stroke-width="4"/><text x="${left + 36 + index * 118}" y="51" font-size="14" fill="#33434d">${series.label}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fff"/><text x="${left}" y="27" font-family="sans-serif" font-size="20" font-weight="700" fill="#17242c">${esc(options.title || 'NetPilot speed / time')}</text><g font-family="sans-serif">${legend}${yTicks}${xTicks}<line x1="${left}" y1="${top}" x2="${left}" y2="${top + plotH}" stroke="#33434d" stroke-width="2"/><line x1="${left}" y1="${top + plotH}" x2="${left + plotW}" y2="${top + plotH}" stroke="#33434d" stroke-width="2"/><text x="22" y="${top + plotH / 2}" text-anchor="middle" font-size="16" font-weight="600" fill="#17242c" transform="rotate(-90 22 ${top + plotH / 2})">Speed (Mbps)</text><text x="${left + plotW / 2}" y="${height - 18}" text-anchor="middle" font-size="16" font-weight="600" fill="#17242c">Time (s)</text>${renderedSeries}</g></svg>`;
}

function elapsedMs(start, end = Date.now()) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  return Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatTimestamp(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)).replaceAll('/', '-');
}

async function sendChart(chatId, view, batchStartedAt, replyToMessageId) {
  if (!view.metrics.length) return false;
  const svg = chartSvg(view.metrics, { title: `${view.agentName} - ${view.target}:${view.port}` });
  try {
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: Math.min(2400, Math.max(1440, view.metrics.length * 100)) } }).render().asPng();
    const timestamp = new Date(view.finishedAt || Date.now()).toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
    const caption = `速度 / 时间曲线\nAgent：${view.agentName}\n测试耗时：${formatDuration(elapsedMs(view.createdAt, view.finishedAt))}\n当前总耗时：${formatDuration(elapsedMs(batchStartedAt, view.finishedAt || Date.now()))}`;
    await upload('sendDocument', { chat_id: chatId, caption, ...replyTo(replyToMessageId) }, 'document', `netpilot-${timestamp}.png`, png, 'image/png');
    return true;
  } catch (error) {
    console.error('[netpilot] telegram chart:', error.message);
    return false;
  }
}

function resultText(view) {
  const status = view.status === 'completed' ? '完成' : view.status === 'cancelled' ? '已取消' : '失败';
  const last = view.metrics.at(-1);
  const rate = Number(last?.sendMbps || last?.recvMbps || 0).toFixed(2);
  const raw = view.output.map((line) => line.line).join('\n');
  const tail = raw.length > 3200 ? `…${raw.slice(-3200)}` : raw;
  const duration = formatDuration(elapsedMs(view.createdAt, view.finishedAt));
  return `测试${status}\nAgent：${esc(view.agentName)}\n目标：${esc(view.target)}:${view.port}\n协议：${view.protocol.toUpperCase()}${view.reverse ? ' -R' : ''}\n设定时长：${view.duration}s\n测试耗时：${duration}\n完成时间：${formatTimestamp(view.finishedAt)}\n末速：${rate} Mbps\n\n<blockquote expandable>${esc(tail || '无原始输出')}</blockquote>`;
}

async function sendHelp(chatId, replyToMessageId) {
  await safeCall('sendMessage', { chat_id: chatId, text: '/help 查看命令帮助\n/status 查看授权与 Bot 状态\n/bind <网页生成的6位验证码>\n/agents 查看可用 Agent\n/iperf 交互设置 Agent、方向和目标\n/iperf <IP> [端口] [线程] [时长] [-R] 快捷测速\n\n直接输入 /iperf 时，先选择 Agent 和上/下行，再在 Bot 私聊输入 IP:端口。/iperf IP 默认上行；显式 -R 为下行。快捷模式默认端口 5201、线程 1、时长 10 秒。\n\n在群组中首次使用会自动登记。私有模式仅响应已绑定用户；管理员可在网页将群组设为公共模式。', parse_mode: 'HTML', ...replyTo(replyToMessageId) });
}

async function sendStatus(chatId, user, chat, replyToMessageId) {
  const agents = accessibleAgents(user);
  const group = chat?.type === 'private' ? null : groupFor(chat.id);
  const groupMode = group ? (group.mode === 'all_members' ? '公共模式' : '私有模式') : '私信';
  const groupCount = user.role === 'admin'
    ? Number(db.get('SELECT COUNT(*) AS count FROM telegram_groups')?.count || 0)
    : Number(db.get('SELECT COUNT(*) AS count FROM telegram_groups WHERE owner_user_id = ?', user.id)?.count || 0);
  await safeCall('sendMessage', {
    chat_id: chatId,
    text: `NetPilot Bot：在线\n授权账户：${user.displayName || user.username}（UID ${user.id}）\n会话模式：${groupMode}\n可用在线 Agent：${agents.length}\n已登记群组：${groupCount}`,
    ...replyTo(replyToMessageId)
  });
}

function parseIperfArgs(args = []) {
  const tokens = args.map((value) => String(value).trim()).filter(Boolean);
  if (tokens.some((value) => value.startsWith('-') && value.toUpperCase() !== '-R')) return null;
  const reverseSpecified = tokens.some((value) => value.toUpperCase() === '-R');
  const reverse = reverseSpecified;
  const positional = tokens.filter((value) => value.toUpperCase() !== '-R');
  if (positional.length < 1 || positional.length > 4 || positional[0].startsWith('-')) return null;
  const target = positional[0];
  const port = positional[1] === undefined ? 5201 : Number(positional[1]);
  const parallel = positional[2] === undefined ? 1 : Number(positional[2]);
  const duration = positional[3] === undefined ? 10 : Number(positional[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(parallel) || parallel < 1 || parallel > 32 || !Number.isInteger(duration) || duration < 1 || duration > 3600) return null;
  return { target, port, parallel, duration, reverse, reverseSpecified };
}

function parseTargetInput(value) {
  const input = String(value || '').trim();
  if (!input || /\s/.test(input) || input.length > 255) return null;
  let target = input;
  let port = 5201;
  const bracketed = input.match(/^\[([^\]]+)](?::(\d+))?$/);
  if (bracketed) {
    target = bracketed[1];
    port = bracketed[2] === undefined ? 5201 : Number(bracketed[2]);
  } else if ((input.match(/:/g) || []).length === 1) {
    const separator = input.lastIndexOf(':');
    target = input.slice(0, separator);
    port = Number(input.slice(separator + 1));
  }
  if (!target || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { target, port };
}

async function startTestFromTelegram(chat, telegramId, user, args, replyToMessageId) {
  const interactive = args.length === 0;
  const parsed = interactive
    ? { target: '', port: 5201, parallel: 1, duration: 10, reverse: false, reverseSpecified: false }
    : parseIperfArgs(args);
  if (!parsed) {
    await safeCall('sendMessage', { chat_id: chat.id, text: '格式：/iperf 或 /iperf IP [端口] [线程] [时长] [-R]\n示例：/iperf 192.0.2.1', ...replyTo(replyToMessageId) });
    return;
  }
  const { target, port, parallel, duration, reverse } = parsed;
  const agents = accessibleAgents(user);
  if (!agents.length) {
    await safeCall('sendMessage', { chat_id: chat.id, text: '没有可用的在线 Agent。', ...replyTo(replyToMessageId) });
    return;
  }
  const id = makeId();
  const test = {
    id, chatId: chat.id, chatType: chat.type, telegramId, user, publicChatId: user.publicChatId || null,
    target, port, parallel, duration, reverse, directionRequired: interactive, targetRequired: interactive,
    replyToMessageId, agents, selected: new Set(), page: 0, state: 'selecting', createdAt: Date.now()
  };
  activeTests.set(id, test);
  const message = await safeCall('sendMessage', {
    chat_id: chat.id,
    text: interactive
      ? '请选择 Agent\n选择完成后继续设置上行或下行测试。'
      : `请选择 Agent\n目标：${target}:${port}，${parallel} 线程，${duration} 秒${reverse ? '，下行测试 (-R)' : '，上行测试'}`,
    reply_markup: selectionKeyboard(test),
    ...replyTo(replyToMessageId)
  });
  test.messageId = message?.message_id;
  if (!test.messageId) activeTests.delete(id);
}

async function promptForTarget(test, privateChatId, replyToMessageId) {
  test.state = 'awaiting_target';
  test.inputChatId = privateChatId;
  test.inputReplyToMessageId = replyToMessageId;
  test.promptedAt = Date.now();
  const message = await safeCall('sendMessage', {
    chat_id: privateChatId,
    text: `请输入目标 IP:端口\n端口不填写时默认为 5201。\n测试方向：${test.reverse ? '下行' : '上行'}`,
    reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'IP:5201' },
    ...replyTo(replyToMessageId)
  });
  test.inputPromptMessageId = message?.message_id;
}

async function requestTarget(test, privateChatId, replyToMessageId) {
  if (test.chatType === 'private') {
    await safeCall('editMessageText', {
      chat_id: test.chatId,
      message_id: test.messageId,
      text: `Agent 与方向已设置，等待输入目标 IP:端口。\nAgent：${test.selectedAgents.map((agent) => agent.name).join('、')}\n方向：${test.reverse ? '下行' : '上行'}`
    });
    await promptForTarget(test, privateChatId, replyToMessageId);
    return;
  }
  test.state = 'awaiting_private';
  await safeCall('editMessageText', {
    chat_id: test.chatId,
    message_id: test.messageId,
    text: `Agent 与方向已设置\nAgent：${test.selectedAgents.map((agent) => agent.name).join('、')}\n方向：${test.reverse ? '下行' : '上行'}\n请前往 Bot 私聊输入目标 IP:端口。`,
    reply_markup: privateTargetKeyboard(test)
  });
}

function progressKeyboard(test) {
  return { inline_keyboard: [
    [{ text: '❌ 实时渲染', callback_data: `tg:${test.id}:refresh:${test.telegramId}` }],
    [{ text: '🔴 中止测试', callback_data: `tg:${test.id}:stop:${test.telegramId}` }]
  ] };
}

function processedCount(test) {
  return test.results.length + test.errors.length;
}

function progressText(test) {
  const processed = processedCount(test);
  const total = test.selectedAgents.length;
  const taskLabel = `${test.target}:${test.port}${test.reverse ? ' -R' : ''}`;
  if (!test.currentTaskId || !test.currentAgent) {
    return `🎯 任务提交成功，正在处理……\n任务：${taskLabel}\n已选项：${total}\n\n等待下一个 Agent……`;
  }
  const latest = db.get('SELECT second FROM test_metrics WHERE test_id = ? ORDER BY id DESC LIMIT 1', test.currentTaskId);
  const outputCount = Number(db.get('SELECT COUNT(*) AS count FROM test_output WHERE test_id = ?', test.currentTaskId)?.count || 0);
  const estimatedSecond = Math.min(test.duration, Math.max(Number(latest?.second || 0), elapsedMs(test.currentStartedAt) / 1000));
  const percent = Math.min(99, Math.max(0, (estimatedSecond / test.duration) * 100));
  const filled = Math.min(12, Math.floor((percent / 100) * 12));
  const bar = `${'█'.repeat(filled)}${'░'.repeat(12 - filled)}`;
  return `🎯 任务提交成功，正在处理……\n任务：${taskLabel}\n已选项：${total}\n\n📡 后端：${test.currentAgent.name}\n⌛ 连通性测试进行中……\n[${bar}]\n\n当前进度：${percent.toFixed(1)}% [${Math.min(test.duration, Math.floor(estimatedSecond))}/${test.duration}s]\nAgent 进度：${processed + 1}/${total}\n原始输出：${outputCount} 行\n总耗时：${formatDuration(elapsedMs(test.startedAt))}`;
}

async function renderProgress(test, force = false) {
  if (test.state !== 'running') return;
  const text = progressText(test);
  if (!force && text === test.lastProgressText) return;
  test.lastProgressText = text;
  await safeCall('editMessageText', { chat_id: test.chatId, message_id: test.messageId, text, reply_markup: progressKeyboard(test) });
}

async function finalizeBatch(test) {
  if (test.state === 'finished') return;
  test.state = 'finished';
  clearInterval(test.timer);
  const totalElapsed = elapsedMs(test.startedAt);
  const testElapsed = test.results.reduce((sum, item) => sum + item.elapsed, 0);
  const successful = test.results.filter((item) => item.status === 'completed').length;
  const failed = test.results.length - successful + test.errors.length;
  const title = test.stopRequested ? '测试已中止' : '全部测试已结束';
  const errorText = test.errors.length ? `\n未完成：${test.errors.map((item) => `${item.agent.name}（${item.error}）`).join('；').slice(0, 2500)}` : '';
  await safeCall('editMessageText', {
    chat_id: test.chatId,
    message_id: test.messageId,
    text: `${title}\n完成：${processedCount(test)}/${test.selectedAgents.length}\n成功：${successful}，失败/取消：${failed}\n⏱ 测试耗时：${formatDuration(testElapsed)}\n⏱ 总体耗时：${formatDuration(totalElapsed)}\n完成时间：${formatTimestamp(Date.now())}${errorText}`
  });
  activeTests.delete(test.id);
}

async function startNextAgent(test) {
  if (test.stopRequested || test.state !== 'running') return finalizeBatch(test);
  while (test.pendingAgents.length) {
    const agent = test.pendingAgents.shift();
    test.currentAgent = agent;
    test.currentStartedAt = Date.now();
    try {
      const task = api.createTest(test.user, { agentId: agent.id, target: test.target, port: test.port, parallel: test.parallel, duration: test.duration, protocol: 'tcp', reverse: test.reverse });
      test.currentTaskId = task.id;
      test.taskIds.add(task.id);
      api.audit(test.user.id, 'test.create.telegram', task.id, { agentId: agent.id, target: test.target, chatId: test.chatId, serialPosition: processedCount(test) + 1 });
      await renderProgress(test, true);
      return;
    } catch (error) {
      test.errors.push({ agent, error: error.message });
      test.currentAgent = null;
      test.currentTaskId = null;
    }
  }
  await finalizeBatch(test);
}

async function beginSelectedTest(test) {
  if (test.state === 'running') {
    if (test.queryId) await safeCall('answerCallbackQuery', { callback_query_id: test.queryId, text: '任务已经开始' });
    return;
  }
  test.pendingAgents = [...test.selectedAgents];
  test.taskIds = new Set();
  test.results = [];
  test.errors = [];
  test.currentAgent = null;
  test.currentTaskId = null;
  test.startedAt = Date.now();
  test.stopRequested = false;
  test.state = 'running';
  if (test.queryId) {
    await safeCall('answerCallbackQuery', { callback_query_id: test.queryId, text: `已加入 ${test.selectedAgents.length} 个 Agent，将依次测速` });
    test.queryId = null;
  }
  await renderProgress(test, true);
  const timer = setInterval(() => renderProgress(test), 2000);
  timer.unref?.();
  test.timer = timer;
  await startNextAgent(test);
}

async function finishTest(test) {
  if (test.state === 'running') {
    await safeCall('answerCallbackQuery', { callback_query_id: test.queryId, text: '任务已经开始' });
    return;
  }
  if (!test.selected.size) {
    await safeCall('answerCallbackQuery', { callback_query_id: test.queryId, text: '请至少选择一个 Agent', show_alert: true });
    return;
  }
  test.selectedAgents = test.agents.filter((agent) => test.selected.has(agent.id));
  if (test.directionRequired) {
    test.state = 'direction';
    await safeCall('answerCallbackQuery', { callback_query_id: test.queryId, text: `已选择 ${test.selectedAgents.length} 个 Agent` });
    test.queryId = null;
    await safeCall('editMessageText', {
      chat_id: test.chatId,
      message_id: test.messageId,
      text: `请选择测试方向\nAgent：${test.selectedAgents.map((agent) => agent.name).join('、')}`,
      reply_markup: directionKeyboard(test)
    });
    return;
  }
  await beginSelectedTest(test);
}

async function completeTelegramTask(task, view) {
  const test = [...activeTests.values()].find((item) => item.currentTaskId === task.id);
  if (!test) return;
  const itemElapsed = elapsedMs(view.createdAt, view.finishedAt);
  test.results.push({ agent: test.currentAgent, status: view.status, elapsed: itemElapsed });
  await safeCall('sendMessage', { chat_id: test.chatId, text: resultText(view), parse_mode: 'HTML', ...replyTo(test.replyToMessageId) });
  await sendChart(test.chatId, view, test.startedAt, test.replyToMessageId);
  test.currentTaskId = null;
  test.currentAgent = null;
  if (test.stopRequested) return finalizeBatch(test);
  await startNextAgent(test);
}

async function callbackQuery(query) {
  const data = String(query.data || '').split(':');
  if (data[0] !== 'tg') return;
  const test = activeTests.get(data[1]);
  const expected = Number(data.at(-1));
  const currentUser = boundUser(query.from?.id);
  const publicGroup = test?.publicChatId ? groupFor(test.publicChatId) : null;
  const publicAuthorized = publicGroup?.mode === 'all_members' && publicGroup.owner_user_id === test?.user.id;
  if (!test || expected !== Number(query.from?.id) || test.telegramId !== expected || (currentUser?.id !== test.user.id && !publicAuthorized)) {
    await safeCall('answerCallbackQuery', { callback_query_id: query.id, text: '无权操作此任务', show_alert: true });
    return;
  }
  test.queryId = query.id;
  const action = data[2];
  const state = test.state || 'selecting';
  const allowedActions = {
    selecting: new Set(['toggle', 'page', 'noop', 'done', 'cancel']),
    direction: new Set(['direction', 'close']),
    awaiting_private: new Set(['close']),
    running: new Set(['refresh', 'stop'])
  };
  if (!allowedActions[state]?.has(action)) {
    const text = state === 'running' ? '测速正在进行中' : state === 'direction' ? '请先选择测试方向' : '当前操作不可用';
    await safeCall('answerCallbackQuery', { callback_query_id: query.id, text, show_alert: true });
    return;
  }
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
  } else if (action === 'direction') {
    const direction = data[3];
    if (!['up', 'down'].includes(direction)) {
      await safeCall('answerCallbackQuery', { callback_query_id: query.id, text: '无效的测试方向', show_alert: true });
      return;
    }
    test.reverse = direction === 'down';
    test.directionRequired = false;
    if (test.targetRequired) {
      await safeCall('answerCallbackQuery', { callback_query_id: query.id, text: `已选择${test.reverse ? '下行' : '上行'}测试` });
      test.queryId = null;
      await requestTarget(test, test.chatId, test.replyToMessageId);
    } else {
      await beginSelectedTest(test);
    }
  } else if (action === 'close') {
    activeTests.delete(test.id);
    await safeCall('answerCallbackQuery', { callback_query_id: query.id, text: '已关闭' });
    await safeCall('deleteMessage', { chat_id: test.chatId, message_id: test.messageId });
  } else if (action === 'refresh') {
    await safeCall('answerCallbackQuery', { callback_query_id: query.id, text: '状态已刷新' });
    await renderProgress(test, true);
  } else if (action === 'stop') {
    if (test.stopRequested) {
      await safeCall('answerCallbackQuery', { callback_query_id: query.id, text: '正在中止测试' });
      return;
    }
    test.stopRequested = true;
    test.pendingAgents = [];
    await safeCall('answerCallbackQuery', { callback_query_id: query.id, text: '正在中止当前测试' });
    if (test.currentTaskId) {
      try { api.cancelTest(test.user, test.currentTaskId); }
      catch (error) {
        test.errors.push({ agent: test.currentAgent, error: `中止失败：${error.message}` });
        test.currentTaskId = null;
        test.currentAgent = null;
        await finalizeBatch(test);
      }
    } else {
      await finalizeBatch(test);
    }
  } else if (action === 'cancel') {
    activeTests.delete(test.id);
    await safeCall('answerCallbackQuery', { callback_query_id: query.id, text: '已取消' });
    await safeCall('editMessageText', { chat_id: test.chatId, message_id: test.messageId, text: '任务已取消。' });
  } else {
    await safeCall('answerCallbackQuery', { callback_query_id: query.id });
  }
}

function authorizedForPending(test, telegramId, user) {
  if (test.telegramId !== Number(telegramId)) return false;
  if (user?.id === test.user.id) return true;
  const group = test.publicChatId ? groupFor(test.publicChatId) : null;
  return group?.mode === 'all_members' && group.owner_user_id === test.user.id;
}

async function resumeTargetInPrivate(message, user, payload) {
  const value = String(payload || '');
  const directionMatch = value.match(/^iperf_(.+)_(up|down)$/);
  const id = directionMatch ? directionMatch[1] : value.replace(/^iperf_/, '');
  const test = activeTests.get(id);
  const expectedState = directionMatch ? 'direction' : 'awaiting_private';
  if (!test || test.state !== expectedState || !authorizedForPending(test, message.from.id, user)) return false;
  if (directionMatch) {
    test.reverse = directionMatch[2] === 'down';
    test.directionRequired = false;
  }
  await safeCall('editMessageText', {
    chat_id: test.chatId,
    message_id: test.messageId,
    text: `已转到私聊，等待目标 IP:端口。\nAgent：${test.selectedAgents.map((agent) => agent.name).join('、')}\n方向：${test.reverse ? '下行' : '上行'}`
  });
  await promptForTarget(test, message.chat.id, message.message_id);
  return true;
}

async function acceptTargetInput(message, user) {
  const replyMessageId = message.reply_to_message?.message_id;
  const candidates = [...activeTests.values()]
    .filter((test) => test.state === 'awaiting_target' && test.inputChatId === message.chat.id && authorizedForPending(test, message.from.id, user))
    .sort((a, b) => {
      const aReply = a.inputPromptMessageId === replyMessageId ? 1 : 0;
      const bReply = b.inputPromptMessageId === replyMessageId ? 1 : 0;
      return bReply - aReply || Number(b.promptedAt || 0) - Number(a.promptedAt || 0);
    });
  const test = candidates[0];
  if (!test) return false;
  const parsed = parseTargetInput(message.text);
  if (!parsed) {
    await promptForTarget(test, message.chat.id, test.inputReplyToMessageId);
    return true;
  }
  test.target = parsed.target;
  test.port = parsed.port;
  test.targetRequired = false;
  await beginSelectedTest(test);
  return true;
}

async function handleMessage(message) {
  const from = message.from;
  const chat = message.chat;
  const text = String(message.text || '').trim();
  if (!from || !chat || !text) return;
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  let user = boundUser(from.id);
  const requesterUser = user;
  if (command === '/bind') {
    const failure = bindFailures.get(from.id);
    if (failure && failure.blockedUntil > Date.now()) {
      await safeCall('sendMessage', { chat_id: chat.id, text: '绑定尝试过多，请稍后再试。', ...replyTo(message.message_id) });
      return;
    }
    const code = parts[1] || '';
    const row = db.get(`SELECT c.* FROM telegram_bind_codes c JOIN users u ON u.id = c.user_id
                        WHERE c.code = ? AND c.expires_at > ? AND u.disabled = 0`, code, db.now());
    if (!row) {
      const attempts = (failure?.attempts || 0) + 1;
      bindFailures.set(from.id, { attempts: attempts >= 5 ? 0 : attempts, blockedUntil: attempts >= 5 ? Date.now() + 10 * 60 * 1000 : 0 });
      await safeCall('sendMessage', { chat_id: chat.id, text: '验证码无效或已过期。', ...replyTo(message.message_id) });
      return;
    }
    db.run('DELETE FROM telegram_users WHERE user_id = ? OR telegram_id = ?', row.user_id, from.id);
    db.run('INSERT INTO telegram_users (telegram_id, user_id, telegram_username, chat_id, bound_at) VALUES (?, ?, ?, ?, ?)', from.id, row.user_id, from.username || '', chat.id, db.now());
    db.run('DELETE FROM telegram_bind_codes WHERE code = ?', code);
    bindFailures.delete(from.id);
    await safeCall('sendMessage', { chat_id: chat.id, text: '绑定成功，现在可以使用 /agents 和 /iperf。', ...replyTo(message.message_id) });
    return;
  }
  if (command === '/start' && parts[1]?.startsWith('iperf_') && chat.type === 'private') {
    if (await resumeTargetInPrivate(message, user, parts[1])) return;
  }
  if (!text.startsWith('/') && await acceptTargetInput(message, user)) return;
  if (!user && chat.type === 'private') {
    await safeCall('sendMessage', { chat_id: chat.id, text: '未授权：请先登录网页端，在 Telegram 页面生成绑定码，然后发送 /bind 验证码。', ...replyTo(message.message_id) });
    return;
  }
  user = user || publicGroupUser(chat);
  if (user && !requesterUser && chat.type !== 'private') user = { ...user, publicChatId: chat.id };
  if (!user) {
    await safeCall('sendMessage', { chat_id: chat.id, text: '未授权：请先在网页端绑定 Telegram。私有群组只响应已绑定用户。', ...replyTo(message.message_id) });
    return;
  }
  if (!canUseChat(message, user)) {
    await safeCall('sendMessage', { chat_id: chat.id, text: '此群组当前不可用，或普通用户已登记过其他群组。', ...replyTo(message.message_id) });
    return;
  }
  if (command === '/start' || command === '/help') return sendHelp(chat.id, message.message_id);
  if (command === '/status') return sendStatus(chat.id, user, chat, message.message_id);
  if (command === '/agents') {
    const agents = accessibleAgents(user);
    await safeCall('sendMessage', { chat_id: chat.id, text: agents.length ? agents.map((a) => `${a.name} - ${a.status}`).join('\n') : '没有可用的在线 Agent。', ...replyTo(message.message_id) });
    return;
  }
  if (command === '/iperf') return startTestFromTelegram(chat, from.id, user, parts.slice(1), message.message_id);
}

async function handleChatMember(update) {
  const chat = update.chat;
  if (!chat || chat.type === 'private') return;
  const oldStatus = update.old_chat_member?.status;
  const newStatus = update.new_chat_member?.status;
  const activeStatuses = new Set(['member', 'administrator', 'restricted']);
  if (activeStatuses.has(newStatus) && !activeStatuses.has(oldStatus)) {
    const user = boundUser(update.from?.id);
    if (!user) {
      await safeCall('sendMessage', { chat_id: chat.id, text: 'Bot 已加入，但添加者尚未绑定 NetPilot。请先在网页 Telegram 页面完成绑定后发送 /status。' });
      return;
    }
    const group = ensureGroup(chat, user);
    if (!group) {
      await safeCall('sendMessage', { chat_id: chat.id, text: '群组登记失败：普通用户最多登记一个群组，请先在网页 Telegram 页面移除旧群组。' });
      return;
    }
    await safeCall('sendMessage', { chat_id: chat.id, text: '群组已登记为私有模式，仅已绑定 Telegram 的 NetPilot 用户可以调用。管理员可在网页切换为公共模式。' });
  } else if (!activeStatuses.has(newStatus) && activeStatuses.has(oldStatus)) {
    db.run('DELETE FROM telegram_groups WHERE chat_id = ?', chat.id);
  }
}

async function poll(generation, botToken) {
  let offset = Number(api.getSettings().telegram_update_offset || 0);
  while (generation === botGeneration && bot && !stopping && token() === botToken) {
    try {
      const updates = await call('getUpdates', { offset, timeout: 35, allowed_updates: ['message', 'callback_query', 'my_chat_member'] });
      if (generation !== botGeneration || token() !== botToken) break;
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.callback_query) await callbackQuery(update.callback_query);
        else if (update.message) await handleMessage(update.message);
        else if (update.my_chat_member) await handleChatMember(update.my_chat_member);
      }
      if (updates.length) db.run(`INSERT INTO settings (key, value, updated_at) VALUES ('telegram_update_offset', ?, ?)
                                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, String(offset), db.now());
    } catch (error) {
      if (!stopping) { console.error('[netpilot] telegram polling:', error.message); await new Promise((resolve) => setTimeout(resolve, 3000)); }
    }
  }
}

export async function startTelegramBot() {
  if (process.env.NETPILOT_DISABLE_TELEGRAM === '1') return;
  if (!api || !db) return;
  const generation = ++botGeneration;
  const botToken = token();
  if (!botToken) { bot = null; globalThis.netpilotTelegramReload = startTelegramBot; return; }
  stopping = false;
  bot = { token: botToken };
  const me = await safeCall('getMe');
  if (me) {
    console.log(`[netpilot] telegram bot @${me.username} enabled`);
    await safeCall('setMyCommands', { commands: [
      { command: 'help', description: '查看命令帮助' },
      { command: 'status', description: '查看授权与 Bot 状态' },
      { command: 'bind', description: '绑定网页账户' },
      { command: 'agents', description: '查看可用 Agent' },
      { command: 'iperf', description: '交互测速，或附带 IP 快捷上行' }
    ] });
  }
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

export const telegramTest = { activeTests, beginSelectedTest, callbackQuery, chartSvg, completeTelegramTask, directionKeyboard, finishTest, handleChatMember, handleMessage, parseIperfArgs, parseTargetInput, privateTargetKeyboard, progressKeyboard, selectionKeyboard };
