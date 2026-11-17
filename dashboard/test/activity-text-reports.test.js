import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { room } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import { configureAdmins, resetAdmins, textReportBody, REPORTS_ENDPOINT, TEXT_REPORT_GAMES, REPORT_TEXT_MAX, REPORT_CONTEXT_MAX } from '../web/activity/js/admin.js';
import { TEXT_REPORT_LIMIT, TEXT_REPORT_WINDOW_MS, validTextRef } from '../web/activity/js/engine.js';
import draw, { guessRef } from '../web/activity/js/games/draw.js';
import { feedRefs } from '../web/activity/js/views/draw.js';
import hottakes, { seal, answerRef, ANSWER_PREFIX } from '../web/activity/js/games/hottakes.js';
import truths, { statementRef } from '../web/activity/js/games/truths.js';
import chain, { wordRef } from '../web/activity/js/games/chain.js';
import telephone, { textRef, promptRef, isStarterText } from '../web/activity/js/games/telephone.js';
import { STARTERS } from '../web/activity/data/telephone.js';
import { textFlag, TEXT_FLAG_LABEL, TEXT_FLAG_TITLE, TEXT_FLAG_DONE } from '../web/activity/js/ui/report.js';
import { pickIn } from './reason-pick.js';
import { VIEWS } from '../web/activity/js/views/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, '..', 'web', 'activity');

function fakeFetch(log) {
  return async (url, init = {}) => {
    if (String(url).startsWith(REPORTS_ENDPOINT) && init.method === 'POST') {
      log.push({ url, init, body: JSON.parse(init.body) });
      return { ok: true, status: 201, json: async () => ({ ok: true }) };
    }
    return { ok: true, status: 200, json: async () => ({ admins: [], banned: [], owner: null }) };
  };
}

async function settle(clock, ms = 600) {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((res) => setImmediate(res));
    await clock.advance(ms / 6);
  }
}

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function setup() {
  resetAdmins();
  const log = [];
  configureAdmins({ fetch: fakeFetch(log), refreshMs: 0, win: null });
  return log;
}

async function startDraw(n = 3) {
  const r = room(n);
  await settle(r.clock);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('draw'), true);
  assert.equal(host.lobby.start().ok, true);
  await settle(r.clock, 300);
  let st = host.snapshot().state.draw;
  bySlot(r, st.drawer).act({ type: 'pick', i: 0, n: st.n });
  await settle(r.clock, 400);
  st = host.snapshot().state.draw;
  assert.equal(st.phase, 'draw');
  return r;
}

function guessers(r) {
  const st = r.engines[0].snapshot().state.draw;
  return r.engines.filter((e) => e.snapshot().meSlot !== st.drawer);
}

test('the request body is the text report shape and is cleaned and clipped', () => {
  resetAdmins();
  configureAdmins({ now: () => 1234 });
  const author = { id: 'aaa-1', name: '  Sam\u0000 ', username: '@sammy' };
  const reporter = { id: 'bbb-2', name: 'Robin' };
  const body = textReportBody({ game: 'draw', author, reporter, text: `  ${'x'.repeat(400)}  `, context: 'y'.repeat(260), at: 99.6 });
  assert.deepEqual(Object.keys(body), ['kind', 'game', 'author', 'reporter', 'text', 'context', 'at']);
  assert.equal(body.kind, 'text');
  assert.deepEqual(body.author, { id: 'aaa-1', name: 'Sam', username: 'sammy' });
  assert.deepEqual(body.reporter, { id: 'bbb-2', name: 'Robin' });
  assert.equal(Array.from(body.text).length, REPORT_TEXT_MAX);
  assert.equal(Array.from(body.context).length, REPORT_CONTEXT_MAX);
  assert.equal(body.at, 100);
  assert.equal(textReportBody({ game: 'draw', author, reporter, text: 'hi' }).at, 1234);
  assert.equal(textReportBody({ game: 'draw', author, reporter, text: 'hi' }).context, null);
  assert.equal(textReportBody({ game: 'draw', author: { id: 'x', name: 'n' }, reporter: { id: 'x', name: 'n' }, text: 'hi' }), null);
  assert.equal(textReportBody({ game: 'nope', author, reporter, text: 'hi' }), null);
  assert.equal(textReportBody({ game: 'draw', author, reporter, text: '   ' }), null);
  assert.equal(textReportBody({ game: 'draw', author: { id: 'bad id!' }, reporter, text: 'hi' }), null);
  assert.deepEqual([...TEXT_REPORT_GAMES].sort(), ['bluff', 'chain', 'draw', 'hottakes', 'story', 'telephone', 'truths']);
  assert.equal(validTextRef('draw.12.3.g4'), true);
  assert.equal(validTextRef('bad ref'), false);
  resetAdmins();
});

test('a guesser reports another guess and the host posts it to the reports page', async () => {
  const log = setup();
  const r = await startDraw(3);
  const host = r.engines[0];
  const st0 = host.snapshot().state.draw;
  const [a, b] = guessers(r);
  assert.ok(a !== host || b !== host);
  a.act({ type: 'guess', text: 'banana boat' });
  await settle(r.clock);
  const st = host.snapshot().state.draw;
  const line = st.feed.find((f) => f[2] === 'banana boat');
  assert.ok(line, 'the guess shows in the feed');
  const ref = guessRef(st, line[0]);
  assert.equal(ref, `draw.${st0.nonce}.${st0.n}.g${line[0]}`);
  a.report(ref);
  await settle(r.clock);
  assert.equal(log.length, 0, 'nobody can report their own text');
  assert.equal(b.report(ref), 'sent');
  assert.equal(b.reported(ref), true);
  assert.equal(b.report(ref), 'done', 'one report per person per item');
  await settle(r.clock);
  assert.equal(log.length, 1);
  const sent = log[0];
  assert.equal(sent.url, REPORTS_ENDPOINT);
  assert.equal(sent.init.method, 'POST');
  assert.equal(sent.init.credentials, 'same-origin');
  assert.equal(sent.init.headers['Content-Type'], 'application/json');
  const aMe = a.snapshot().players.find((p) => p.isMe);
  const bMe = b.snapshot().players.find((p) => p.isMe);
  const word = draw.model(host.snapshot()).word || null;
  assert.deepEqual(sent.body, {
    kind: 'text',
    game: 'draw',
    author: { id: aMe.id, name: aMe.name, username: null },
    reporter: { id: bMe.id, name: bMe.name },
    text: 'banana boat',
    context: sent.body.context,
    at: sent.body.at,
  });
  assert.match(sent.body.context, /^Word to draw: /);
  if (word) assert.equal(sent.body.context, `Word to draw: ${word}`);
  assert.equal(typeof sent.body.at, 'number');
  b.broadcast({ t: 'rpt', g: 'draw', r: ref });
  await settle(r.clock);
  assert.equal(log.length, 1, 'the host dedupes the same reporter and item');
  resetAdmins();
});

test('the host rate-limits text reports per reporter', async () => {
  const log = setup();
  const r = await startDraw(3);
  const host = r.engines[0];
  const [a, b] = guessers(r);
  const reporter = b === host ? a : b;
  const author = reporter === a ? b : a;
  for (let i = 0; i < 7; i += 1) {
    author.act({ type: 'guess', text: `wrong ${i}` });
    await settle(r.clock, 600);
  }
  const st = host.snapshot().state.draw;
  const refs = st.feed.filter((f) => f[3] === 'guess').map((f) => guessRef(st, f[0]));
  assert.ok(refs.length >= 7, String(refs.length));
  for (const ref of refs.slice(0, 7)) reporter.broadcast({ t: 'rpt', g: 'draw', r: ref });
  await settle(r.clock);
  assert.equal(log.length, TEXT_REPORT_LIMIT);
  assert.equal(TEXT_REPORT_LIMIT, 5);
  assert.equal(TEXT_REPORT_WINDOW_MS, 60000);
  await r.clock.advance(TEXT_REPORT_WINDOW_MS + 10);
  reporter.broadcast({ t: 'rpt', g: 'draw', r: refs[5] });
  await settle(r.clock);
  assert.equal(log.length, TEXT_REPORT_LIMIT + 1, 'the limit resets after a minute');
  resetAdmins();
});

test('the reporter screen also slows down after five reports a minute', async () => {
  setup();
  const r = await startDraw(3);
  const host = r.engines[0];
  const [a, b] = guessers(r);
  const reporter = b === host ? a : b;
  const author = reporter === a ? b : a;
  for (let i = 0; i < 6; i += 1) {
    author.act({ type: 'guess', text: `nope ${i}` });
    await settle(r.clock, 600);
  }
  const st = host.snapshot().state.draw;
  const refs = st.feed.filter((f) => f[3] === 'guess').map((f) => guessRef(st, f[0]));
  const out = refs.slice(0, 6).map((ref) => reporter.report(ref));
  assert.deepEqual(out, ['sent', 'sent', 'sent', 'sent', 'sent', 'slow']);
  resetAdmins();
});

test('Hot Takes reports name the hidden author without telling the reporter', async () => {
  const log = setup();
  const r = room(3, { games: [hottakes] });
  await settle(r.clock);
  const host = r.engines[0];
  host.lobby.pick('hottakes');
  assert.equal(host.lobby.start().ok, true);
  await settle(r.clock, 300);
  const texts = new Map();
  for (const e of r.engines) {
    const s = e.snapshot().state.hottakes;
    const t = `take from ${e.snapshot().meSlot}`;
    texts.set(e.snapshot().meSlot, t);
    e.act({ type: 'answer', n: s.n, code: seal(t, s.nonce) });
  }
  await settle(r.clock);
  const st = host.snapshot().state.hottakes;
  assert.equal(st.phase, 'vote');
  const reporter = r.engines[2];
  const mine = reporter.snapshot().meSlot;
  const rows = [];
  for (let i = 0; i < st.chunks; i += 1) rows.push(...reporter.snapshot().state[`${ANSWER_PREFIX}${i}`]);
  const other = rows.find((row) => row[1] !== texts.get(mine));
  const own = rows.find((row) => row[1] === texts.get(mine));
  const authorSlot = [...texts.entries()].find(([, t]) => t === other[1])[0];
  const ref = answerRef(st.n, st.nonce, other[0]);
  assert.equal(reporter.report(answerRef(st.n, st.nonce, own[0])), 'sent', 'the screen cannot tell, so the host decides');
  assert.equal(reporter.report(ref), 'sent');
  await settle(r.clock);
  assert.equal(log.length, 1, 'the host refuses a report of your own anonymous answer');
  const author = bySlot(r, authorSlot).snapshot().players.find((p) => p.isMe);
  assert.equal(log[0].body.author.id, author.id);
  assert.equal(log[0].body.text, other[1]);
  assert.equal(log[0].body.game, 'hottakes');
  assert.match(log[0].body.context, /^Prompt: /);
  assert.equal(reporter.snapshot().state.hottakes.res, null, 'authors stay hidden until the reveal');
  assert.ok(hottakes.model(reporter.snapshot(), {}).cards.every((c) => !c.author));
  resetAdmins();
});

function fakeApi(state, memory = {}, players = [0, 1, 2]) {
  return {
    get: (k) => (state[k] === undefined ? null : JSON.parse(JSON.stringify(state[k]))),
    memory,
    players: () => players.map((slot) => ({ slot })),
  };
}

test('Two Truths and a Lie, Word Chain and Draw Telephone list reportable text', () => {
  const tr = truths.texts(fakeApi({ truths: { phase: 'vote', n: 7, v: 2, writer: 1, s: ['a', 'b', 'c'] } }, { cur: { v: 2, lieAt: 1 } }));
  assert.deepEqual(tr.map((x) => [x.r, x.author, x.text]), [
    [statementRef(7, 2, 0), 1, 'a'],
    [statementRef(7, 2, 1), 1, 'b'],
    [statementRef(7, 2, 2), 1, 'c'],
  ]);
  assert.match(tr[1].context, /their lie/);
  assert.deepEqual(truths.texts(fakeApi({ truths: { phase: 'write', n: 7 } })), []);

  const ch = chain.texts(fakeApi({ chain: { words: [[1, 0, 'apple'], [2, 1, 'eagle']] } }));
  assert.deepEqual(ch.map((x) => [x.r, x.author, x.text]), [
    [wordRef(1), 0, 'apple'],
    [wordRef(2), 1, 'eagle'],
  ]);
  assert.match(ch[1].context, /apple/);

  const starter = STARTERS[0].text;
  assert.equal(isStarterText(starter), true);
  const chains = [
    [{ k: 'w', by: 0, t: 'a cat on a bike' }, { k: 'd', by: 1, s: ['x'] }, { k: 't', by: 2, t: 'kitty cycling' }],
    [{ k: 'w', by: 1, t: starter }],
    [{ k: 'w', by: 2, t: 'moon pie', miss: 1 }],
  ];
  const mem = { run: 5, chains };
  const reveal = telephone.texts(fakeApi({ tel: { run: 5, seats: [0, 1, 2], phase: 'reveal', rv: { c: 0, at: 2 } } }, mem));
  assert.deepEqual(reveal.map((x) => [x.r, x.author, x.text]), [
    [textRef(5, 0, 0), 0, 'a cat on a bike'],
    [textRef(5, 0, 2), 2, 'kitty cycling'],
  ]);
  assert.match(reveal[1].context, /a cat on a bike/);
  const drawSt = { run: 5, seats: [0, 1, 2], phase: 'draw', step: 1 };
  const prompts = telephone.texts(fakeApi({ tel: drawSt }, { run: 5, chains: chains.map((c) => c.slice(0, 1)) }));
  assert.deepEqual(prompts.map((x) => [x.r, x.author, x.viewers]), [[textRef(5, 0, 0), 0, [1]]]);
  assert.equal(promptRef(drawSt, 1), textRef(5, 0, 0));
});

test('the flag is a small Report button that turns into Reported', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const calls = [];
  const toasts = [];
  const whys = [];
  const engine = { report: (r, why) => (calls.push(r), whys.push(why), 'sent'), reported: () => false };
  const btn = textFlag(engine, 'chain.3', { toast: (t) => toasts.push(t) });
  assert.equal(btn.tagName.toLowerCase(), 'button');
  assert.equal(btn.getAttribute('aria-label'), TEXT_FLAG_LABEL);
  assert.equal(btn.getAttribute('title'), TEXT_FLAG_TITLE);
  assert.equal(btn.getAttribute('aria-label'), 'Report');
  assert.equal(btn.getAttribute('title'), 'Report this');
  btn.click();
  assert.deepEqual(calls, [], 'nothing is sent until a reason is picked');
  await pickIn('rude');
  assert.deepEqual(calls, ['chain.3']);
  assert.deepEqual(whys, [{ reason: 'rude' }]);
  assert.equal(btn.classList.contains('is-reported'), true);
  assert.equal(btn.disabled, true);
  assert.equal(btn.getAttribute('aria-label'), TEXT_FLAG_DONE);
  assert.equal(toasts.length, 1);
  btn.click();
  assert.equal(calls.length, 1);
  const done = textFlag({ report: () => 'sent', reported: () => true }, 'chain.3');
  assert.equal(done.disabled, true);
  assert.equal(done.textContent.includes('Reported'), true);
  const slow = [];
  const s = textFlag({ report: () => 'slow', reported: () => false }, 'chain.4', { toast: (t) => slow.push(t) });
  s.click();
  await pickIn('spam');
  assert.equal(s.disabled, false);
  assert.match(slow[0], /minute/);
  assert.equal(textFlag({}, 'chain.5'), null);
  assert.equal(textFlag(engine, null), null);
});

test('the Draw & Guess feed shows a flag on other players guesses only', async () => {
  setup();
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startDraw(3);
  const host = r.engines[0];
  const [a, b] = guessers(r);
  a.act({ type: 'guess', text: 'castle' });
  await settle(r.clock);
  const win = { setTimeout: r.clock.setTimeout, clearTimeout: r.clock.clearTimeout, setInterval: () => 0, clearInterval() {} };
  const mineView = VIEWS.draw({ engine: a, fx: { confetti() {} }, toast() {}, win });
  mineView.update(a.snapshot());
  assert.equal(mineView.el.querySelectorAll('.feed .text-flag').length, 0, 'no flag on your own guess');
  mineView.destroy();
  const otherView = VIEWS.draw({ engine: b, fx: { confetti() {} }, toast() {}, win });
  otherView.update(b.snapshot());
  const flags = otherView.el.querySelectorAll('.feed .text-flag');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].getAttribute('aria-label'), 'Report');
  flags[0].click();
  await pickIn('cheating');
  assert.equal(flags[0].classList.contains('is-reported'), true);
  otherView.destroy();
  assert.ok(host);
  resetAdmins();
});

test('the flag styles use tokens, show on hover or focus and stay visible on touch', () => {
  const css = readFileSync(path.join(web, 'css', 'games.css'), 'utf8');
  assert.match(css, /\.text-flag \{/);
  assert.match(css, /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*\.has-flag:focus-within \.text-flag/);
  assert.doesNotMatch(css, /\/\*/);
  for (const f of ['js/ui/report.js', 'js/engine.js', 'js/admin.js', 'js/games/telephone.js', 'js/views/telephone.js', 'css/telephone.css']) {
    const src = readFileSync(path.join(web, f), 'utf8');
    assert.doesNotMatch(src, /^\s*\/\/|\/\*/m, f);
  }
});

test('people who never joined see no flags because they cannot report', async () => {
  setup();
  const r = await startDraw(3);
  const watcher = r.add(9);
  await settle(r.clock);
  const slot = watcher.snapshot().meSlot;
  assert.equal(watcher.canReport(), slot !== null && slot !== undefined);
  assert.equal(r.engines[1].canReport(), true);
  installDom({ url: 'https://yapos.dev/activity/' });
  assert.equal(textFlag({ report: () => 'sent', canReport: () => false }, 'chain.1'), null);
  resetAdmins();
});

test('reports from a real game are accepted by the worker and show on the Reports page', async () => {
  const { createHarness, USERS } = await import('./helpers.js');
  const log = setup();
  const r = await startDraw(3);
  const [a, b] = guessers(r);
  a.act({ type: 'guess', text: 'banana   boat <img src=x onerror=alert(1)>' });
  await settle(r.clock);
  const st = r.engines[0].snapshot().state.draw;
  const line = st.feed.find((f) => typeof f[2] === 'string' && f[2].startsWith('banana'));
  assert.ok(line);
  assert.equal(b.report(guessRef(st, line[0])), 'sent');
  await settle(r.clock);
  assert.equal(log.length, 1);
  resetAdmins();
  const h = createHarness({ PARTY_OWNER_ID: USERS.alice.id });
  const res = await h.request('POST', REPORTS_ENDPOINT, { headers: { Origin: h.base }, body: log[0].body, ip: '198.51.100.20' });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  const again = await h.request('POST', REPORTS_ENDPOINT, { headers: { Origin: h.base }, body: log[0].body, ip: '198.51.100.20' });
  assert.deepEqual(await again.json(), { ok: true, duplicate: true });
  const owner = await h.login(USERS.alice);
  const list = await (await h.api('GET', '/api/party/reports?kind=text', owner.cookie)).json();
  assert.equal(list.reports.length, 1);
  const [rep] = list.reports;
  assert.equal(rep.kind, 'text');
  assert.equal(rep.game, 'draw');
  assert.equal(rep.text, log[0].body.text);
  assert.equal(rep.context, log[0].body.context);
  assert.equal(rep.drawer.id, log[0].body.author.id.toLowerCase());
  assert.equal(rep.reporter.id, log[0].body.reporter.id.toLowerCase());
  const drawings = await (await h.api('GET', '/api/party/reports?kind=drawing', owner.cookie)).json();
  assert.equal(drawings.reports.length, 0);
});

test('the flag on a guess carries the reference the host knows, taken from what the reporter sees', async () => {
  const log = setup();
  const r = await startDraw(3);
  const [a, b] = guessers(r);
  a.act({ type: 'guess', text: 'pickle parade' });
  await settle(r.clock);
  const m = draw.model(b.snapshot(), {});
  const row = feedRefs(m).find((f) => f.text === 'pickle parade');
  assert.ok(row && row.ref, 'the reporter sees a flag on the guess');
  const st = r.engines[0].snapshot().state.draw;
  const line = st.feed.find((x) => x[2] === 'pickle parade');
  assert.equal(row.ref, guessRef(st, line[0]), 'the screen and the host agree on the reference');
  assert.equal(b.report(row.ref), 'sent');
  await settle(r.clock);
  assert.equal(log.length, 1, 'the host posts the report');
  assert.equal(log[0].body.text, 'pickle parade');
});

test('a text report carries the reason and short note the player picked, through the host', async () => {
  const log = setup();
  const r = await startDraw(3);
  const host = r.engines[0];
  const [a, b] = guessers(r);
  a.act({ type: 'guess', text: 'buy coins at my site' });
  await settle(r.clock);
  const st = host.snapshot().state.draw;
  const line = st.feed.find((f) => f[2] === 'buy coins at my site');
  const ref = guessRef(st, line[0]);
  const reporter = b === host ? r.engines.find((e) => e !== a && e !== host) || b : b;
  assert.equal(reporter.report(ref, { reason: 'spam', reasonNote: `  ${'n'.repeat(140)}  ` }), 'sent');
  await settle(r.clock);
  assert.equal(log.length, 1);
  assert.equal(log[0].body.reason, 'spam');
  assert.equal(Array.from(log[0].body.reasonNote).length, 100);
  a.act({ type: 'guess', text: 'another guess' });
  await settle(r.clock);
  const st2 = host.snapshot().state.draw;
  const line2 = st2.feed.find((f) => f[2] === 'another guess');
  assert.equal(reporter.report(guessRef(st2, line2[0]), { reason: 'hacking' }), 'sent');
  await settle(r.clock);
  assert.equal(log.length, 2);
  assert.equal('reason' in log[1].body, false, 'an unknown reason is dropped, not sent');
  resetAdmins();
});

test('the reason picker sends a note only for Something else and Escape cancels', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const { pickReason, reasonOpen, REASON_CHOICES } = await import('../web/activity/js/ui/report.js');
  assert.deepEqual(REASON_CHOICES.map((c) => c.label), ['Rude or inappropriate', 'Spam', 'Cheating', 'Something else']);
  const first = pickReason();
  assert.ok(reasonOpen());
  const second = pickReason();
  assert.equal(await first, null, 'opening a new picker closes the old one');
  const { pickIn: pick } = await import('./reason-pick.js');
  await pick('other', 'they kept   saying it');
  assert.deepEqual(await second, { reason: 'other', reasonNote: 'they kept saying it' });
  assert.equal(reasonOpen(), null);
  const third = pickReason();
  reasonOpen().dispatchEvent(Object.assign(new (await import('./dom-shim.js')).FakeEvent('keydown', { bubbles: true }), { key: 'Escape' }));
  assert.equal(await third, null);
  assert.equal(reasonOpen(), null);
});
