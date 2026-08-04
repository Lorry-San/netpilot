import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import test from 'node:test';
import { Resvg } from '@resvg/resvg-js';

test('Telegram picker binds callbacks to requester and rejects other users', async () => {
  const originalApi = globalThis.netpilotServerApi;
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.netpilotServerApi = {
    db: { get() {}, all() { return []; }, run() {}, now() { return new Date().toISOString(); } },
    getSettings() { return { telegram_bot_token: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }; }
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, status: 200, async json() { return { ok: true, result: true }; } };
  };

  try {
    const { telegramTest } = await import(`../src/telegram.js?test=${Date.now()}`);
    const pending = {
      id: 'tg_test',
      telegramId: 42,
      chatId: 100,
      messageId: 7,
      agents: [{ id: 'agent_one', name: 'Agent One', status: 'online' }],
      selected: new Set(),
      page: 0
    };
    telegramTest.activeTests.set(pending.id, pending);
    const keyboard = telegramTest.selectionKeyboard(pending);
    assert.match(keyboard.inline_keyboard[0][0].callback_data, /:42$/);
    assert.ok(keyboard.inline_keyboard.flat().every((button) => button.callback_data.length <= 64));

    await telegramTest.callbackQuery({ id: 'query-1', from: { id: 99 }, data: 'tg:tg_test:toggle:agent_one:42' });
    assert.equal(pending.selected.size, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.callback_query_id, 'query-1');
    assert.equal(requests[0].body.show_alert, true);
    assert.match(requests[0].body.text, /无权/);

    const svg = telegramTest.chartSvg([
      { second: 1, sendMbps: 120.5, recvMbps: 90.25 },
      { second: 2, sendMbps: 130.75, recvMbps: 95.5 }
    ]);
    assert.match(svg, /Speed \(Mbps\)/);
    assert.match(svg, /Time \(s\)/);
    assert.match(svg, /polyline/);
    assert.match(svg, /<circle/);
    assert.match(svg, />120\.5</);
    assert.match(svg, />90\.25</);
    assert.match(svg, />1</);
    assert.match(svg, />2</);

    assert.deepEqual(telegramTest.parseIperfArgs(['198.51.100.1']), { target: '198.51.100.1', port: 5201, parallel: 1, duration: 10, reverse: false, reverseSpecified: false });
    assert.deepEqual(telegramTest.parseIperfArgs(['198.51.100.1', '-R']), { target: '198.51.100.1', port: 5201, parallel: 1, duration: 10, reverse: true, reverseSpecified: true });
    assert.deepEqual(telegramTest.parseIperfArgs(['-R', '198.51.100.1']), { target: '198.51.100.1', port: 5201, parallel: 1, duration: 10, reverse: true, reverseSpecified: true });
    assert.deepEqual(telegramTest.parseIperfArgs(['198.51.100.1', '5202', '4', '30', '-R']), { target: '198.51.100.1', port: 5202, parallel: 4, duration: 30, reverse: true, reverseSpecified: true });
    assert.equal(telegramTest.parseIperfArgs(['198.51.100.1', '70000']), null);
    assert.deepEqual(telegramTest.parseTargetInput('198.51.100.1'), { target: '198.51.100.1', port: 5201 });
    assert.deepEqual(telegramTest.parseTargetInput('198.51.100.1:5202'), { target: '198.51.100.1', port: 5202 });
    assert.deepEqual(telegramTest.parseTargetInput('[2001:db8::1]:5203'), { target: '2001:db8::1', port: 5203 });
    assert.equal(telegramTest.parseTargetInput('198.51.100.1:70000'), null);
    assert.deepEqual(telegramTest.parseNextTraceArgs(['1.1.1.1']), { target: '1.1.1.1', addressFamily: 'auto', protocol: 'icmp', port: null, queries: 3, maxHops: 30, timeoutMs: 1000, parallelRequests: 18, packetSize: 0, reverseDns: true, mpls: true, mapTrace: false });
    assert.deepEqual(telegramTest.parseNextTraceArgs(['-T', '-p', '443', '-4', '-q', '5', '--psize=128', 'example.com']), { target: 'example.com', addressFamily: 'ipv4', protocol: 'tcp', port: 443, queries: 5, maxHops: 30, timeoutMs: 1000, parallelRequests: 18, packetSize: 128, reverseDns: true, mpls: true, mapTrace: false });
    assert.equal(telegramTest.parseNextTraceArgs(['--json', '1.1.1.1']), null);
  } finally {
    globalThis.netpilotServerApi = originalApi;
    globalThis.fetch = originalFetch;
  }
});

test('Telegram multi-Agent tests run serially and upload charts as documents', async () => {
  const originalApi = globalThis.netpilotServerApi;
  const originalFetch = globalThis.fetch;
  const createdAgents = [];
  const uploads = [];
  const messages = [];
  let taskNumber = 0;
  globalThis.netpilotServerApi = {
    db: {
      get(sql) {
        if (sql.includes('COUNT(*)')) return { count: 1 };
        if (sql.includes('SELECT second')) return { second: 1 };
        return null;
      },
      all() { return []; },
      run() {},
      now() { return new Date().toISOString(); }
    },
    getSettings() { return { telegram_bot_token: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }; },
    createTest(_user, body) {
      createdAgents.push(body.agentId);
      taskNumber += 1;
      return { id: `task_${taskNumber}`, agent_id: body.agentId };
    },
    audit() {}
  };
  globalThis.fetch = async (url, options) => {
    if (options.body instanceof FormData) uploads.push({ url: String(url), body: options.body });
    else messages.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, status: 200, async json() { return { ok: true, result: { message_id: 9 } }; } };
  };

  let telegramTest;
  try {
    ({ telegramTest } = await import(`../src/telegram.js?serial=${Date.now()}`));
    const pending = {
      id: 'tg_serial',
      telegramId: 42,
      chatId: 100,
      messageId: 7,
      replyToMessageId: 321,
      user: { id: 2, role: 'user' },
      target: '192.0.2.1',
      port: 5201,
      parallel: 1,
      duration: 10,
      reverse: true,
      agents: [
        { id: 'agent_one', name: 'Agent One', status: 'online' },
        { id: 'agent_two', name: 'Agent Two', status: 'online' }
      ],
      selected: new Set(['agent_one', 'agent_two']),
      page: 0,
      queryId: 'query-start',
      state: 'selecting'
    };
    telegramTest.activeTests.set(pending.id, pending);
    await telegramTest.finishTest(pending);
    assert.deepEqual(createdAgents, ['agent_one']);

    const completedView = (agentName, finishedAt = new Date().toISOString()) => ({
      status: 'completed',
      agentName,
      target: '192.0.2.1',
      port: 5201,
      protocol: 'tcp',
      reverse: true,
      duration: 10,
      createdAt: new Date(Date.now() - 1000).toISOString(),
      finishedAt,
      metrics: [{ second: 1, sendMbps: 100, recvMbps: 100 }],
      output: [{ line: '[  5] 0.00-1.00 sec 100 Mbits/sec' }]
    });
    await telegramTest.completeTelegramTask({ id: 'task_1' }, completedView('Agent One'));
    assert.deepEqual(createdAgents, ['agent_one', 'agent_two']);
    assert.equal(uploads.length, 1);
    assert.match(uploads[0].url, /\/sendDocument$/);
    assert.ok(uploads[0].body.get('document') instanceof Blob);
    assert.deepEqual(JSON.parse(uploads[0].body.get('reply_parameters')), { message_id: 321 });
    assert.deepEqual(messages.find((request) => request.url.endsWith('/sendMessage')).body.reply_parameters, { message_id: 321 });

    await telegramTest.completeTelegramTask({ id: 'task_2' }, completedView('Agent Two'));
    assert.equal(telegramTest.activeTests.has(pending.id), false);
    assert.equal(uploads.length, 2);
  } finally {
    if (telegramTest) {
      for (const pending of telegramTest.activeTests.values()) clearInterval(pending.timer);
      telegramTest.activeTests.clear();
    }
    globalThis.netpilotServerApi = originalApi;
    globalThis.fetch = originalFetch;
  }
});

test('Telegram private groups redact iperf targets for every caller, including the group owner', async () => {
  const originalApi = globalThis.netpilotServerApi;
  const originalFetch = globalThis.fetch;
  const requests = [];
  const uploads = [];
  const created = [];
  const target = '203.0.113.25';
  let groupMode = 'members_only';
  globalThis.netpilotServerApi = {
    db: {
      get(sql) {
        if (sql.includes('FROM telegram_users')) return { id: 1, username: 'admin', displayName: 'System Admin', role: 'admin', disabled: 0 };
        if (sql.startsWith('SELECT * FROM telegram_groups')) return { chat_id: -1001, title: 'Private Group', owner_user_id: 1, mode: groupMode };
        if (sql.includes('SELECT second')) return { second: 1 };
        if (sql.includes('COUNT(*)')) return { count: 1 };
        return null;
      },
      all() { return [{ id: 'agent_one', name: 'Agent One', status: 'online' }]; },
      run() {},
      now() { return new Date().toISOString(); }
    },
    getSettings() { return { telegram_bot_token: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }; },
    createTest(_user, body) {
      created.push(body);
      return { id: 'task_private_group', agent_id: body.agentId };
    },
    audit() {}
  };
  globalThis.fetch = async (url, options) => {
    if (options.body instanceof FormData) uploads.push({ url: String(url), body: options.body });
    else requests.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, status: 200, async json() { return { ok: true, result: { message_id: 9 } }; } };
  };

  let telegramTest;
  try {
    ({ telegramTest } = await import(`../src/telegram.js?private-redaction=${Date.now()}`));
    await telegramTest.handleMessage({ message_id: 700, from: { id: 42 }, chat: { id: -1001, type: 'group', title: 'Private Group' }, text: `/iperf ${target}` });
    const picker = requests.find((request) => request.url.endsWith('/sendMessage'));
    assert.match(picker.body.text, /x\.x\.x\.x:5201/);
    assert.doesNotMatch(picker.body.text, new RegExp(target.replaceAll('.', '\\.')));

    const pending = [...telegramTest.activeTests.values()][0];
    assert.equal(pending.redactTarget, true);
    await telegramTest.callbackQuery({ id: 'private-toggle', from: { id: 42 }, data: `tg:${pending.id}:toggle:agent_one:42` });
    await telegramTest.callbackQuery({ id: 'private-done', from: { id: 42 }, data: `tg:${pending.id}:done:42` });
    assert.equal(created[0].target, target);
    const progress = requests.find((request) => request.url.endsWith('/editMessageText') && request.body.text.includes('任务：'));
    assert.match(progress.body.text, /任务：x\.x\.x\.x:5201/);
    assert.doesNotMatch(progress.body.text, new RegExp(target.replaceAll('.', '\\.')));

    const finishedAt = new Date().toISOString();
    const view = {
      status: 'completed', agentName: 'Agent One', target, port: 5201, protocol: 'tcp', reverse: false, duration: 10,
      createdAt: new Date(Date.now() - 1000).toISOString(), finishedAt,
      metrics: [{ second: 1, sendMbps: 100, recvMbps: 100 }],
      output: [
        { line: `Connecting to host ${target}, port 5201` },
        { line: `[  5] local 192.0.2.50 connected to ${target} port 5201` }
      ]
    };
    const result = telegramTest.resultText(view, pending);
    const svg = telegramTest.iperfChartSvg(view, pending);
    assert.match(result, /目标：x\.x\.x\.x:5201/);
    assert.doesNotMatch(result, new RegExp(target.replaceAll('.', '\\.')));
    assert.match(svg, /x\.x\.x\.x:5201/);
    assert.doesNotMatch(svg, new RegExp(target.replaceAll('.', '\\.')));

    await telegramTest.completeTelegramTask({ id: 'task_private_group' }, view);
    const finalMessage = requests.find((request) => request.url.endsWith('/sendMessage') && request.body.parse_mode === 'HTML');
    assert.match(finalMessage.body.text, /x\.x\.x\.x:5201/);
    assert.doesNotMatch(finalMessage.body.text, new RegExp(target.replaceAll('.', '\\.')));
    assert.equal(uploads.length, 1);
    assert.ok(uploads[0].body.get('document') instanceof Blob);

    groupMode = 'all_members';
    requests.length = 0;
    await telegramTest.handleMessage({ message_id: 701, from: { id: 42 }, chat: { id: -1001, type: 'group', title: 'Public Group' }, text: `/iperf ${target}` });
    const publicPicker = requests.find((request) => request.url.endsWith('/sendMessage'));
    assert.match(publicPicker.body.text, new RegExp(target.replaceAll('.', '\\.')));
    assert.equal([...telegramTest.activeTests.values()][0].redactTarget, false);
  } finally {
    if (telegramTest) {
      for (const pending of telegramTest.activeTests.values()) clearInterval(pending.timer);
      telegramTest.activeTests.clear();
    }
    globalThis.netpilotServerApi = originalApi;
    globalThis.fetch = originalFetch;
  }
});

test('Telegram interactive mode chooses direction before accepting the target in private chat', async () => {
  const originalApi = globalThis.netpilotServerApi;
  const originalFetch = globalThis.fetch;
  const requests = [];
  const created = [];
  globalThis.netpilotServerApi = {
    db: {
      get(sql) {
        if (sql.includes('FROM telegram_users')) return { id: 2, username: 'user', displayName: 'User', role: 'user', disabled: 0 };
        if (sql.includes('COUNT(*)')) return { count: 0 };
        return null;
      },
      all() { return []; },
      run() {},
      now() { return new Date().toISOString(); }
    },
    getSettings() { return { telegram_bot_token: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', telegram_bot_username: 'netpilot_test_bot' }; },
    createTest(_user, body) {
      created.push(body);
      return { id: `task_${created.length}` };
    },
    audit() {}
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, status: 200, async json() { return { ok: true, result: true }; } };
  };

  let telegramTest;
  try {
    ({ telegramTest } = await import(`../src/telegram.js?direction=${Date.now()}`));
    const makePending = (id) => ({
      id,
      telegramId: 42,
      chatId: 100,
      chatType: 'private',
      messageId: 7,
      replyToMessageId: 55,
      user: { id: 2, role: 'user' },
      target: '',
      port: 5201,
      parallel: 1,
      duration: 10,
      reverse: false,
      directionRequired: true,
      targetRequired: true,
      agents: [{ id: 'agent_one', name: 'Agent One', status: 'online' }],
      selected: new Set(['agent_one']),
      page: 0,
      queryId: `done_${id}`,
      state: 'selecting'
    });

    const upload = makePending('tg_upload');
    telegramTest.activeTests.set(upload.id, upload);
    await telegramTest.finishTest(upload);
    assert.equal(upload.state, 'direction');
    assert.equal(created.length, 0);
    const directionEdit = requests.find((request) => request.url.endsWith('/editMessageText'));
    assert.deepEqual(directionEdit.body.reply_markup.inline_keyboard.map((row) => row.map((button) => button.text)), [
      ['上行测试', '下行测试'],
      ['关闭页面']
    ]);
    await telegramTest.callbackQuery({ id: 'direction-up', from: { id: 42 }, data: 'tg:tg_upload:direction:up:42' });
    assert.equal(upload.state, 'awaiting_target');
    assert.equal(created.length, 0);
    const targetPrompt = requests.find((request) => request.url.endsWith('/sendMessage'));
    assert.equal(targetPrompt.body.reply_markup.force_reply, true);
    assert.deepEqual(targetPrompt.body.reply_parameters, { message_id: 55 });
    await telegramTest.handleMessage({ message_id: 56, reply_to_message: { message_id: targetPrompt.body.message_id }, from: { id: 42 }, chat: { id: 100, type: 'private' }, text: '192.0.2.10:5202' });
    assert.equal(upload.state, 'running');
    assert.equal(created[0].reverse, false);
    assert.equal(created[0].target, '192.0.2.10');
    assert.equal(created[0].port, 5202);

    const download = makePending('tg_download');
    download.chatId = -1001;
    download.chatType = 'group';
    telegramTest.activeTests.set(download.id, download);
    await telegramTest.finishTest(download);
    const privateButton = requests
      .filter((request) => request.url.endsWith('/editMessageText'))
      .flatMap((request) => request.body.reply_markup?.inline_keyboard?.flat() || [])
      .find((button) => button.url?.endsWith('_down'));
    assert.match(privateButton.url, /t\.me\/netpilot_test_bot\?start=iperf_tg_download_down$/);
    await telegramTest.handleMessage({ message_id: 70, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: '/start iperf_tg_download_down' });
    assert.equal(download.state, 'awaiting_target');
    assert.equal(download.inputChatId, 42);
    await telegramTest.handleMessage({ message_id: 71, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: '198.51.100.20' });
    assert.equal(download.state, 'running');
    assert.equal(created[1].reverse, true);
    assert.equal(created[1].target, '198.51.100.20');

    const closed = makePending('tg_close');
    telegramTest.activeTests.set(closed.id, closed);
    await telegramTest.finishTest(closed);
    await telegramTest.callbackQuery({ id: 'direction-close', from: { id: 42 }, data: 'tg:tg_close:close:42' });
    assert.equal(telegramTest.activeTests.has(closed.id), false);
    assert.ok(requests.some((request) => request.url.endsWith('/deleteMessage')));
  } finally {
    if (telegramTest) {
      for (const pending of telegramTest.activeTests.values()) clearInterval(pending.timer);
      telegramTest.activeTests.clear();
    }
    globalThis.netpilotServerApi = originalApi;
    globalThis.fetch = originalFetch;
  }
});

test('Telegram no-argument and quick commands use distinct flows and reply to the invoking message', async () => {
  const originalApi = globalThis.netpilotServerApi;
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.netpilotServerApi = {
    db: {
      get(sql) {
        if (sql.includes('FROM telegram_users')) return { id: 2, username: 'user', displayName: 'User', role: 'user', disabled: 0 };
        if (sql.includes('COUNT(*)')) return { count: 0 };
        return null;
      },
      all() { return [{ id: 'agent_one', name: 'Agent One', status: 'online' }]; },
      run() {},
      now() { return new Date().toISOString(); }
    },
    getSettings() { return { telegram_bot_token: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', telegram_bot_username: 'netpilot_test_bot' }; },
    createTest(_user, body) { return { id: 'task_quick', ...body }; },
    audit() {}
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, status: 200, async json() { return { ok: true, result: { message_id: 9 } }; } };
  };

  let telegramTest;
  try {
    ({ telegramTest } = await import(`../src/telegram.js?reply=${Date.now()}`));
    await telegramTest.handleMessage({ message_id: 455, from: { id: 42 }, chat: { id: 100, type: 'private' }, text: '/iperf' });
    const picker = requests.find((request) => request.url.endsWith('/sendMessage'));
    assert.deepEqual(picker.body.reply_parameters, { message_id: 455 });
    const interactive = [...telegramTest.activeTests.values()][0];
    assert.equal(interactive.directionRequired, true);
    assert.equal(interactive.targetRequired, true);
    telegramTest.activeTests.clear();

    await telegramTest.handleMessage({ message_id: 456, from: { id: 42 }, chat: { id: 100, type: 'private' }, text: '/iperf 192.0.2.1' });
    const quick = [...telegramTest.activeTests.values()][0];
    assert.equal(quick.replyToMessageId, 456);
    assert.equal(quick.directionRequired, false);
    assert.equal(quick.targetRequired, false);
    await telegramTest.callbackQuery({ id: 'quick-toggle', from: { id: 42 }, data: `tg:${quick.id}:toggle:agent_one:42` });
    await telegramTest.callbackQuery({ id: 'quick-done', from: { id: 42 }, data: `tg:${quick.id}:done:42` });
    assert.equal(quick.state, 'running');
    assert.equal(quick.reverse, false);
  } finally {
    telegramTest?.activeTests.clear();
    globalThis.netpilotServerApi = originalApi;
    globalThis.fetch = originalFetch;
  }
});

test('Telegram rejects unbound private messages and permits public-group members', async () => {
  const originalApi = globalThis.netpilotServerApi;
  const originalFetch = globalThis.fetch;
  const requests = [];
  let publicGroup = false;
  globalThis.netpilotServerApi = {
    db: {
      get(sql) {
        if (sql.includes('FROM telegram_users')) return null;
        if (sql.startsWith('SELECT * FROM telegram_groups')) return publicGroup ? { chat_id: -1001, title: 'Public Group', owner_user_id: 1, mode: 'all_members' } : null;
        if (sql.includes('FROM users WHERE id')) return { id: 1, username: 'admin', displayName: 'System Admin', role: 'admin', disabled: 0 };
        if (sql.includes('COUNT(*)')) return { count: 1 };
        return null;
      },
      all() { return [{ id: 'agent_one', name: 'Agent One', status: 'online' }]; },
      run() {},
      now() { return new Date().toISOString(); }
    },
    getSettings() { return { telegram_bot_token: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }; }
  };
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, status: 200, async json() { return { ok: true, result: true }; } };
  };

  try {
    const { telegramTest } = await import(`../src/telegram.js?authorization=${Date.now()}`);
    await telegramTest.handleMessage({ from: { id: 99 }, chat: { id: 99, type: 'private' }, text: '/help' });
    assert.match(requests.at(-1).text, /未授权/);

    const privateGroup = { id: -1001, type: 'group', title: 'Private Group' };
    const requestCount = requests.length;
    await telegramTest.handleMessage({
      message_id: 10,
      reply_to_message: { message_id: 9, from: { is_bot: true } },
      from: { id: 99 },
      chat: privateGroup,
      text: '这是回复 Bot 的普通群聊消息'
    });
    await telegramTest.handleMessage({ message_id: 11, from: { id: 99 }, chat: privateGroup, text: '/status@another_bot' });
    await telegramTest.handleMessage({ message_id: 12, from: { id: 99 }, chat: privateGroup, text: '/unrelated' });
    assert.equal(requests.length, requestCount, 'group chatter and commands for other bots must be ignored');

    await telegramTest.handleMessage({ message_id: 13, from: { id: 99 }, chat: privateGroup, text: '/status' });
    assert.equal(requests.length, requestCount + 1);
    assert.match(requests.at(-1).text, /未授权/);

    publicGroup = true;
    await telegramTest.handleMessage({ from: { id: 99 }, chat: { id: -1001, type: 'group', title: 'Public Group' }, text: '/status' });
    assert.match(requests.at(-1).text, /NetPilot Bot：在线/);
    assert.match(requests.at(-1).text, /公共模式/);

    const publicPicker = {
      id: 'tg_public', telegramId: 99, publicChatId: -1001, chatId: -1001, messageId: 8,
      user: { id: 1, role: 'admin' }, agents: [{ id: 'agent_one', name: 'Agent One', status: 'online' }],
      selected: new Set(), page: 0
    };
    telegramTest.activeTests.set(publicPicker.id, publicPicker);
    await telegramTest.callbackQuery({ id: 'query-public', from: { id: 99 }, data: 'tg:tg_public:toggle:agent_one:99' });
    assert.deepEqual([...publicPicker.selected], ['agent_one']);
  } finally {
    globalThis.netpilotServerApi = originalApi;
    globalThis.fetch = originalFetch;
  }
});

test('Telegram registers its command menu when the Bot starts', async () => {
  const originalApi = globalThis.netpilotServerApi;
  const originalFetch = globalThis.fetch;
  const originalDisable = process.env.NETPILOT_DISABLE_TELEGRAM;
  const requests = [];
  let settingsCalls = 0;
  const botToken = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  delete process.env.NETPILOT_DISABLE_TELEGRAM;
  globalThis.netpilotServerApi = {
    db: { get() {}, all() { return []; }, run() {}, now() { return new Date().toISOString(); } },
    getSettings() {
      settingsCalls += 1;
      return settingsCalls <= 3 ? { telegram_bot_token: botToken } : {};
    },
    onTaskComplete() {}
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    const result = String(url).endsWith('/getMe') ? { username: 'netpilot_test_bot' } : true;
    return { ok: true, status: 200, async json() { return { ok: true, result }; } };
  };

  try {
    const module = await import(`../src/telegram.js?commands=${Date.now()}`);
    await module.startTelegramBot();
    const registration = requests.find((request) => request.url.endsWith('/setMyCommands'));
    assert.ok(registration);
    assert.deepEqual(registration.body.commands.map((command) => command.command), ['help', 'status', 'bind', 'agents', 'iperf', 'nexttrace']);
  } finally {
    if (originalDisable === undefined) delete process.env.NETPILOT_DISABLE_TELEGRAM;
    else process.env.NETPILOT_DISABLE_TELEGRAM = originalDisable;
    globalThis.netpilotServerApi = originalApi;
    globalThis.fetch = originalFetch;
  }
});

// Production containers ship no system fonts, and resvg silently drops text it
// cannot shape: charts arrived without axis numbers, point values or legend
// labels. The PNG must be rasterized with the bundled font so labels survive
// headless hosts.
test('Telegram chart PNG keeps labels when the host has no fonts', async () => {
  const { telegramTest } = await import(`../src/telegram.js?chartfont=${Date.now()}`);
  assert.ok(statSync(telegramTest.chartFontPath).size > 1_000_000, 'bundled chart font must exist');

  const svg = telegramTest.chartSvg(
    [
      { second: 1, sendMbps: 940.25, recvMbps: 940.25 },
      { second: 2, sendMbps: 870.5, recvMbps: 870.5 },
      { second: 3, sendMbps: 901.75, recvMbps: 901.75 }
    ],
    { title: '广州节点 - x.x.x.x:5201' }
  );
  const width = 1440;
  const fontless = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: false } }).render().asPng();
  const bundled = new Resvg(svg, telegramTest.chartResvgOptions(width, { systemFonts: false })).render().asPng();

  assert.notEqual(Buffer.compare(bundled, fontless), 0, 'bundled font render must draw glyphs a fontless render cannot');
  assert.ok(bundled.length > fontless.length, 'labeled chart must produce more pixels than the textless blank chart');
});

// /help used parse_mode HTML with unescaped angle-bracket placeholders, so
// Telegram rejected it with "Can't parse entities" and safeCall swallowed the
// error: help produced no output in groups and private chats alike. Guard both
// the reply path and the entity-safety invariant for every HTML message.
const SUPPORTED_TELEGRAM_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'a', 'code', 'pre', 'tg-spoiler', 'blockquote']);
function assertTelegramEntitiesSafe(body) {
  if (body.parse_mode !== 'HTML') return;
  assert.doesNotMatch(body.text, /<(?![a-zA-Z/])/, 'HTML message must not contain raw unescaped angle-bracket placeholders');
  for (const match of body.text.matchAll(/<\s*\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/g)) {
    assert.ok(SUPPORTED_TELEGRAM_TAGS.has(match[1].toLowerCase()), `unsupported tag <${match[1]}> in HTML message`);
  }
}

test('Telegram /help replies in an authorized group with entity-safe text', async () => {
  const originalApi = globalThis.netpilotServerApi;
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.netpilotServerApi = {
    db: {
      get(sql) {
        if (sql.includes('FROM telegram_users')) return { id: 1, username: 'admin', displayName: 'System Admin', role: 'admin', disabled: 0, telegramId: 7, telegramUsername: 'admin' };
        if (sql.startsWith('SELECT * FROM telegram_groups')) return { chat_id: -1001, title: 'Authorized Group', owner_user_id: 1, mode: 'members_only' };
        if (sql.includes('COUNT(*)')) return { count: 1 };
        return null;
      },
      all() { return []; },
      run() {},
      now() { return new Date().toISOString(); }
    },
    getSettings() { return { telegram_bot_token: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }; }
  };
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, status: 200, async json() { return { ok: true, result: true }; } };
  };

  try {
    const { telegramTest } = await import(`../src/telegram.js?help=${Date.now()}`);
    const group = { id: -1001, type: 'group', title: 'Authorized Group' };

    await telegramTest.handleMessage({ message_id: 20, from: { id: 7 }, chat: group, text: '/help' });
    assert.equal(requests.length, 1, 'authorized group /help must produce exactly one reply');
    assert.match(requests[0].text, /查看命令帮助/);
    assert.match(requests[0].text, /\/bind/);
    assertTelegramEntitiesSafe(requests[0]);

    await telegramTest.handleMessage({ message_id: 21, from: { id: 7 }, chat: { id: 7, type: 'private' }, text: '/help' });
    assert.equal(requests.length, 2, 'private /help must also reply');
    assertTelegramEntitiesSafe(requests[1]);
  } finally {
    globalThis.netpilotServerApi = originalApi;
    globalThis.fetch = originalFetch;
  }
});
