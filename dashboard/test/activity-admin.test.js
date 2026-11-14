import test from 'node:test';
import assert from 'node:assert/strict';
import { room, person } from './activity-kit.test.js';
import { configureAdmins, resetAdmins, refreshAdmins, isAdmin, ownerId, adminIds, knows, ADMINS_ENDPOINT } from '../web/activity/js/admin.js';
import { cleanFx, cleanEmoji, cleanAdminAction, shiftEnd, FX_MAX_MS, FX_MIN_MS, ANNOUNCE_MAX, ANNOUNCE_MS, BAN_MAX } from '../web/activity/js/engine.js';
import { GAMES } from '../web/activity/js/games/index.js';
import { KEY as CHAIN } from '../web/activity/js/games/chain.js';

const OWNER = person(2).id;
const EXTRA = person(3).id;

const ticker = {
  id: 'ticker',
  name: 'Ticker',
  emoji: '⏱️',
  blurb: 'Test game',
  minPlayers: 1,
  keys: ['ticker'],
  start(api) {
    api.put('ticker', { ticks: 0 });
    api.setDeadline(api.now() + 20000);
  },
  intent() {},
  deadline(api) {
    const st = api.get('ticker');
    st.ticks += 1;
    api.put('ticker', st);
    api.setDeadline(api.now() + 20000);
  },
};

const games = [ticker, ...GAMES];

function fakeFetch(log, opts = {}) {
  return async (url, init) => {
    log.push({ url, init });
    if (opts.fail) throw new Error('offline');
    if (opts.status) return { ok: false, status: opts.status, json: async () => ({}) };
    const ids = new URL(url, 'https://yapos.dev').searchParams.get('ids').split(',');
    const extra = opts.extra || [EXTRA];
    return { ok: true, status: 200, json: async () => ({ admins: ids.filter((id) => id === OWNER || extra.includes(id)), owner: ids.includes(OWNER) ? OWNER : null }) };
  };
}

async function settle(clock, ms = 600) {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((r) => setImmediate(r));
    await clock.advance(ms / 6);
  }
}

async function setup(n = 4, opts = {}) {
  resetAdmins();
  const log = [];
  configureAdmins({ fetch: fakeFetch(log, opts), refreshMs: 0, win: null });
  const r = room(n, { games: opts.games || games, join: opts.join });
  await r.clock.advance(500);
  if (opts.load !== false) await refreshAdmins(r.engines.map((e) => e.snapshot().me));
  await settle(r.clock);
  const fx = r.engines.map(() => []);
  r.engines.forEach((e, i) => e.on('fx', (x) => fx[i].push(x)));
  return { ...r, log, fx };
}

function slotOf(e, id) {
  return e.snapshot().players.find((p) => p.id === id).slot;
}

test('the admin list comes from the server and marks the owner', async () => {
  const r = await setup(4);
  assert.equal(ownerId(), OWNER);
  assert.deepEqual(adminIds().sort(), [OWNER, EXTRA].sort());
  assert.equal(isAdmin(person(1).id), false);
  assert.equal(knows(person(1).id), true);
  assert.ok(r.log[0].url.startsWith(`${ADMINS_ENDPOINT}?ids=`));
  assert.equal(r.log[0].init.credentials, 'same-origin');
  const [host, owner, extra, plain] = r.engines;
  assert.equal(owner.admin.me(), true);
  assert.equal(extra.admin.me(), true);
  assert.equal(plain.admin.me(), false);
  assert.equal(host.admin.me(), false);
  assert.equal(plain.admin.owner(), OWNER);
  const snap = plain.snapshot();
  assert.equal(snap.admin.me, false);
  assert.equal(snap.admin.owner, OWNER);
  assert.equal(snap.players.find((p) => p.id === OWNER).isOwner, true);
  assert.equal(snap.players.find((p) => p.id === EXTRA).isAdmin, true);
  assert.equal(snap.players.find((p) => p.id === EXTRA).isOwner, false);
  assert.equal(snap.players.find((p) => p.id === person(4).id).isAdmin, false);
});

test('when the admin list cannot load, nobody is an admin', async () => {
  for (const opts of [{ fail: true }, { status: 500 }]) {
    const r = await setup(3, opts);
    const [host, owner] = r.engines;
    assert.equal(isAdmin(OWNER), false);
    assert.equal(ownerId(), null);
    assert.equal(owner.admin.me(), false);
    assert.equal(owner.admin.run({ type: 'lock', on: true }), false);
    assert.equal(owner.admin.fx('confetti'), false);
    owner.broadcast({ t: 'adm', a: { type: 'lock', on: true } });
    owner.broadcast({ t: 'fx', fx: 'flip', target: null, ms: 5000 });
    await settle(r.clock);
    assert.equal(host.snapshot().admin.locked, false);
    assert.deepEqual(r.fx, [[], [], []]);
  }
});

test("a non-admin's admin intent is ignored and an admin's works", async () => {
  const r = await setup(4);
  const [host, , extra, plain] = r.engines;
  assert.equal(plain.admin.run({ type: 'lock', on: true }), false);
  plain.broadcast({ t: 'adm', a: { type: 'lock', on: true } });
  plain.broadcast({ t: 'adm', a: { type: 'announce', text: 'hi' } });
  await settle(r.clock);
  assert.equal(host.snapshot().admin.locked, false);
  assert.equal(host.snapshot().announce, null);
  assert.equal(extra.admin.run({ type: 'lock', on: true }), true);
  await settle(r.clock);
  for (const e of r.engines) assert.equal(e.snapshot().admin.locked, true);
});

test('the host checks the server once for a sender it has not seen yet', async () => {
  const r = await setup(4, { load: false });
  const [host, , extra, plain] = r.engines;
  assert.equal(knows(EXTRA), false);
  extra.broadcast({ t: 'adm', a: { type: 'lock', on: true } });
  plain.broadcast({ t: 'adm', a: { type: 'announce', text: 'sneaky' } });
  await settle(r.clock);
  assert.equal(host.snapshot().admin.locked, true);
  assert.equal(host.snapshot().announce, null);
  assert.ok(r.log.length >= 1 && r.log.length <= 2);
});

test('lock stops new players but admins can still join', async () => {
  const r = await setup(3, { join: false });
  const [host, owner, extra] = r.engines;
  assert.equal(owner.admin.run({ type: 'lock', on: true }), true);
  await settle(r.clock);
  host.join();
  extra.join();
  owner.join();
  await settle(r.clock, 1200);
  assert.equal(host.snapshot().meJoined, false);
  assert.equal(extra.snapshot().meJoined, true);
  assert.equal(owner.snapshot().meJoined, true);
  assert.equal(owner.admin.run({ type: 'lock', on: false }), true);
  await settle(r.clock);
  host.join();
  await settle(r.clock);
  assert.equal(host.snapshot().meJoined, true);
  assert.equal(host.snapshot().admin.locked, false);
});

test('ban kicks a player and keeps them out until unbanned', async () => {
  const r = await setup(4);
  const [host, , extra, plain] = r.engines;
  const pid = person(4).id;
  const slot = slotOf(host, pid);
  assert.equal(plain.snapshot().meJoined, true);
  assert.equal(extra.admin.run({ type: 'ban', slot }), true);
  await settle(r.clock);
  assert.equal(plain.snapshot().meJoined, false);
  assert.deepEqual(plain.snapshot().admin.banned, [pid]);
  plain.join();
  await settle(r.clock, 1200);
  assert.equal(plain.snapshot().meJoined, false);
  assert.equal(r.hub.people.some((p) => p.id === pid), true);
  assert.equal(extra.admin.run({ type: 'unban', id: pid }), true);
  await settle(r.clock);
  assert.deepEqual(host.snapshot().admin.banned, []);
  plain.join();
  await settle(r.clock);
  assert.equal(plain.snapshot().meJoined, true);
});

test('kick moves a player to watching without touching the call', async () => {
  const r = await setup(4);
  const [host, owner, , plain] = r.engines;
  owner.admin.run({ type: 'kick', slot: slotOf(host, person(4).id) });
  await settle(r.clock);
  assert.equal(plain.snapshot().meJoined, false);
  assert.equal(plain.snapshot().admin.banned.length, 0);
  plain.join();
  await settle(r.clock);
  assert.equal(plain.snapshot().meJoined, true);
});

test('the owner cannot be kicked, banned, trolled or lose points by other admins', async () => {
  const r = await setup(4);
  const [host, owner, extra] = r.engines;
  host.lobby.pick('ticker');
  host.lobby.start();
  await settle(r.clock);
  const os = slotOf(host, OWNER);
  extra.admin.run({ type: 'kick', slot: os });
  extra.admin.run({ type: 'ban', slot: os });
  extra.admin.run({ type: 'ban', id: OWNER });
  extra.admin.run({ type: 'points', slot: os, n: -500 });
  await settle(r.clock);
  const snap = host.snapshot();
  assert.equal(owner.snapshot().meJoined, true);
  assert.deepEqual(snap.admin.banned, []);
  assert.equal(snap.scores.g[os] || 0, 0);
  assert.equal(extra.admin.fx('flip', { target: OWNER }), false);
  extra.broadcast({ t: 'fx', fx: 'clown', target: OWNER, ms: 5000 });
  await settle(r.clock);
  for (const list of r.fx) assert.equal(list.length, 0);
  const es = slotOf(host, EXTRA);
  owner.admin.run({ type: 'points', slot: es, n: 250 });
  owner.admin.run({ type: 'kick', slot: es });
  await settle(r.clock);
  assert.equal(host.snapshot().scores.g[es], 250);
  assert.equal(extra.snapshot().meJoined, false);
  assert.equal(owner.admin.fx('clown', { target: EXTRA }), true);
  await settle(r.clock);
  assert.equal(r.fx[2].length, 1);
  assert.equal(r.fx[2][0].by, OWNER);
});

test('admins can target other admins and give or take points this game', async () => {
  const r = await setup(4);
  const [host, owner, extra] = r.engines;
  extra.admin.run({ type: 'points', slot: slotOf(host, person(4).id), n: 99 });
  await settle(r.clock);
  assert.equal(host.snapshot().scores.g[slotOf(host, person(4).id)] || 0, 0);
  host.lobby.pick('ticker');
  host.lobby.start();
  await settle(r.clock);
  const ps = slotOf(host, person(4).id);
  extra.admin.run({ type: 'points', slot: ps, n: 5_000_000 });
  await settle(r.clock);
  assert.equal(host.snapshot().scores.g[ps], 100000);
  extra.admin.run({ type: 'points', slot: ps, n: -40000 });
  await settle(r.clock);
  assert.equal(host.snapshot().scores.g[ps], 60000);
  assert.equal(owner.admin.run({ type: 'ban', slot: slotOf(host, EXTRA) }), true);
  await settle(r.clock);
  assert.deepEqual(host.snapshot().admin.banned, [EXTRA]);
});

test('start and end work from any admin', async () => {
  const r = await setup(3);
  const [host, , extra] = r.engines;
  host.lobby.pick('ticker');
  await settle(r.clock);
  extra.admin.run({ type: 'start' });
  await settle(r.clock);
  assert.equal(extra.snapshot().room.phase, 'game');
  assert.equal(extra.snapshot().room.game, 'ticker');
  extra.admin.run({ type: 'end' });
  await settle(r.clock);
  assert.equal(extra.snapshot().room.phase, 'lobby');
  assert.equal(extra.snapshot().state.ticker, undefined);
});

test('announcements are cleaned, shown to everyone for 10 seconds and can be cleared', async () => {
  const r = await setup(3);
  const [host, owner, extra] = r.engines;
  owner.admin.run({ type: 'announce', text: `  Hello\u0000‮   everyone ${'x'.repeat(300)}` });
  await settle(r.clock);
  for (const e of r.engines) {
    const a = e.snapshot().announce;
    assert.ok(a);
    assert.equal(a.text.startsWith('Hello everyone x'), true);
    assert.equal(Array.from(a.text).length, ANNOUNCE_MAX);
  }
  await r.clock.advance(ANNOUNCE_MS);
  for (const e of r.engines) assert.equal(e.snapshot().announce, null);
  extra.admin.run({ type: 'announce', text: 'Pizza time' });
  await settle(r.clock);
  assert.equal(host.snapshot().announce.text, 'Pizza time');
  extra.admin.run({ type: 'announce', text: '   ' });
  await settle(r.clock);
  assert.equal(host.snapshot().announce, null);
});

test('effects reach everyone and forged ones are ignored on every client', async () => {
  const r = await setup(4);
  const [, owner, extra, plain] = r.engines;
  assert.equal(extra.admin.fx('confetti'), true);
  await settle(r.clock);
  for (const list of r.fx) {
    assert.equal(list.length, 1);
    assert.equal(list[0].fx, 'confetti');
    assert.equal(list[0].by, EXTRA);
    assert.equal(list[0].target, null);
  }
  assert.equal(plain.admin.fx('confetti'), false);
  plain.broadcast({ t: 'fx', fx: 'flip', target: null, ms: 5000 });
  plain.broadcast({ t: 'many', m: [{ t: 'fx', fx: 'crash', target: null, ms: 5000 }] });
  await settle(r.clock);
  for (const list of r.fx) assert.equal(list.length, 1);
  extra.broadcast({ t: 'fx', fx: 'explode', target: null });
  extra.broadcast({ t: 'fx', fx: 'spotlight', target: null });
  extra.broadcast({ t: 'fx', fx: 'flip', target: '<script>' });
  await settle(r.clock);
  for (const list of r.fx) assert.equal(list.length, 1);
  assert.equal(owner.admin.fx('shake', { ms: 999999 }), true);
  await settle(r.clock);
  for (const list of r.fx) assert.equal(list[list.length - 1].ms, FX_MAX_MS);
});

test('a troll for everyone from another admin skips the owner', async () => {
  const r = await setup(4);
  const [, owner, extra] = r.engines;
  assert.equal(extra.admin.fx('flip'), true);
  await settle(r.clock);
  assert.equal(r.fx[1].length, 0);
  assert.equal(r.fx[0].length, 1);
  assert.equal(r.fx[3].length, 1);
  assert.equal(r.fx[2].length, 1);
  assert.equal(owner.admin.fx('mirror'), true);
  await settle(r.clock);
  for (const list of r.fx) assert.equal(list[list.length - 1].fx, 'mirror');
});

test('effects are rate limited per sender', async () => {
  const r = await setup(3);
  const [, owner, extra] = r.engines;
  assert.equal(extra.admin.fx('confetti'), true);
  assert.equal(extra.admin.fx('confetti'), false);
  owner.broadcast({ t: 'many', m: [{ t: 'fx', fx: 'hype', target: null }, { t: 'fx', fx: 'hype', target: null }, { t: 'fx', fx: 'hype', target: null }] });
  await settle(r.clock);
  assert.equal(r.fx[0].filter((x) => x.by === OWNER).length, 1);
  assert.equal(r.fx[0].filter((x) => x.by === EXTRA).length, 1);
});

test('effect names, targets, times and emoji are checked', () => {
  assert.equal(cleanFx({ fx: 'nope' }), null);
  assert.equal(cleanFx({ fx: 'clown' }), null);
  assert.equal(cleanFx({ fx: 'fake-win', target: 'a b' }), null);
  assert.equal(cleanFx({ fx: 'shake', ms: 10 }).ms, FX_MIN_MS);
  assert.equal(cleanFx({ fx: 'shake', ms: 1e9 }).ms, FX_MAX_MS);
  assert.equal(cleanFx({ fx: 'shake', ms: 'lots' }).ms > 0, true);
  assert.equal(cleanFx({ fx: 'shake', extra: { evil: 1 } }).extra, null);
  assert.deepEqual(cleanFx({ fx: 'emoji-rain', extra: { emoji: '🍕' } }).extra, { emoji: '🍕' });
  assert.deepEqual(cleanFx({ fx: 'emoji-rain', extra: { emoji: 'buy coins now' } }).extra, { emoji: '🎉' });
  assert.equal(cleanEmoji('👍🏽'), '👍🏽');
  assert.equal(cleanEmoji('👨‍👩‍👧'), '👨‍👩‍👧');
  assert.equal(cleanEmoji('🇬🇧'), '🇬🇧');
  assert.equal(cleanEmoji('🍕🍕'), null);
  assert.equal(cleanEmoji('a'), null);
  assert.equal(cleanEmoji('7'), null);
  assert.equal(cleanEmoji('<b>'), null);
  assert.equal(cleanAdminAction({ type: 'nuke' }), null);
  assert.equal(cleanAdminAction({ type: 'points', slot: 1, n: 0 }), null);
  assert.equal(cleanAdminAction({ type: 'kick' }), null);
  assert.deepEqual(cleanAdminAction({ type: 'time', ms: -9e9 }), { type: 'time', ms: -600000 });
  assert.equal(BAN_MAX > 0, true);
});

test('time changes never leave less than 3 seconds or more than 10 minutes', () => {
  const at = 1000;
  assert.equal(shiftEnd(at + 20000, 10000, at), at + 30000);
  assert.equal(shiftEnd(at + 20000, -60000, at), at + 3000);
  assert.equal(shiftEnd(at + 2000, -5000, at), at + 2000);
  assert.equal(shiftEnd(at + 20000, 900000, at), at + 600000);
});

test('games without their own admin hook fall back to the room timer', async () => {
  const r = await setup(3);
  const [host, owner] = r.engines;
  host.lobby.pick('ticker');
  host.lobby.start();
  await settle(r.clock);
  const d0 = host.snapshot().room.deadline;
  owner.admin.run({ type: 'time', ms: 15000 });
  await settle(r.clock);
  assert.equal(host.snapshot().room.deadline, d0 + 15000);
  owner.admin.run({ type: 'skip' });
  await settle(r.clock);
  assert.equal(host.snapshot().state.ticker.ticks, 1);
});

test('admins can stretch the lobby countdown', async () => {
  const r = await setup(3);
  const [host, owner] = r.engines;
  host.lobby.pick('draw');
  await settle(r.clock);
  const at = host.snapshot().room.auto.at;
  owner.admin.run({ type: 'time', ms: 30000 });
  await settle(r.clock);
  assert.equal(host.snapshot().room.auto.at, at + 30000);
});

async function startGame(id, n = 4) {
  const r = await setup(n);
  const [host] = r.engines;
  host.lobby.pick(id);
  assert.equal(host.lobby.start().ok, true);
  await settle(r.clock);
  return r;
}

function timeChecks(r, key) {
  return async () => {
    const [host, owner] = r.engines;
    const before = host.snapshot().state[key];
    owner.admin.run({ type: 'time', ms: 10000 });
    await settle(r.clock);
    const after = host.snapshot().state[key];
    assert.equal(after.ends, before.ends + 10000);
    assert.equal(host.snapshot().room.deadline, after.ends);
    owner.admin.run({ type: 'time', ms: -600000 });
    await settle(r.clock);
    const short = host.snapshot().state[key];
    assert.ok(short.ends - host.now() >= 2000, `left ${short.ends - host.now()}`);
    assert.equal(host.snapshot().room.deadline, short.ends);
  };
}

test('word chain: skip passes the turn without losing a life, time moves the clock', async () => {
  const r = await startGame('chain');
  const [host, owner] = r.engines;
  const st = host.snapshot().state[CHAIN];
  owner.admin.run({ type: 'skip' });
  await settle(r.clock);
  const next = host.snapshot().state[CHAIN];
  assert.notEqual(next.cur, st.cur);
  assert.deepEqual(next.lives, st.lives);
  assert.equal(next.t, st.t + 1);
  assert.equal(next.last.kind, 'skip');
  assert.equal(next.letter, st.letter);
  assert.deepEqual(next.order, st.order);
  assert.equal(host.snapshot().room.deadline, next.ends);
  await timeChecks(r, CHAIN)();
});

test('trivia: skip reveals now, then moves on; time moves the clock', async () => {
  const r = await startGame('trivia');
  const [host, owner] = r.engines;
  await timeChecks(r, 'trivia')();
  const st = host.snapshot().state.trivia;
  assert.equal(st.phase, 'question');
  owner.admin.run({ type: 'skip' });
  await settle(r.clock);
  const rev = host.snapshot().state.trivia;
  assert.equal(rev.phase, 'reveal');
  assert.equal(rev.skipped, false);
  assert.equal(rev.i, st.i);
  owner.admin.run({ type: 'skip' });
  await settle(r.clock);
  const nx = host.snapshot().state.trivia;
  assert.equal(nx.phase, 'question');
  assert.equal(nx.i, st.i + 1);
});

test('would you rather: skip closes voting now, then moves on; time moves the clock', async () => {
  const r = await startGame('wyr');
  const [host, owner] = r.engines;
  await timeChecks(r, 'wyr')();
  const st = host.snapshot().state.wyr;
  owner.admin.run({ type: 'skip' });
  await settle(r.clock);
  assert.equal(host.snapshot().state.wyr.phase, 'reveal');
  owner.admin.run({ type: 'skip' });
  await settle(r.clock);
  assert.equal(host.snapshot().state.wyr.phase, 'vote');
  assert.equal(host.snapshot().state.wyr.i, st.i + 1);
});

test('draw: skip reveals and moves to the next drawer; time moves the clock', async () => {
  const r = await startGame('draw');
  const [host, owner] = r.engines;
  const first = host.snapshot().state.draw;
  assert.equal(first.phase, 'pick');
  owner.admin.run({ type: 'skip' });
  await settle(r.clock);
  const second = host.snapshot().state.draw;
  assert.equal(second.phase, 'pick');
  assert.notEqual(second.drawer, first.drawer);
  assert.equal(second.n, first.n + 1);
  const drawer = r.engines.find((e) => e.snapshot().meSlot === second.drawer);
  drawer.act({ type: 'pick', i: 0, n: second.n });
  await settle(r.clock);
  assert.equal(host.snapshot().state.draw.phase, 'draw');
  await timeChecks(r, 'draw')();
  owner.admin.run({ type: 'skip' });
  await settle(r.clock);
  const rev = host.snapshot().state.draw;
  assert.equal(rev.phase, 'reveal');
  assert.equal(rev.note, 'skip');
  assert.ok(rev.word);
  owner.admin.run({ type: 'skip' });
  await settle(r.clock);
  const third = host.snapshot().state.draw;
  assert.equal(third.phase, 'pick');
  assert.notEqual(third.drawer, second.drawer);
});

test('the admin list refreshes every minute and drops removed admins', async () => {
  resetAdmins();
  const log = [];
  let extra = [EXTRA];
  const timers = [];
  configureAdmins({
    win: null,
    fetch: async (url, init) => fakeFetch(log, { extra })(url, init),
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => {},
  });
  await refreshAdmins([OWNER, EXTRA, person(4).id]);
  assert.equal(isAdmin(EXTRA), true);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 60000);
  extra = [];
  timers[0].fn();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(isAdmin(EXTRA), false);
  assert.equal(isAdmin(OWNER), true);
  resetAdmins();
});

test('the minute refresh re-checks known admins even in a big call', async () => {
  resetAdmins();
  const log = [];
  let extra = [EXTRA];
  const timers = [];
  configureAdmins({
    win: null,
    fetch: async (url, init) => fakeFetch(log, { extra })(url, init),
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => {},
  });
  const crowd = Array.from({ length: 60 }, (_, i) => person(10 + i).id);
  await refreshAdmins([EXTRA, ...crowd]);
  assert.equal(isAdmin(EXTRA), true);
  extra = [];
  log.length = 0;
  timers[0].fn();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(log.length, 1);
  assert.equal(isAdmin(EXTRA), false);
  resetAdmins();
});
