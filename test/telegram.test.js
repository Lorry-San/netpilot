import assert from 'node:assert/strict';
import test from 'node:test';

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

    assert.deepEqual(telegramTest.parseIperfArgs(['198.51.100.1']), { target: '198.51.100.1', port: 5201, parallel: 1, duration: 10, reverse: false });
    assert.deepEqual(telegramTest.parseIperfArgs(['198.51.100.1', '-R']), { target: '198.51.100.1', port: 5201, parallel: 1, duration: 10, reverse: true });
    assert.deepEqual(telegramTest.parseIperfArgs(['-R', '198.51.100.1']), { target: '198.51.100.1', port: 5201, parallel: 1, duration: 10, reverse: true });
    assert.deepEqual(telegramTest.parseIperfArgs(['198.51.100.1', '5202', '4', '30', '-R']), { target: '198.51.100.1', port: 5202, parallel: 4, duration: 30, reverse: true });
    assert.equal(telegramTest.parseIperfArgs(['198.51.100.1', '70000']), null);
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
    assert.deepEqual(registration.body.commands.map((command) => command.command), ['help', 'status', 'bind', 'agents', 'iperf']);
  } finally {
    if (originalDisable === undefined) delete process.env.NETPILOT_DISABLE_TELEGRAM;
    else process.env.NETPILOT_DISABLE_TELEGRAM = originalDisable;
    globalThis.netpilotServerApi = originalApi;
    globalThis.fetch = originalFetch;
  }
});
