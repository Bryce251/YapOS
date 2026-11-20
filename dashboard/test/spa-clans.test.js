import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, flush, type, FakeEvent } from './dom-shim.js';

const { document } = installDom({ url: 'https://dash.example.test/clans' });
document.documentElement = document.createElement('html');
if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const { renderClans, readClanView, createProblems, actionStatusText, pendingActions, CLAN_ACTIONS_API } = await import('../web/js/pages/clans.js');
const { renderInbox, readInbox, answerText, kindIcon } = await import('../web/js/pages/inbox.js');
const { createInboxWatch } = await import('../web/js/inbox-watch.js');
const { inboxLink, paintBells, bellText, bellLabel } = await import('../web/js/shell.js');
const { matchRoute } = await import('../web/js/router.js');

function walk(node, out = []) {
  for (const c of node.childNodes || []) {
    out.push(c);
    walk(c, out);
  }
  return out;
}
const click = (el) => el.dispatchEvent(new FakeEvent('click', { bubbles: true }));
const buttons = (root) => walk(root).filter((n) => n.localName === 'button');
const byText = (root, text) => buttons(root).find((b) => b.textContent.trim() === text || b.getAttribute('aria-label') === text);
const text = (root) => root.textContent.replace(/\s+/g, ' ');
const confirmYes = async () => {
  await flush();
  const ok = [...document.querySelectorAll('.dialog-root button')].pop();
  if (ok) click(ok);
  await flush();
};

const LEAD = '11111111-1111-4111-8111-111111111111';
const KIM = '22222222-2222-4222-8222-222222222222';

function clanData(over = {}) {
  return {
    owner: false,
    settings: { createCost: 500, stylePrice: 1500, boostPrice: 5000, boost: 0.05 },
    clan: {
      id: 'c1', tag: 'OWL', name: 'Night Owls', colour: '#ff8800', banner: 'Hoot', join: 'open', count: 2, created: 1, leader: true, leaderName: 'Sam',
      bank: 2000, style: false, boost: false, deposits: [{ name: 'Sam', amount: 2000 }],
      members: [{ id: LEAD, name: 'Sam', username: 'sam', level: 9, leader: true, you: true }, { id: KIM, name: 'Kim', username: 'kim', level: 3, leader: false, you: false }],
      more: 0,
      invites: [{ id: 'x', name: 'Dee', username: 'dee', at: Date.now() - 1000 }],
    },
    invites: [],
    actions: [],
    joining: null,
    ...over,
  };
}

function ctxOf(api, main = document.createElement('main')) {
  const ctrl = new AbortController();
  const chrome = [];
  return { api, main, signal: ctrl.signal, setChrome: (c) => chrome.push(c), chrome, stop: () => ctrl.abort() };
}

test('the clans and inbox pages are private routes', () => {
  assert.deepEqual([matchRoute('/clans').name, matchRoute('/clans').private], ['clans', true]);
  assert.deepEqual([matchRoute('/inbox').name, matchRoute('/inbox').private], ['inbox', true]);
});

test('clan page data is read safely and the create form checks names like the bot', () => {
  const v = readClanView({ clan: { tag: 'OWL', colour: 'javascript:x', members: [null, { id: 'a' }], deposits: 'x' }, actions: [{ id: 'a', kind: 'tag', status: 'weird' }] });
  assert.equal(v.clan.colour, null);
  assert.equal(v.clan.members[1].name, 'Private profile');
  assert.deepEqual(v.clan.deposits, []);
  assert.equal(v.actions[0].status, 'pending');
  assert.equal(pendingActions(v).length, 1);
  assert.equal(readClanView(null).clan, null);
  assert.deepEqual(createProblems({ name: 'Night Owls', tag: 'OWL' }), {});
  assert.ok(createProblems({ name: 'Staff Club', tag: 'OWL' }).name);
  assert.ok(createProblems({ name: 'Night Owls', tag: 'O' }).tag);
  assert.deepEqual(createProblems({ name: 'YapOS Crew', tag: 'YAP' }, { owner: true }), {});
  assert.equal(actionStatusText({ kind: 'tag', status: 'refused', message: 'That tag is taken.' }), 'Change the tag: That tag is taken.');
  assert.match(actionStatusText({ kind: 'invite', status: 'pending', waiting: true }), /offline/);
});

test('the leader sees members, invites, settings and upgrades and every change is queued', async () => {
  const posts = [];
  let data = clanData();
  const api = {
    get: async () => data,
    post: async (path, body) => {
      posts.push([path, body]);
      return { action: { id: `a${posts.length}`, kind: body.kind, status: 'pending', created: Date.now(), updated: Date.now() } };
    },
  };
  const ctx = ctxOf(api);
  renderClans(ctx);
  await flush();
  const t = text(ctx.main);
  assert.match(t, /\[OWL\]Night Owls/);
  assert.match(t, /You lead this clan/);
  assert.match(t, /Waiting for an answer/);
  assert.match(t, /Dee/);
  assert.match(t, /2,000/);
  assert.equal(ctx.chrome[0].section, 'clans');
  assert.ok(byText(ctx.main, 'Save color').disabled, 'colour is locked until the upgrade');
  click(byText(ctx.main, 'Remove'));
  await confirmYes();
  assert.deepEqual(posts.at(-1), [CLAN_ACTIONS_API, { kind: 'kick', target: KIM }]);
  click(byText(ctx.main, 'Make leader'));
  await confirmYes();
  assert.deepEqual(posts.at(-1)[1], { kind: 'leader', target: KIM });
  click(byText(ctx.main, 'Invite only'));
  await flush();
  assert.deepEqual(posts.at(-1)[1], { kind: 'privacy', mode: 'invite' });
  const inviteInput = walk(ctx.main).find((n) => n.localName === 'input' && /username/.test(n.placeholder || ''));
  inviteInput.value = '@kim';
  walk(ctx.main).find((n) => n.localName === 'form' && n.className === 'clan-invite-form').dispatchEvent(new FakeEvent('submit', { bubbles: true, cancelable: true }));
  await flush();
  assert.deepEqual(posts.at(-1)[1], { kind: 'invite', who: '@kim' });
  const findInvite = () => walk(ctx.main).find((n) => n.localName === 'input' && /username/.test(n.placeholder || ''));
  assert.equal(findInvite().value, '', 'a sent invite clears the box');
  findInvite().value = '@de';
  click(byText(ctx.main, 'Buy · 1,500 💎'));
  await confirmYes();
  assert.deepEqual(posts.at(-1)[1], { kind: 'upgrade', upgrade: 'style' });
  assert.equal(findInvite().value, '@de', 'half-typed text survives the page redrawing');
  click(byText(ctx.main, 'Close the clan'));
  await confirmYes();
  assert.deepEqual(posts.at(-1)[1], { kind: 'disband', confirm: true });
  assert.match(text(ctx.main), /waiting for YapOS/);
  ctx.stop();
});

test('someone without a clan sees invites, the create form and the clan finder', async () => {
  const posts = [];
  const gets = [];
  const api = {
    get: async (path) => {
      gets.push(path);
      if (path.startsWith('/api/clans')) return { clans: [{ tag: 'LARK', name: 'Day Larks', members: 3, join: 'open' }], more: false };
      return clanData({ clan: null, invites: [{ clan: { id: 'c2', tag: 'LARK', name: 'Day Larks', members: 3, join: 'invite' }, by: 'Bob', at: Date.now() }] });
    },
    post: async (path, body) => {
      posts.push(body);
      return { action: { id: 'a1', kind: body.kind, status: 'pending' } };
    },
  };
  const ctx = ctxOf(api);
  renderClans(ctx);
  await flush(20);
  assert.match(text(ctx.main), /Your invites/);
  assert.match(text(ctx.main), /From Bob/);
  assert.ok(gets.some((p) => p.startsWith('/api/clans')));
  assert.match(text(ctx.main), /Day Larks/);
  const browseLoads = gets.filter((p) => p.startsWith('/api/clans')).length;
  click(byText(ctx.main, 'Join'));
  await flush();
  assert.deepEqual(posts.at(-1), { kind: 'accept', clan: 'c2' });
  assert.equal(gets.filter((p) => p.startsWith('/api/clans')).length, browseLoads, 'the clan finder is not reloaded on every redraw');
  const form = walk(ctx.main).find((n) => n.localName === 'form' && n.className === 'clan-create');
  const [name, tag] = walk(form).filter((n) => n.localName === 'input');
  name.value = 'Staff Club';
  tag.value = 'OWL';
  form.dispatchEvent(new FakeEvent('submit', { bubbles: true, cancelable: true }));
  await flush();
  assert.equal(posts.length, 1, 'a reserved name is caught before sending');
  assert.match(text(form), /isn't allowed/);
  name.value = 'Night Owls';
  form.dispatchEvent(new FakeEvent('submit', { bubbles: true, cancelable: true }));
  await confirmYes();
  assert.deepEqual(posts.at(-1), { kind: 'create', name: 'Night Owls', tag: 'OWL' });
  ctx.stop();
});

test('the bell shows the unread count and the watcher toasts new items, pausing while hidden', async () => {
  assert.equal(bellText(0), '');
  assert.equal(bellText(7), '7');
  assert.equal(bellText(150), '99+');
  assert.equal(bellLabel(2), 'Inbox, 2 unread');
  const root = document.createElement('div');
  root.appendChild(inboxLink(false, 0));
  paintBells(root, 3);
  const a = root.querySelector('.bell-link');
  assert.ok(a.classList.contains('has-unread'));
  assert.equal(a.querySelector('.bell-count').textContent, '3');
  assert.equal(a.getAttribute('aria-label'), 'Inbox, 3 unread');
  paintBells(root, 0);
  assert.equal(a.querySelector('.bell-count').hidden, true);

  const doc = { hidden: false, listeners: {}, addEventListener(n, fn) { this.listeners[n] = fn; }, removeEventListener(n) { delete this.listeners[n]; } };
  const timers = [];
  let answer = { unread: 1, newest: [{ id: 'n1', title: 'Old one' }] };
  let calls = 0;
  const counts = [];
  const toasts = [];
  const w = createInboxWatch({
    api: { get: async () => { calls += 1; return answer; } },
    onCount: (n) => counts.push(n),
    onNew: (item) => toasts.push(item.title),
    doc,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });
  w.start();
  await flush();
  assert.deepEqual(counts, [1]);
  assert.deepEqual(toasts, [], 'nothing is toasted on the first look');
  assert.equal(timers.at(-1).ms, 60000);
  answer = { unread: 2, newest: [{ id: 'n2', title: 'Clan invite' }, { id: 'n1', title: 'Old one' }] };
  await timers.at(-1).fn();
  assert.deepEqual(toasts, ['Clan invite']);
  doc.hidden = true;
  const before = calls;
  await timers.at(-1).fn();
  assert.equal(calls, before, 'no polling while the tab is hidden');
  doc.hidden = false;
  answer = { unread: 3, newest: [{ id: 'n3', title: 'Gift' }] };
  doc.listeners.visibilitychange();
  await flush();
  assert.deepEqual(toasts, ['Clan invite', 'Gift']);
  w.setCount(0);
  assert.equal(counts.at(-1), 0);
  w.stop();
  assert.equal(doc.listeners.visibilitychange, undefined);
});

test('the inbox page lists items, answers invites and marks things read', async () => {
  const calls = [];
  let data = {
    items: [
      { id: 'n1', kind: 'clan_invite', title: 'Clan invite from [OWL] Night Owls', body: 'Sam invited you.', created: Date.now(), read: false, link: '/clans', canAnswer: true, answer: null },
      { id: 'n2', kind: 'gift', title: 'You got 100 💎 Shards', body: null, created: Date.now() - 5000, read: true, link: '//evil.example', canAnswer: false },
    ],
    unread: 1,
    more: false,
    warnings: [{ id: 'w1', by: 'Staff', text: 'Be kind', created: Date.now() }],
  };
  const api = {
    get: async () => data,
    request: async (method, path, opts) => {
      calls.push([method, path, opts.body]);
      if (path.endsWith('/answer')) return { action: { id: 'a1', status: 'pending', message: 'Waiting for YapOS…' } };
      return { ok: true, unread: 0 };
    },
  };
  const v = readInbox(data);
  assert.equal(v.items[1].link, null, 'odd links are dropped');
  assert.equal(answerText({ status: 'refused', message: '' }), "YapOS couldn't do that.");
  assert.equal(kindIcon('nope'), 'bell');
  const ctx = ctxOf(api);
  renderInbox(ctx);
  await flush();
  assert.match(text(ctx.main), /1 unread/);
  assert.match(text(ctx.main), /Be kind/);
  click(byText(ctx.main, 'Accept'));
  await flush();
  assert.deepEqual(calls.at(-1), ['POST', '/api/me/inbox/n1/answer', { answer: 'accept' }]);
  assert.match(text(ctx.main), /Waiting for YapOS/);
  assert.equal(byText(ctx.main, 'Accept'), undefined);
  assert.match(text(ctx.main), /All caught up/, 'answering an invite counts it as read');
  click(byText(ctx.main, 'Mark all read'));
  await flush();
  assert.deepEqual(calls.at(-1), ['POST', '/api/me/inbox/read', { all: true }]);
  click(byText(ctx.main, 'Delete "You got 100 💎 Shards"'));
  await flush();
  assert.deepEqual(calls.at(-1), ['DELETE', '/api/me/inbox/n2', undefined]);
  assert.doesNotMatch(text(ctx.main), /You got 100/);
  ctx.stop();
  data = null;
});
