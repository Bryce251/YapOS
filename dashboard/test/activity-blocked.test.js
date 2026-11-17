import test from 'node:test';
import assert from 'node:assert/strict';
import { room } from './activity-kit.test.js';
import story, { KEY, lineKey } from '../web/activity/js/games/story.js';
import { checkWord } from '../web/activity/js/games/chain.js';
import { cleanShared, hidesWords } from '../web/activity/js/text.js';
import { encodeTerm, customKey, setCustomTerms, customTermCount, isBlockedGameWord } from '../web/activity/js/filter.js';
import { configureBlocked, resetBlocked, loadBlocked, startBlocked, blockedCount, BLOCKED_ENDPOINT, BLOCKED_REFRESH_MS, BLOCKED_RETRY_MS } from '../web/activity/js/blocked.js';

const enc = (list) => list.map((w) => encodeTerm(customKey(w)));

function fakeTimers() {
  const queue = [];
  return {
    queue,
    setTimeout: (fn, ms) => {
      const t = { fn, ms };
      queue.push(t);
      return t;
    },
    clearTimeout: (t) => {
      const i = queue.indexOf(t);
      if (i >= 0) queue.splice(i, 1);
    },
    async run() {
      const t = queue.shift();
      await t.fn();
    },
  };
}

function reply(body, ok = true) {
  return { ok, json: async () => body };
}

test('the activity loads the custom list once at start and refreshes it every few minutes', async () => {
  const timers = fakeTimers();
  const asked = [];
  let body = { v: 'a1', n: 1, t: enc(['banana']) };
  const fetch = async (url, init) => {
    asked.push([url, init.credentials]);
    return reply(body);
  };
  try {
    assert.equal(await startBlocked({ fetch, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout }), true);
    assert.deepEqual(asked, [[BLOCKED_ENDPOINT, 'same-origin']]);
    assert.equal(blockedCount(), 1);
    assert.equal(hidesWords('a b a n a n a'), true);
    assert.equal(timers.queue.length, 1);
    assert.equal(timers.queue[0].ms, BLOCKED_REFRESH_MS);
    body = { v: 'a2', n: 2, t: enc(['banana', 'pineapple pizza']) };
    await timers.run();
    assert.equal(blockedCount(), 2);
    assert.equal(timers.queue[0].ms, BLOCKED_REFRESH_MS);
    body = null;
    await timers.run();
    assert.equal(blockedCount(), 2, 'a failed refresh keeps the last list');
    assert.equal(timers.queue[0].ms, BLOCKED_RETRY_MS);
    body = { v: 'none', n: 0, t: [] };
    await timers.run();
    assert.equal(blockedCount(), 0);
    assert.equal(hidesWords('banana'), false);
  } finally {
    resetBlocked();
  }
});

test('a broken or missing endpoint never breaks the activity', async () => {
  try {
    configureBlocked({ fetch: async () => { throw new Error('offline'); } });
    assert.equal(await loadBlocked(), false);
    configureBlocked({ fetch: async () => reply({ nope: true }) });
    assert.equal(await loadBlocked(), false);
    configureBlocked({ fetch: async () => reply({}, false) });
    assert.equal(await loadBlocked(), false);
    configureBlocked({ fetch: null });
    assert.equal(await loadBlocked(), false);
    configureBlocked({ win: {} });
    assert.equal(await loadBlocked(), false);
    configureBlocked({ win: { fetch: async () => reply({ v: 'w', t: enc(['banana']) }) } });
    assert.equal(await loadBlocked(), true);
    assert.equal(customTermCount(), 1);
    configureBlocked({ fetch: async () => reply({ v: 'x', t: [42, null, enc(['ok go'])[0]] }) });
    assert.equal(await loadBlocked(), true);
    assert.equal(customTermCount(), 1);
  } finally {
    resetBlocked();
  }
  assert.equal(customTermCount(), 0);
});

test('custom words are hidden in everything players type, including word games', () => {
  try {
    setCustomTerms(enc(['banana', 'go away']));
    assert.equal(cleanShared('I ate a B4NANA today'), 'I ate a ■■■■■■ today');
    assert.match(cleanShared('please g o   a w a y'), /^please ■+$/);
    assert.equal(checkWord('banana', 'b', []), 'blocked');
    assert.equal(checkWord('bananas', 'b', []), 'blocked');
    assert.notEqual(checkWord('bandit', 'b', []), 'blocked');
    assert.equal(isBlockedGameWord('banana'), true);
  } finally {
    setCustomTerms([]);
  }
  assert.equal(checkWord('banana', 'b', []) === 'blocked', false);
});

test('the host censors custom words even when a modified client sends them raw', async () => {
  try {
    setCustomTerms(enc(['banana']));
    const r = room(2, { games: [story] });
    await r.clock.advance(500);
    const host = r.engines[0];
    assert.equal(host.lobby.pick('story'), true);
    assert.equal(host.lobby.start().ok, true);
    await r.clock.advance(300);
    const s = r.hub.state[KEY];
    const writer = r.engines.find((e) => e.snapshot().meSlot === s.writer);
    writer.act({ type: 'line', t: s.turn, text: 'The b.a.n.a.n.a ran off with the spoon.' });
    await r.clock.advance(1500);
    const line = r.hub.state[lineKey(0)];
    assert.ok(line, 'the line was stored');
    assert.doesNotMatch(JSON.stringify(line), /b\.a\.n\.a\.n\.a/);
    assert.match(JSON.stringify(line), /■/);
  } finally {
    setCustomTerms([]);
  }
});
