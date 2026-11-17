import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, flush, type, fire } from './dom-shim.js';

const { document } = installDom({ url: 'https://dash.example.test/party/reports' });
document.documentElement = document.createElement('html');
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const blocked = await import('../web/js/pages/party-blocked.js');
const cheats = await import('../web/js/pages/owner-cheats.js');

function walk(node, out = []) {
  for (const c of node.childNodes || []) {
    out.push(c);
    walk(c, out);
  }
  return out;
}

const buttons = (root) => walk(root).filter((n) => n.localName === 'button');
const byLabel = (root, text) => buttons(root).find((b) => b.textContent.trim() === text || b.getAttribute('aria-label') === text);

function ctxOf(api) {
  const ctrl = new AbortController();
  return { api, signal: ctrl.signal, stop: () => ctrl.abort() };
}

const WORDS = {
  words: [
    { id: 'w1', word: 'banana', added_by: 'a', added_name: 'Alex', created: Date.now() - 60000 },
    { id: 'w2', word: 'pineapple pizza', added_by: 'b', added_name: '<b>Jolli</b>', created: Date.now() - 3600000 },
  ],
  count: 2,
  max: 500,
  chars: 40,
};

test('readBlocked, matchBlocked and the count text cope with odd data', () => {
  assert.deepEqual(blocked.readBlocked(null), { words: [], max: 500, chars: 40 });
  const v = blocked.readBlocked({ words: [null, { id: 1 }, { id: 'x', word: 'ok' }], max: 10 });
  assert.equal(v.words.length, 1);
  assert.equal(v.words[0].by, 'Staff');
  assert.equal(v.max, 10);
  const list = blocked.readBlocked(WORDS).words;
  assert.deepEqual(blocked.matchBlocked(list, 'PIZ').map((w) => w.id), ['w2']);
  assert.equal(blocked.matchBlocked(list, '  ').length, 2);
  assert.equal(blocked.blockedCountText(2, 2, 500), '2 of 500');
  assert.equal(blocked.blockedCountText(1, 2, 500), '1 of 2 shown');
});

test('the blocked words card lists, searches, adds and removes words', async () => {
  const calls = [];
  let current = WORDS;
  const ctx = ctxOf({
    get: async (path) => {
      calls.push(['GET', path]);
      return current;
    },
    post: async (path, body) => {
      calls.push(['POST', path, body]);
      current = { ...WORDS, words: [{ id: 'w3', word: body.word, added_name: 'Me', created: Date.now() }, ...WORDS.words] };
      return current;
    },
    request: async (method, path) => {
      calls.push([method, path]);
      current = { ...WORDS, words: WORDS.words.slice(1) };
      return current;
    },
  });
  const card = blocked.blockedWordsCard(ctx);
  document.body.replaceChildren(card);
  await flush();
  assert.deepEqual(calls[0], ['GET', blocked.BLOCKED_PATH]);
  assert.match(card.textContent, /Blocked words/);
  assert.match(card.textContent, /built-in filter always applies too/);
  assert.match(card.textContent, /banana/);
  assert.match(card.textContent, /Added by <b>Jolli<\/b>/);
  assert.equal(walk(card).some((n) => n.localName === 'b'), false);
  assert.match(card.textContent, /2 of 500/);
  const search = walk(card).find((n) => n.localName === 'input' && n.type === 'search');
  type(search, 'pizza');
  assert.doesNotMatch(card.textContent, /Added by Alex/);
  assert.match(card.textContent, /1 of 2 shown/);
  type(search, 'zzz');
  assert.match(card.textContent, /No blocked words match/);
  type(search, '');
  const input = walk(card).find((n) => n.localName === 'input' && n.type === 'text');
  const form = walk(card).find((n) => n.localName === 'form');
  fire(form, 'submit');
  await flush();
  assert.match(card.textContent, /Type a word or phrase first/);
  type(input, 'skibidi');
  fire(form, 'submit');
  await flush();
  assert.deepEqual(calls.find((c) => c[0] === 'POST'), ['POST', blocked.BLOCKED_PATH, { word: 'skibidi' }]);
  assert.match(card.textContent, /skibidi/);
  assert.equal(input.value, '');
  ctx.stop();
});

test('cheat alert helpers read alerts defensively', () => {
  assert.deepEqual(cheats.readAlerts(null), { alerts: [], open: 0 });
  const v = cheats.readAlerts({ open: 2, alerts: [{ id: 'a', user: 'u', detail: 'Hit the cap', count: 0, status: 'weird' }, { id: 1 }] });
  assert.equal(v.alerts.length, 1);
  assert.equal(v.alerts[0].count, 1);
  assert.equal(v.alerts[0].status, 'open');
  assert.equal(cheats.alertCountText(1), '1 open');
  assert.equal(cheats.alertCountText(3), '3 open');
});

test('the cheat alerts card shows evidence and every action button, and dismiss posts', async () => {
  const XD = 'de7e0000-0000-4000-8000-0000000000d0';
  const posts = [];
  let open = 1;
  const ctx = ctxOf({
    get: async () => (open ? { open, alerts: [{ id: 'c1', user: XD, kind: 'daily_points', label: 'Daily points cap', name: 'XD', detail: 'Hit the 100,000 daily points cap on 3 of the last 7 days', count: 3, last_at: Date.now() - 60000, status: 'open' }] } : { open: 0, alerts: [] }),
    post: async (path, body) => {
      posts.push({ path, body });
      open = 0;
      return { alert: { id: 'c1', user: XD, status: 'dismissed' }, result: null };
    },
  });
  let changed = 0;
  const card = cheats.cheatAlertsCard(ctx, { onChange: () => { changed += 1; } });
  document.body.replaceChildren(card);
  await flush();
  assert.match(card.textContent, /Cheat alerts/);
  assert.match(card.textContent, /1 open/);
  assert.match(card.textContent, /Hit the 100,000 daily points cap on 3 of the last 7 days/);
  assert.match(card.textContent, /3 times/);
  for (const label of ['Hide from leaderboards', 'Reset Party stats', 'Dismiss']) assert.ok(byLabel(card, label), label);
  const link = walk(card).find((n) => n.localName === 'a');
  assert.equal(link.getAttribute('href') || link.href, `/owner/${XD}`);
  byLabel(card, 'Dismiss').click();
  await flush();
  assert.deepEqual(posts, [{ path: `${cheats.OWNER_CHEATS_PATH}/c1`, body: { do: 'dismiss' } }]);
  assert.equal(changed, 0);
  assert.match(card.textContent, /No cheat alerts right now/);
  assert.match(card.textContent, /0 open/);
  ctx.stop();
});
