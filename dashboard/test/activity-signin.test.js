import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, FakeEvent, flush } from './dom-shim.js';
import { createSignin, spellCode, pollDelay, MIN_POLL_MS, MAX_POLL_MS, SUCCESS_MS } from '../web/activity/js/ui/signin.js';
import { AUTH_KEY, readTokens, saveToken, forgetToken, tokenFor, createAccountApi } from '../web/activity/js/account.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const activity = path.join(here, '..', 'web', 'activity');
const PIP = 'de7e0000-0000-4000-8000-000000000001';
const BOB = 'de7e0000-0000-4000-8000-000000000002';
const TOKEN = 'T'.repeat(43);
const POLL = 'P'.repeat(43);
const OLD = 'O'.repeat(43);

function text(node) {
  if (node.data !== undefined && !node.localName) return node.data;
  return (node.childNodes || []).map(text).join(' ');
}

function all(node, out = []) {
  for (const c of node.childNodes || []) {
    if (c.localName) out.push(c);
    all(c, out);
  }
  return out;
}

function byKey(root, key) {
  return all(root).find((el) => el.dataset && el.dataset.key === key) || null;
}

function memoryStore({ broken = false } = {}) {
  const map = new Map();
  return {
    map,
    getItem(k) {
      if (broken) throw new Error('blocked');
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (broken) throw new Error('blocked');
      map.set(k, String(v));
    },
    removeItem(k) {
      if (broken) throw new Error('blocked');
      map.delete(k);
    },
  };
}

function setup({ store = memoryStore(), dev = false, alone = false, me = PIP, name = 'Pip', meResult, startResult, pollResults = [] } = {}) {
  const { document } = installDom({ url: 'https://yapos.dev/activity/' });
  const clock = { t: 1_000_000 };
  const queue = new Map();
  let seq = 0;
  const win = {
    document,
    localStorage: store,
    navigator: { clipboard: null },
    setTimeout(fn, ms) {
      seq += 1;
      queue.set(seq, { fn, at: clock.t + (Number(ms) || 0) });
      return seq;
    },
    clearTimeout(id) {
      queue.delete(id);
    },
    setInterval() {
      return 0;
    },
    clearInterval() {},
  };
  const calls = { me: [], start: [], poll: [], logout: [], devApprove: [] };
  const account = {
    async me(token) {
      calls.me.push(token);
      const r = typeof meResult === 'function' ? meResult(token) : meResult;
      return r || { ok: false, status: 401, user: null };
    },
    async start(expect) {
      calls.start.push(expect);
      return startResult || { ok: true, code: 'K7QM-2XPA', token: POLL, expires: clock.t + 600000, ttl: 600000, interval: 2500 };
    },
    async poll(token) {
      calls.poll.push(token);
      return pollResults.length ? pollResults.shift() : { status: 'pending' };
    },
    async logout(token) {
      calls.logout.push(token);
      return true;
    },
    async devApprove(code, id) {
      calls.devApprove.push([code, id]);
      pollResults.unshift({ status: 'approved', token: TOKEN, user: { id: PIP, username: 'pipsqueak', display_name: 'Pip', avatar_url: null } });
      return true;
    },
  };
  const toasts = [];
  const snap = { ready: true, me, players: [{ id: me, name, isMe: true }] };
  const engine = { snapshot: () => snap, now: () => clock.t };
  const root = document.createElement('div');
  root.className = 'app';
  document.body.append(root);
  const changes = [];
  const gate = createSignin({ win, engine, toast: (t, kind) => toasts.push([t, kind]), dev, alone, host: root, account, onChange: (s) => changes.push(s) });
  root.append(gate.el);
  async function run(ms) {
    const until = clock.t + ms;
    for (;;) {
      const due = [...queue.entries()].filter(([, v]) => v.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      queue.delete(due[0]);
      clock.t = Math.max(clock.t, due[1].at);
      due[1].fn();
      await flush();
    }
    clock.t = until;
    await flush();
  }
  return { gate, win, store, calls, toasts, snap, engine, root, document, clock, run, changes, account };
}

test('code helpers spell the code for screen readers and back off politely', () => {
  assert.equal(spellCode('K7QM-2XPA'), 'K 7 Q M 2 X P A');
  assert.equal(pollDelay(2500, 0), 2500);
  assert.equal(pollDelay(100, 0), MIN_POLL_MS);
  assert.ok(pollDelay(2500, 1) > 2500);
  assert.equal(pollDelay(2500, 99), MAX_POLL_MS);
});

test('a player who is not signed in gets the sign-in prompt with a code and joins once they confirm', async () => {
  const s = setup({ pollResults: [{ status: 'pending' }, { status: 'approved', token: TOKEN, user: { id: PIP, username: 'pipsqueak', display_name: 'Pip', avatar_url: null } }] });
  assert.equal(s.gate.state().status, 'idle');
  s.gate.update(s.snap);
  await flush();
  assert.deepEqual(s.calls.me, [null]);
  assert.equal(s.gate.state().status, 'out');
  assert.equal(s.gate.isOpen, true);
  assert.equal(s.gate.el.hidden, false);
  assert.ok(s.root.classList.contains('has-modal'));
  assert.deepEqual(s.calls.start, [PIP], 'the code remembers who the call says this is');
  const card = s.gate.el.querySelector('.signin-card');
  assert.equal(card.getAttribute('role'), 'dialog');
  assert.equal(card.getAttribute('aria-modal'), 'true');
  assert.equal(card.getAttribute('aria-labelledby'), 'signin-title');
  const out = s.gate.el.querySelector('.signin-code');
  assert.equal(out.textContent, 'K7QM-2XPA');
  assert.equal(out.getAttribute('aria-label'), 'Your code: K 7 Q M 2 X P A');
  assert.match(text(s.gate.el), /Sign in to play/);
  assert.match(text(s.gate.el), /yapos\.dev\/link/);
  assert.match(text(s.gate.el), /wins, Party XP, Shards and leaderboard/);
  assert.match(text(s.gate.el), /Code expires in 10:00/);
  assert.equal(s.document.activeElement, s.gate.el.querySelector('.signin-copy'), 'focus starts on Copy');
  assert.equal(byKey(s.gate.el, 'signin-skip'), null, 'no skip outside a test call');
  assert.equal(s.gate.require('join'), false);
  assert.equal(s.gate.needsLink(), true);
  await s.run(2500);
  assert.equal(s.calls.poll.length, 1);
  assert.equal(s.gate.state().status, 'out');
  await s.run(2500);
  assert.equal(s.calls.poll.length, 2);
  assert.equal(s.gate.state().status, 'in');
  assert.match(text(s.gate.el), /Linked! Welcome, Pip\./);
  assert.deepEqual(s.toasts.at(-1), ['Signed in as Pip', 'success']);
  assert.deepEqual(JSON.parse(s.store.map.get(AUTH_KEY)), { [PIP]: TOKEN });
  assert.equal(s.gate.state().token, TOKEN);
  await s.run(SUCCESS_MS + 300);
  assert.equal(s.gate.isOpen, false);
  assert.equal(s.gate.el.hidden, true);
  assert.equal(s.root.classList.contains('has-modal'), false);
  assert.equal(s.gate.require('join'), true);
  assert.equal(s.gate.needsLink(), false);
  const polls = s.calls.poll.length;
  await s.run(20000);
  assert.equal(s.calls.poll.length, polls, 'polling stops after sign-in');
  assert.ok(s.changes.includes('in'));
});

test('a saved token for this call person signs in quietly with no prompt', async () => {
  const s = setup({ meResult: (token) => (token === TOKEN ? { ok: true, status: 200, user: { id: PIP, username: 'pipsqueak', display_name: 'Pip' }, via: 'code' } : null) });
  saveToken(s.win, PIP, TOKEN);
  s.gate.update(s.snap);
  await flush();
  assert.deepEqual(s.calls.me, [TOKEN]);
  assert.equal(s.gate.state().status, 'in');
  assert.equal(s.gate.isOpen, false);
  assert.deepEqual(s.calls.start, []);
  assert.equal(s.gate.require('join'), true);
});

test('a rejected saved token is forgotten and the prompt comes back', async () => {
  const s = setup();
  saveToken(s.win, PIP, OLD);
  s.gate.update(s.snap);
  await flush();
  assert.deepEqual(s.calls.me, [OLD, null]);
  assert.equal(tokenFor(s.win, PIP), null);
  assert.equal(s.gate.state().status, 'out');
  assert.equal(s.gate.isOpen, true);
});

test('signed in as someone else: the prompt names both accounts and offers to sign in as the call person', async () => {
  const s = setup({ meResult: () => ({ ok: true, status: 200, user: { id: BOB, username: 'bob', display_name: 'Bob' }, via: 'dashboard' }) });
  s.gate.update(s.snap);
  await flush();
  assert.equal(s.gate.state().status, 'mismatch');
  assert.equal(s.gate.isOpen, true);
  assert.match(text(s.gate.el), /You're signed in as\s+Bob\s+, but in this call you're\s+Pip/);
  assert.equal(s.calls.start.length, 0);
  assert.equal(s.gate.require('join'), false);
  byKey(s.gate.el, 'signin-switch').click();
  await flush();
  assert.deepEqual(s.calls.start, [PIP]);
  assert.equal(s.gate.el.querySelector('.signin-code').textContent, 'K7QM-2XPA');
});

test('a code approved by a different account switches to the mismatch view and replaces the old token', async () => {
  const s = setup({
    meResult: (token) => (token === OLD ? { ok: true, status: 200, user: { id: BOB, username: 'bob', display_name: 'Bob' }, via: 'code' } : null),
    pollResults: [{ status: 'approved', token: TOKEN, user: { id: BOB, username: 'bob', display_name: 'Bob', avatar_url: null } }],
  });
  saveToken(s.win, PIP, OLD);
  s.gate.update(s.snap);
  await flush();
  assert.equal(s.gate.state().status, 'mismatch');
  byKey(s.gate.el, 'signin-switch').click();
  await flush();
  await s.run(2500);
  assert.equal(s.gate.state().status, 'mismatch');
  assert.deepEqual(s.calls.logout, [OLD]);
  assert.equal(tokenFor(s.win, PIP), TOKEN);
  assert.match(text(s.gate.el), /Different account/);
});

test('"Just watch" and Esc dismiss the prompt, a header-style reopen works, and Join brings it back', async () => {
  const s = setup();
  const opener = s.document.createElement('button');
  s.root.append(opener);
  opener.focus();
  s.gate.update(s.snap);
  await flush();
  byKey(s.gate.el, 'signin-later').click();
  await flush();
  assert.equal(s.gate.isOpen, false);
  assert.equal(s.document.activeElement, opener, 'focus goes back');
  assert.equal(s.gate.needsLink(), true);
  s.gate.open();
  await flush();
  assert.equal(s.gate.isOpen, true);
  assert.equal(s.calls.start.length, 1, 'a still-valid code is reused');
  s.gate.el.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
  assert.equal(s.gate.isOpen, false);
  assert.equal(s.gate.require('join'), false);
  assert.equal(s.gate.isOpen, true);
  assert.match(text(s.gate.el), /Sign in to join the game/);
});

test('codes expire: the countdown runs out, polling stops and a new code is one tap away', async () => {
  const s = setup();
  s.gate.update(s.snap);
  await flush();
  await s.run(600000 + 3000);
  assert.ok(s.gate.el.querySelector('.signin-code-row').classList.contains('is-expired'));
  assert.match(text(s.gate.el), /That code expired/);
  const polls = s.calls.poll.length;
  assert.ok(polls <= 600000 / MIN_POLL_MS, 'never more than one poll every 2 seconds');
  await s.run(30000);
  assert.equal(s.calls.poll.length, polls);
  const fresh = byKey(s.gate.el, 'signin-new');
  assert.ok(fresh.classList.contains('btn-primary'));
  fresh.click();
  await flush();
  assert.equal(s.calls.start.length, 2);
  assert.equal(s.gate.el.querySelector('.signin-code-row').classList.contains('is-expired'), false);
});

test('poll errors back off, and nothing is polled while the page is hidden', async () => {
  const s = setup({ pollResults: [{ status: 'error' }, { status: 'error' }] });
  s.gate.update(s.snap);
  await flush();
  await s.run(2500);
  assert.equal(s.calls.poll.length, 1);
  await s.run(2500);
  assert.equal(s.calls.poll.length, 1, 'waits longer after an error');
  await s.run(5000);
  assert.equal(s.calls.poll.length, 2);
  s.document.hidden = true;
  await s.run(60000);
  assert.equal(s.calls.poll.length, 2);
  s.document.hidden = false;
  await s.run(30000);
  assert.ok(s.calls.poll.length >= 3);
});

test('blocked storage and blocked clipboard never break the prompt', async () => {
  const s = setup({ store: memoryStore({ broken: true }), pollResults: [{ status: 'approved', token: TOKEN, user: { id: PIP, username: 'pipsqueak', display_name: 'Pip', avatar_url: null } }] });
  s.gate.update(s.snap);
  await flush();
  byKey(s.gate.el, 'signin-copy').click();
  await flush();
  assert.match(text(s.gate.el), /Press Ctrl\+C to copy/);
  await s.run(2500);
  assert.equal(s.gate.state().status, 'in');
  assert.deepEqual(readTokens(s.win), {});
});

test('copy uses the clipboard when it is allowed', async () => {
  const s = setup();
  const copied = [];
  s.win.navigator.clipboard = { writeText: async (t) => copied.push(t) };
  s.gate.update(s.snap);
  await flush();
  byKey(s.gate.el, 'signin-copy').click();
  await flush();
  assert.deepEqual(copied, ['K7QM-2XPA']);
  assert.match(text(s.gate.el), /Copied/);
});

test('copy still works when the call frame blocks the clipboard API', async () => {
  const s = setup();
  s.win.navigator.clipboard = { writeText: async () => { throw new Error('NotAllowedError'); } };
  const copied = [];
  s.document.execCommand = (cmd) => {
    const box = s.gate.el.querySelector('.signin-copy-box');
    if (cmd === 'copy' && box) copied.push(box.value);
    return cmd === 'copy' && Boolean(box);
  };
  s.gate.update(s.snap);
  await flush();
  byKey(s.gate.el, 'signin-copy').click();
  await flush();
  assert.deepEqual(copied, ['K7QM-2XPA']);
  assert.match(text(s.gate.el), /Copied/);
  assert.equal(s.gate.el.querySelector('.signin-copy-box'), null);
});

test('if the dashboard cannot be reached, nobody is locked out of playing', async () => {
  const s = setup({ meResult: () => ({ ok: false, status: 0, user: null }) });
  s.gate.update(s.snap);
  await flush();
  assert.equal(s.gate.state().status, 'offline');
  assert.equal(s.gate.isOpen, false);
  assert.equal(s.gate.require('join'), true);
});

test('only a test call offers Approve as me and Skip', async () => {
  const s = setup({ dev: true });
  s.gate.update(s.snap);
  await flush();
  assert.ok(byKey(s.gate.el, 'signin-skip'));
  byKey(s.gate.el, 'signin-dev-approve').click();
  await flush();
  await s.run(2500);
  assert.deepEqual(s.calls.devApprove, [['K7QM-2XPA', PIP]]);
  assert.equal(s.gate.state().status, 'in');
  const t = setup({ dev: true });
  t.gate.update(t.snap);
  await flush();
  byKey(t.gate.el, 'signin-skip').click();
  await flush();
  assert.equal(t.gate.state().status, 'skipped');
  assert.equal(t.gate.require('join'), true);
  assert.equal(t.gate.isOpen, false);
});

test('alone in a browser tab the prompt leads with the normal Log in with Yapin link', async () => {
  const s = setup({ alone: true });
  s.gate.update(s.snap);
  await flush();
  const login = s.gate.el.querySelector('.signin-login');
  assert.equal(login.getAttribute('href'), '/auth/login?next=%2Factivity%2F');
  assert.match(text(s.gate.el), /Or use a code/);
});

test('saved tokens are per call person, capped and validated', () => {
  const { window } = installDom();
  const win = { ...window, localStorage: memoryStore() };
  assert.equal(saveToken(win, PIP, 'bad'), false);
  for (let i = 0; i < 6; i += 1) saveToken(win, `de7e0000-0000-4000-8000-00000000000${i}`, TOKEN);
  assert.equal(Object.keys(readTokens(win)).length, 4);
  win.localStorage.setItem(AUTH_KEY, '{"x y":"nope","ok":"' + TOKEN + '"}');
  assert.deepEqual(readTokens(win), { ok: TOKEN });
  assert.equal(forgetToken(win, 'ok'), true);
  assert.equal(win.localStorage.getItem(AUTH_KEY), null);
  const noStore = {};
  Object.defineProperty(noStore, 'localStorage', { get() { throw new Error('denied'); } });
  assert.deepEqual(readTokens(noStore), {});
  assert.equal(saveToken(noStore, PIP, TOKEN), false);
});

test('the account client talks only to this site, sends the token as a bearer header and never in a URL', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    if (url === '/api/activity/me') return new Response(JSON.stringify({ user: { id: PIP, username: 'pip', display_name: 'Pip', avatar_url: 'javascript:alert(1)' }, via: 'code' }), { status: 200 });
    if (url === '/api/activity/link/start') return new Response(JSON.stringify({ code: 'K7QM-2XPA', token: POLL, expires: 1, ttl: 600000, interval: 2500 }), { status: 201 });
    if (url === '/api/activity/link/poll') return new Response(JSON.stringify({ status: 'approved', token: TOKEN, user: { id: PIP, username: 'pip' } }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const api = createAccountApi({ fetchImpl });
  const me = await api.me(TOKEN);
  assert.equal(me.user.avatar_url, null);
  assert.equal(seen[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  const started = await api.start(PIP);
  assert.equal(started.code, 'K7QM-2XPA');
  assert.deepEqual(JSON.parse(seen[1].init.body), { expect: PIP });
  const polled = await api.poll(POLL);
  assert.equal(polled.status, 'approved');
  assert.deepEqual(JSON.parse(seen[2].init.body), { token: POLL });
  for (const s of seen) assert.equal(s.url.includes(TOKEN) || s.url.includes(POLL), false);
  const down = createAccountApi({ fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual(await down.me(null), { ok: false, status: 0, user: null, via: 'dashboard' });
  assert.equal((await down.poll(POLL)).status, 'error');
});

test('the sign-in module sends no shared-state traffic and its stylesheet is linked before juice.css', () => {
  const src = readFileSync(path.join(activity, 'js', 'ui', 'signin.js'), 'utf8');
  assert.equal(/\.(set|send)\(/.test(src.replace(/\.setProperty\(|classList\.|\.setItem\(/g, '')), false);
  assert.equal(/bridge/.test(src), false);
  assert.equal(/window\.open|location\.(assign|href|replace)/.test(src), false);
  const html = readFileSync(path.join(activity, 'index.html'), 'utf8');
  const at = (f) => html.indexOf(`/activity/css/${f}`);
  assert.ok(at('signin.css') > at('tokens.css'));
  assert.ok(at('signin.css') > at('admin.css'));
  assert.ok(at('signin.css') < at('juice.css'));
});

test('mountApp only adds the sign-in gate when asked, and shows a Sign in button in the header while signed out', async () => {
  const { window } = installDom({ url: 'https://yapos.dev/activity/' });
  const { room } = await import('./activity-kit.test.js');
  const r = room(1, { join: false });
  await r.clock.advance(500);
  const { mountApp } = await import('../web/activity/js/ui/app.js');
  const mk = (signin, fetchImpl) => {
    const root = document.createElement('div');
    document.body.append(root);
    const win = Object.assign(window, { document, parent: {}, innerWidth: 400, innerHeight: 700, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, fetch: fetchImpl, localStorage: memoryStore() });
    return { root, app: mountApp({ root, engine: r.engines[0], bridge: { close() {} }, win, juice: false, signin }) };
  };
  const plain = mk(null, async () => new Response('{}', { status: 401 }));
  assert.equal(plain.root.querySelector('.signin-layer'), null);
  assert.equal(plain.app.signin, null);
  plain.app.destroy();
  const gated = mk({ dev: false }, async (url) => {
    if (url === '/api/activity/link/start') return new Response(JSON.stringify({ code: 'K7QM-2XPA', token: POLL, expires: 1, ttl: 600000, interval: 2500 }), { status: 201 });
    return new Response('{"error":"signed_out"}', { status: 401 });
  });
  await flush(20);
  gated.app.render(r.engines[0].snapshot());
  assert.ok(gated.root.querySelector('.signin-layer'));
  assert.equal(gated.app.signin.state().status, 'out');
  assert.ok(byKey(gated.root, 'signin'), 'header shows Sign in');
  assert.equal(gated.app.signin.require('join'), false);
  gated.app.destroy();
});
