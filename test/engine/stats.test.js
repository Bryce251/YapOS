import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../engine/storage.js';
import { createStats, hourOf, ensureStats, dropStats, STATS_NS } from '../../engine/stats.js';

const S = '5e000000-0000-4000-8000-000000000001';
const S2 = '5e000000-0000-4000-8000-000000000002';
const A = 'a0000000-0000-4000-8000-000000000004';
const B = 'a0000000-0000-4000-8000-000000000005';
const HOUR = 3600_000;
const START = Date.parse('2026-11-15T10:20:00Z');

function fakeEngine(store = createMemoryStore()) {
  const handlers = {};
  const bot = {
    me: { id: 'b0000000-0000-4000-8000-000000000001' },
    handlers,
    on(e, fn) { (handlers[e] ||= []).push(fn); return bot; },
    async emit(e, p) { for (const fn of handlers[e] || []) await fn(p); },
  };
  return { bot, store, config: { dashboardUrl: 'https://yapos.test', dashboardSecret: 'sec' }, log: { debug() {}, warn() {}, info() {} } };
}

function fakeWorker() {
  const w = { calls: [], status: [] };
  w.fetch = async (url, init) => {
    const status = w.status.length ? w.status.shift() : 200;
    w.calls.push({ path: new URL(url).pathname, auth: init.headers.authorization, body: JSON.parse(init.body) });
    return { ok: status === 200, status, text: async () => '{}' };
  };
  return w;
}

test('stats: hours are ISO hour strings', () => {
  assert.equal(hourOf(Date.parse('2026-11-15T10:59:59.999Z')), '2026-11-15T10:00:00.000Z');
});

test('stats: messages, joins, leaves and active people are counted per server per hour', async () => {
  const e = fakeEngine();
  const clock = { t: START };
  const s = createStats(e, { now: () => clock.t, fetch: fakeWorker().fetch });
  s.install();
  await e.bot.emit('message', { server_id: S, author_id: A, content: 'hi' });
  await e.bot.emit('message', { server_id: S, author_id: A, content: 'again' });
  await e.bot.emit('message', { server_id: S, author_id: B, content: 'yo' });
  await e.bot.emit('message', { server_id: S, author_id: 'x', author_bot: true });
  await e.bot.emit('message', { server_id: null, author_id: A, dm: true });
  await e.bot.emit('message', { server_id: S, author_id: e.bot.me.id });
  await e.bot.emit('member_join', { server_id: S, user_id: B });
  await e.bot.emit('member_leave', { server_id: S, user_id: A });
  await e.bot.emit('member_join', { server_id: S2, user_id: A });
  assert.deepEqual(s.hours(S), [{ hour: '2026-11-15T10:00:00.000Z', messages: 3, joins: 1, leaves: 1, active: 2 }]);
  assert.deepEqual(s.hours(S2), [{ hour: '2026-11-15T10:00:00.000Z', messages: 0, joins: 1, leaves: 0, active: 0 }]);
  assert.deepEqual(s.totals(S, 0), { messages: 3, joins: 1, leaves: 1 });
  s.uninstall();
  await e.bot.emit('message', { server_id: S, author_id: A });
  assert.equal(s.totals(S, 0).messages, 3, 'no counting after uninstall');
});

test('stats: closed hours upload with counts only, never user ids, and failures retry later', async () => {
  const e = fakeEngine();
  const clock = { t: START };
  const w = fakeWorker();
  const s = createStats(e, { now: () => clock.t, fetch: w.fetch });
  s.record('message', S, A);
  s.record('message', S, B);
  s.record('join', S);
  let r = await s.flush();
  assert.equal(r.sent, 0, 'the open hour waits until it ends');
  assert.equal(w.calls.length, 0);
  clock.t += HOUR;
  s.record('message', S, A);
  w.status.push(500);
  r = await s.flush();
  assert.equal(r.failed, 1);
  assert.equal(s.pending(S).length, 1);
  r = await s.flush();
  assert.equal(r.sent, 1);
  const last = w.calls[w.calls.length - 1];
  assert.equal(last.path, '/bot/stats');
  assert.equal(last.auth, 'Bearer sec');
  assert.deepEqual(last.body, { server_id: S, hours: [{ hour: '2026-11-15T10:00:00.000Z', messages: 2, joins: 1, leaves: 0, active: 2 }] });
  assert.doesNotMatch(JSON.stringify(w.calls), new RegExp(A));
  assert.equal(s.pending(S).length, 0);
  await s.flush();
  assert.equal(w.calls.length, 2, 'nothing is sent twice');
});

test('stats: counts survive a restart, including the hour still open', async () => {
  const store = createMemoryStore();
  const clock = { t: START };
  const a = createStats(fakeEngine(store), { now: () => clock.t, fetch: fakeWorker().fetch });
  a.record('message', S, A);
  a.record('leave', S);
  a.save();
  assert.ok(store.get(STATS_NS, S, null));
  const b = createStats(fakeEngine(store), { now: () => clock.t, fetch: fakeWorker().fetch });
  b.record('message', S, A);
  b.record('message', S, B);
  assert.deepEqual(b.hours(S), [{ hour: '2026-11-15T10:00:00.000Z', messages: 3, joins: 0, leaves: 1, active: 2 }]);
  clock.t += 2 * HOUR;
  const w = fakeWorker();
  b.save();
  const c = createStats(fakeEngine(store), { now: () => clock.t, fetch: w.fetch });
  await c.flush();
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].body.hours[0].messages, 3);
});

test('stats: with no dashboard set up nothing is sent and counting still works', async () => {
  const e = fakeEngine();
  e.config = {};
  let calls = 0;
  const clock = { t: START };
  const s = createStats(e, { now: () => clock.t, fetch: async () => { calls++; return { ok: true, status: 200, text: async () => '' }; } });
  s.record('message', S, A);
  clock.t += HOUR;
  await s.flush();
  assert.equal(calls, 0);
  assert.equal(s.pending(S).length, 1);
  assert.equal(s.record('message', 'bad id!', A), false);
});

test('stats: ensureStats installs one shared counter that dropStats removes', async () => {
  const e = fakeEngine();
  const one = ensureStats(e, { fetch: fakeWorker().fetch });
  assert.equal(ensureStats(e), one);
  assert.equal(e.bot.handlers.message.length, 1);
  dropStats(e);
  assert.equal(e.serverStats, null);
  assert.equal(e.bot.handlers.message.length, 0);
});
