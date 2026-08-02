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

    const svg = telegramTest.chartSvg([{ second: 1, sendMbps: 120, recvMbps: 90 }]);
    assert.match(svg, /Mbps/);
    assert.match(svg, /Time \(s\)/);
    assert.match(svg, /polyline/);
  } finally {
    globalThis.netpilotServerApi = originalApi;
    globalThis.fetch = originalFetch;
  }
});
