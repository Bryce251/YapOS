import test from 'node:test';
import assert from 'node:assert/strict';
import { Clock, Hub, person, seeded } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import { createEngine } from '../web/activity/js/engine.js';
import { AWARDS_MAX, PARTY_SETTINGS, genericAwards, upsetLine, cleanAward, cleanHighlight } from '../web/activity/js/fun.js';
const NO_ADMINS = { isAdmin: () => false, knows: () => true, ownerId: () => null, banned: () => false, refresh: null, onChange: null };

function duel(over = {}) {
  return {
    id: 'duel',
    name: 'Duel',
    emoji: '⚔️',
    blurb: 'Test game',
    minPlayers: 1,
    keys: ['duel'],
    settings: [],
    cards: ['swap', 'double', 'freeze', 'peek'],
    start(api) {
      api.put('duel', { on: 1 });
    },
    intent(api, slot, a) {
      if (a.type === 'score') api.put('duel', { ...api.get('duel'), got: api.addPoints(slot, a.n) });
      if (a.type === 'round') api.round(a.i, a.of || 3);
      if (a.type === 'thaw') api.thaw(a.slot);
      if (a.type === 'end') api.finish();
    },
    freeze(api, to) {
      api.put('duel', { ...api.get('duel'), iced: to });
      return true;
    },
    hint() {
      return 'It starts with B';
    },
    deadline() {},
    resume() {},
    ...over,
  };
}

function funRoom(count, games, opts = {}) {
  const clock = new Clock();
  const hub = new Hub(clock);
  const random = seeded(5);
  const funRandom = seeded(opts.seed || 3);
  const posts = [];
  const reports = [];
  const engines = [];
  const add = (n, join = opts.join !== false) => {
    const e = createEngine({
      transport: hub.join(person(n)),
      games,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      random,
      funRandom,
      admins: NO_ADMINS,
      postResults: (b) => {
        posts.push(b);
        return true;
      },
      reportText: (b) => {
        reports.push(b);
        return true;
      },
    });
    if (join) e.join();
    engines.push(e);
    return e;
  };
  for (let i = 1; i <= count; i += 1) add(i);
  return { clock, hub, engines, posts, reports, add };
}

async function started(game, count = 3, opts = {}) {
  const r = funRoom(count, [game], opts);
  await r.clock.advance(500);
  if (opts.before) opts.before(r);
  await r.clock.advance(200);
  assert.equal(r.engines[0].lobby.start().ok, true);
  await r.clock.advance(400);
  return r;
}

function teamDuel(over = {}) {
  return duel({
    cards: ['double'],
    awards() {
      return [
        { title: 'Duelist', emoji: '⚔️', who: 0, why: 'Stood tall' },
        { title: 'Ghost', emoji: '👻', who: 99, why: 'Nobody' },
        { title: '', who: 1 },
      ];
    },
    highlights() {
      return [
        { text: 'what a shot', who: 1 },
        { text: 'visit https://example.com now', who: 2 },
        { text: '   ', who: 0 },
      ];
    },
    results(api) {
      return { teams: api.sameTeams() ? { 0: 'Blue', 1: 'Red', 2: 'Blue' } : { 0: 'Red', 1: 'Blue', 2: 'Red' } };
    },
    ...over,
  });
}

async function finished(game = teamDuel()) {
  const r = await started(game);
  const [host, a, b] = r.engines;
  a.play('double');
  await r.clock.advance(400);
  host.act({ type: 'score', n: 500 });
  await r.clock.advance(1000);
  a.act({ type: 'score', n: 100 });
  b.act({ type: 'score', n: 50 });
  await r.clock.advance(1000);
  a.act({ type: 'score', n: 400 });
  await r.clock.advance(1000);
  host.act({ type: 'end' });
  await r.clock.advance(500);
  return r;
}

test('the end screen gets game awards, generic awards, a highlight reel and an upset line', async () => {
  const r = await finished();
  const s = r.engines[2].snapshot();
  assert.equal(s.room.phase, 'results');
  assert.deepEqual(s.room.last.winners, [1]);
  const titles = s.fun.awards.map((a) => a.title);
  assert.equal(titles[0], 'Duelist', 'game awards come first');
  assert.ok(titles.includes('Chaos agent'));
  assert.ok(!titles.includes('Ghost'), 'awards for unknown players are dropped');
  assert.ok(s.fun.awards.length <= AWARDS_MAX);
  assert.deepEqual(s.fun.highlights.map((h) => h.slot), [1, 2]);
  assert.equal(s.fun.highlights[1].text.includes('example.com'), false, 'links are cleaned');
  assert.match(s.fun.upset, /Player 2 came back from/);
  assert.equal(s.fun.sameTeams, true);
  assert.ok(JSON.stringify(r.hub.state.fun).length < 4096);
});

test('genericAwards and upsetLine read the score timeline', () => {
  const st = { hits: { 0: 900, 1: 300 }, events: 4, played: [{ slot: 2, code: 's' }], worst: { 1: 3 }, bestStreak: { 0: 4 }, re: { 2: 9 }, fast: {}, frozen: {}, behind: { 1: 800 }, changes: 1 };
  const list = genericAwards(st, { finalPlace: { 0: 1, 1: 0, 2: 2 } });
  assert.deepEqual(
    list.map((a) => [a.t, a.s[0]]),
    [
      ['Speed demon', 0],
      ['Chaos agent', 2],
      ['Comeback kid', 1],
      ['On fire', 0],
      ['Hype machine', 2],
    ],
  );
  assert.match(list[2].y, /4th to 1st/);
  const name = (s) => `P${s}`;
  assert.match(upsetLine(st, { winners: [1], players: 3, points: { 1: 1000 }, nameOf: name }), /P1 came back from 800 points/);
  assert.equal(upsetLine({ ...st, behind: { 1: 10 } }, { winners: [1], players: 3, points: { 1: 1000 }, nameOf: name }), null, 'a tiny gap is no upset');
  assert.match(upsetLine({ changes: 4 }, { winners: [0], players: 3 }), /changed 4 times/);
  assert.equal(cleanAward({ title: 'x', who: [] }), null);
  assert.deepEqual(cleanHighlight({ text: 'hi', who: 'x' }), { x: 'hi' });
});

test('highlights can be reported during results, but not your own', async () => {
  const r = await finished();
  const [host, a, b] = r.engines;
  assert.equal(b.canReport(), true);
  a.report('hl.0');
  assert.equal(b.report('hl.0'), 'sent');
  assert.equal(b.report('hl.0'), 'done');
  await r.clock.advance(500);
  assert.equal(r.reports.length, 1, 'the host drops Player 2 reporting their own highlight');
  assert.equal(r.reports[0].reporter.name, 'Player 3');
  assert.equal(r.reports[0].text, 'what a shot');
  assert.equal(r.reports[0].author.name, 'Player 2');
  assert.equal(r.reports[0].context, 'Highlight reel');
  assert.equal(host.report('hl.9'), 'no');
});

test('play again with the same teams hands the old teams to the next game', async () => {
  const r = await finished();
  const [host, a] = r.engines;
  let seen = null;
  const game = r.engines[0].games[0];
  const start = game.start;
  game.start = (api) => {
    seen = api.sameTeams();
    start(api);
  };
  assert.equal(host.lobby.start({ sameTeams: true }).ok, true);
  await r.clock.advance(400);
  assert.deepEqual(seen, { 0: 'r', 1: 'b', 2: 'r' });
  host.act({ type: 'end' });
  await r.clock.advance(400);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(400);
  assert.equal(seen, null, 'a normal Play again shuffles new teams');
  assert.equal(a.snapshot().room.phase, 'game');
});

test('the results screen shows awards, the reel, the upset line and both host buttons', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const { createResults, SAME_TEAMS_LABEL } = await import('../web/activity/js/ui/results.js');
  const r = await finished();
  const host = r.engines[0];
  const starts = [];
  const engine = { ...host, games: host.games, snapshot: host.snapshot, lobby: { ...host.lobby, start: (o) => starts.push(o || null) && { ok: true } }, report: host.report, reported: host.reported, canReport: host.canReport };
  const boardLink = { ready: () => true, open: () => true };
  const res = createResults({ engine, fx: { confetti() {}, clear() {} }, boardLink });
  res.update(host.snapshot());
  const text = (n) => (n.data !== undefined && !n.localName ? n.data : (n.childNodes || []).map(text).join(' '));
  const all = text(res.el);
  for (const want of ['Awards', 'Duelist', 'Chaos agent', 'Highlight reel', 'what a shot', 'came back from', SAME_TEAMS_LABEL, 'Leaderboard']) assert.ok(all.includes(want), want);
  const find = (key) => {
    const walk = (n) => {
      if (n.dataset && n.dataset.key === key) return n;
      for (const c of n.childNodes || []) {
        const x = walk(c);
        if (x) return x;
      }
      return null;
    };
    return walk(res.el);
  };
  find('again-teams').click();
  find('again').click();
  assert.deepEqual(starts, [{ sameTeams: true }, null]);
  assert.ok(find('report-hl.0'), 'other people can report a highlight');
  const faces = res.el.querySelectorAll('[data-profile-id]').filter((n) => n.getAttribute('role') === 'button');
  const ids = new Set(host.snapshot().players.map((p) => p.id));
  assert.ok(faces.length >= 2, 'the winner and the award winners open profiles');
  for (const f of faces) {
    assert.ok(ids.has(f.getAttribute('data-profile-id')), f.getAttribute('data-profile-id'));
    assert.equal(f.getAttribute('tabindex'), '0');
    assert.match(f.getAttribute('aria-label'), /^View (.+'s|your) profile$/);
  }
  const winner = res.el.querySelector('.winner-faces .avatar-btn');
  assert.ok(winner && winner.className.includes('ring-glow'));
  assert.ok(winner.querySelector('.avatar-crown'));
  assert.ok(res.el.querySelector('.award-person .avatar-btn'));
  assert.ok(find('again').className.includes('btn-cta'), 'Play again is the one glowing button');
  res.destroy();
});

test('tournament standings, watcher picks and host tools use clickable profile pictures', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const { tourCard } = await import('../web/activity/js/ui/tournament.js');
  const { predictResults } = await import('../web/activity/js/ui/predict.js');
  const { hostBar } = await import('../web/activity/js/ui/hosttools.js');
  const p = (id, name, extra = {}) => ({ id, name, initials: name.slice(0, 1), hue: 40, avatar: null, isMe: false, ...extra });
  const tour = tourCard({ i: 2, total: 3, done: true, games: [{ id: 'a', name: 'A', emoji: '🅰️' }], next: null, rows: [{ ...p('u1', 'Pip'), slot: 0, pts: 20, firsts: 1, gain: 10, place: 1 }, { ...p('u2', 'Juno'), slot: 1, pts: 12, firsts: 0, gain: 0, place: 2 }], champ: { ...p('u1', 'Pip'), slot: 0 } });
  assert.equal(tour.querySelector('.tour-champ-face [data-profile-id]').getAttribute('data-profile-id'), 'u1');
  assert.ok(tour.querySelector('.tour-place').className.includes('medal-1'));
  for (const row of tour.querySelectorAll('.tour-row')) assert.ok(row.querySelector('.avatar-btn[data-profile-id]'));
  const picks = predictResults({ rows: [{ ...p('w1', 'Watcher'), pick: 'Pip', right: true }], right: 1, counted: true });
  assert.equal(picks.querySelector('.predict-row .avatar-btn').getAttribute('aria-label'), "View Watcher's profile");
  const bar = hostBar({ open: true, lateLocked: false, players: [{ ...p('u2', 'Juno'), slot: 1, safe: false }] }, { onOpen() {}, onLate() {}, onRemove() {} });
  assert.equal(bar.querySelector('.host-player .avatar-btn').getAttribute('data-profile-id'), 'u2');
});

test('the leaderboard link loads lazily and hides when the module is missing', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const { createBoardLink, boardButton } = await import('../web/activity/js/ui/party.js');
  const calls = [];
  const engine = { snapshot: () => ({ me: 'me-1' }) };
  const host = document.createElement('div');
  const good = createBoardLink({ engine, host, loader: () => Promise.resolve({ openLeaderboard: (c, o) => calls.push([c, o]) }) });
  const bad = createBoardLink({ engine, host, loader: () => Promise.reject(new Error('missing')) });
  const off = createBoardLink({ engine, host, loader: false });
  assert.equal(good.ready(), false);
  await new Promise((done) => setTimeout(done, 5));
  assert.equal(good.ready(), true);
  assert.equal(bad.ready(), false);
  assert.equal(off.ready(), false);
  assert.equal(boardButton(bad), null);
  boardButton(good).click();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], host);
  assert.equal(calls[0][1].me, 'me-1');
  assert.equal(calls[0][1].engine, engine);
});

test('the lobby shows party extras the host can switch off', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const { createLobby } = await import('../web/activity/js/ui/lobby.js');
  const r = funRoom(2, [duel()]);
  await r.clock.advance(500);
  const host = r.engines[0];
  const lobby = createLobby({ engine: host, toast: () => {}, sfx: null, store: null });
  lobby.update(host.snapshot());
  const find = (key) => {
    const walk = (n) => {
      if (n.dataset && n.dataset.key === key) return n;
      for (const c of n.childNodes || []) {
        const x = walk(c);
        if (x) return x;
      }
      return null;
    };
    return walk(lobby.el);
  };
  for (const s of PARTY_SETTINGS) assert.equal(find(`party-${s.id}`).getAttribute('aria-pressed'), 'true', s.id);
  find('party-cards').click();
  await r.clock.advance(400);
  assert.equal(host.snapshot().party.cards, false);
  lobby.update(host.snapshot());
  assert.equal(find('party-cards').getAttribute('aria-pressed'), 'false');
  assert.equal(find('leaderboard'), null, 'no leaderboard button without the module');
  lobby.destroy();
});
