import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { room } from './activity-kit.test.js';
import { installDom, flush } from './dom-shim.js';
import * as dictionary from '../web/activity/js/dictionary.js';
import hive, { KEY as HIVE_KEY, DAILY_TIMER, hiveWords, dailyHive } from '../web/activity/js/games/hive.js';
import scramble, { KEY as SCRAMBLE_KEY, judgeDaily, dailyDeck, dailyTarget } from '../web/activity/js/games/scramble.js';
import {
  configureAdmins,
  resetAdmins,
  cleanDaily,
  utcDay,
  loadDaily,
  cachedDaily,
  dailyBody,
  sendDaily,
  dailyTop,
  DAILY_ENDPOINT,
  DAILY_TOP_ENDPOINT,
} from '../web/activity/js/admin.js';
import { configureDaily, resetDaily, noteDaily, finishDaily, dailyPlay, myLine, streakText, dailyView, createDailyBox, onDaily } from '../web/activity/js/ui/daily.js';
import { dailyOf, DAILY_INTRO } from '../web/activity/js/ui/lobby.js';
import { footText as hiveFoot } from '../web/activity/js/views/hive.js';
import { footText as scrambleFoot, dailyAnswers } from '../web/activity/js/views/scramble.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(path.join(here, '..', 'web', 'activity', 'data', 'words.txt'), 'utf8');
await dictionary.load(() => Promise.resolve(RAW));

const START = 1_700_000_000_000;
const DAY = new Date(START).toISOString().slice(0, 10);
const USER = { id: '00000001-aaaa-4bbb-8ccc-000000000001', name: 'Player 1', username: 'p1' };

function puzzle(date = DAY) {
  return { date, hive: { letters: ['k', 'i', 't', 'c', 'h', 'e', 'n'], centre: 'k' }, scramble: { rounds: [{ letters: 'koob', answerHash: 'x1' }, { letters: 'kace', answerHash: 'x2' }] } };
}

function fakeFetch(log, routes) {
  return async (url, init = {}) => {
    log.push({ url, init });
    for (const [match, reply] of routes) {
      if (url.startsWith(match) && (reply.method || 'GET') === (init.method || 'GET')) {
        const body = typeof reply.body === 'function' ? reply.body(url, init) : reply.body;
        return { ok: reply.ok !== false, json: async () => body };
      }
    }
    return { ok: false, json: async () => ({}) };
  };
}

test('daily puzzles are checked and normalised', () => {
  const p = cleanDaily(puzzle());
  assert.equal(p.date, DAY);
  assert.equal(p.hive.letters, 'cehikns'.replace('s', 't').split('').sort().join(''));
  assert.equal(p.hive.centre, 'k');
  assert.equal(p.scramble.rounds.length, 2);
  assert.equal(p.scramble.rounds[0].letters, 'koob');
  assert.equal(cleanDaily({ ...puzzle(), date: 'today' }), null);
  assert.equal(cleanDaily({ ...puzzle(), hive: { letters: ['a', 'a', 'b', 'c', 'd', 'e', 'f'], centre: 'a' } }), null);
  assert.equal(cleanDaily({ ...puzzle(), hive: { letters: 'kitchen', centre: 'z' } }), null);
  assert.equal(cleanDaily({ ...puzzle(), scramble: { rounds: [{ letters: 'no way!' }] } }), null);
  assert.equal(utcDay(Date.UTC(2026, 10, 15, 23, 59)), '2026-11-15');
});

test('the daily puzzle loads from yapos.dev once and is cached', async () => {
  const log = [];
  configureAdmins({ fetch: fakeFetch(log, [[DAILY_ENDPOINT, { body: puzzle() }]]), refreshMs: 0, win: null });
  try {
    const [a, b] = await Promise.all([loadDaily(DAY), loadDaily(DAY)]);
    assert.equal(a, b);
    assert.equal(a.hive.centre, 'k');
    assert.equal(log.length, 1);
    assert.equal(cachedDaily(DAY), a);
    await loadDaily(DAY);
    assert.equal(log.length, 1);
  } finally {
    resetAdmins();
  }
});

test('when yapos.dev is unreachable the shared daily module is used, and a total failure gives null', async () => {
  const log = [];
  let asked = null;
  configureAdmins({
    fetch: fakeFetch(log, []),
    refreshMs: 0,
    win: null,
    importDaily: async () => [{ dailyPuzzle: (date, opts) => { asked = opts; return puzzle(date); } }, { SEEDS: ['kitchen'] }, { WORDS: ['book'] }, dictionary],
  });
  try {
    const p = await loadDaily(DAY);
    assert.equal(p.date, DAY);
    assert.deepEqual(asked.hiveSeeds, ['kitchen']);
    assert.equal(typeof asked.isWord, 'function');
  } finally {
    resetAdmins();
  }
  configureAdmins({ fetch: fakeFetch([], []), refreshMs: 0, win: null, importDaily: async () => { throw new Error('missing'); } });
  try {
    assert.equal(await loadDaily(DAY), null);
  } finally {
    resetAdmins();
  }
});

test('daily submissions are cleaned and answered with score, rank and streak', async () => {
  assert.equal(dailyBody({ date: DAY, kind: 'hive', user: USER, words: [] }), null);
  assert.equal(dailyBody({ date: DAY, kind: 'chess', user: USER, words: ['kite'] }), null);
  assert.equal(dailyBody({ date: DAY, kind: 'hive', user: { id: 'bad id' }, words: ['kite'] }), null);
  const hb = dailyBody({ date: DAY, kind: 'hive', user: USER, words: ['Kite', 'kite', 'no', 'k1te', 'kitchen'], ms: 1234.6 });
  assert.deepEqual(hb.words, ['kite', 'kitchen']);
  assert.equal(hb.ms, 1235);
  const sb = dailyBody({ date: DAY, kind: 'scramble', user: USER, answers: ['book', null, 'CAKE!', 'cake'] });
  assert.deepEqual(sb.answers, ['book', '', '', 'cake', '']);
  assert.equal(dailyBody({ date: DAY, kind: 'scramble', user: USER, answers: ['', ''] }), null);
  const log = [];
  configureAdmins({ fetch: fakeFetch(log, [[DAILY_ENDPOINT, { method: 'POST', body: { score: 42, rank: 3, streak: 5 } }]]), refreshMs: 0, win: null });
  try {
    assert.deepEqual(await sendDaily({ date: DAY, kind: 'hive', user: USER, words: ['kite'], ms: 10 }), { score: 42, best: 42, rank: 3, streak: 5 });
    assert.equal(log[0].init.method, 'POST');
    assert.equal(JSON.parse(log[0].init.body).user.id, USER.id);
    assert.equal(await sendDaily({ date: DAY, kind: 'hive', user: USER, words: [] }), null);
    assert.equal(log.length, 1);
  } finally {
    resetAdmins();
  }
});

test("today's best is fetched per kind and cached for a short while", async () => {
  const log = [];
  const top = [{ name: 'Ada', username: 'ada', score: 90, streak: 4 }, { name: '', score: 'x' }, { name: 'Bo', score: 50.4 }];
  configureAdmins({ fetch: fakeFetch(log, [[DAILY_TOP_ENDPOINT, { body: { top } }]]), refreshMs: 0, win: null });
  try {
    const rows = await dailyTop('hive');
    assert.deepEqual(rows, [{ name: 'Ada', username: 'ada', score: 90, streak: 4 }, { name: 'Bo', username: null, score: 50, streak: 0 }]);
    assert.ok(log[0].url.includes('kind=hive'));
    await dailyTop('hive');
    assert.equal(log.length, 1);
    await dailyTop('hive', { force: true });
    assert.equal(log.length, 2);
    assert.equal(await dailyTop('nope'), null);
  } finally {
    resetAdmins();
  }
});

test('each player sends their own daily result once, and empty plays are not sent', async () => {
  resetDaily();
  const sent = [];
  configureDaily({ post: async (b) => { sent.push(b); return { score: 12, rank: 2, streak: 1 }; } });
  let heard = 0;
  onDaily(() => { heard += 1; });
  noteDaily('hive', DAY, { user: USER, words: ['kite'], ms: 500 });
  noteDaily('hive', DAY, { words: ['kite', 'kitchen'], ms: 900 });
  const res = await finishDaily('hive', DAY);
  assert.deepEqual(res, { score: 12, rank: 2, streak: 1 });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { date: DAY, kind: 'hive', user: { ...USER }, ms: 900, words: ['kite', 'kitchen'] });
  await finishDaily('hive', DAY);
  noteDaily('hive', DAY, { words: ['other'] });
  assert.equal(sent.length, 1);
  assert.deepEqual(dailyPlay('hive', DAY).words, ['kite', 'kitchen']);
  assert.ok(heard >= 2);
  const line = myLine(dailyPlay('hive', DAY));
  assert.equal(line.text, 'Your daily score: 12 points · #2 today');
  assert.match(line.streak, /1-day streak/);
  noteDaily('scramble', DAY, { user: USER, answers: ['', ''] });
  assert.equal(await finishDaily('scramble', DAY), null);
  assert.equal(dailyPlay('scramble', DAY).state, 'empty');
  assert.equal(sent.length, 1);
  configureDaily({ post: async () => null });
  noteDaily('scramble', '2023-11-15', { user: USER, answers: ['book'] });
  await finishDaily('scramble', '2023-11-15');
  assert.equal(myLine(dailyPlay('scramble', '2023-11-15')).tone, 'bad');
  assert.equal(streakText(0), '');
  assert.equal(streakText(4), '🔥 4-day streak!');
  resetDaily();
});

test("the daily box shows your result and today's best", async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  resetDaily();
  configureDaily({ top: async () => [{ name: 'Ada', username: 'ada', score: 90, streak: 3 }], post: async () => ({ score: 7, rank: 1, streak: 2 }) });
  const box = createDailyBox();
  box.show('hive', { date: DAY, intro: DAILY_INTRO });
  await flush();
  const text = box.el.textContent;
  assert.match(text, /Daily Letter Hive/);
  assert.match(text, /Today's best/);
  assert.match(text, /Ada/);
  assert.match(text, /🔥3/);
  noteDaily('hive', DAY, { user: USER, words: ['kite'] });
  await finishDaily('hive', DAY);
  await flush();
  assert.match(box.el.textContent, /Your daily score: 7 points · #1 today/);
  assert.match(box.el.textContent, /2-day streak/);
  box.show(null);
  assert.equal(box.el.textContent, '');
  box.destroy();
  const empty = dailyView({ kind: 'scramble', date: DAY, top: [], play: null });
  assert.match(empty.textContent, /Nobody has played today yet/);
  resetDaily();
});

test('the lobby knows when a game is in daily mode', () => {
  assert.equal(dailyOf(hive, { daily: true }), 'hive');
  assert.equal(dailyOf(hive, { daily: false }), null);
  assert.equal(dailyOf(scramble, { daily: true }), 'scramble');
  assert.equal(dailyOf({ settings: [] }, { daily: true }), null);
});

async function dailyRoom(game, n = 2) {
  const log = [];
  configureAdmins({ fetch: fakeFetch(log, [[DAILY_ENDPOINT, { body: puzzle() }]]), refreshMs: 0, win: null });
  const r = room(n, { games: [game] });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.setting('daily', true), true);
  await r.clock.advance(200);
  assert.equal(host.lobby.start().ok, true);
  return { r, host, log };
}

test('Letter Hive daily mode plays today’s letters for everyone with a fixed timer', async () => {
  const { r, host } = await dailyRoom(hive);
  try {
    for (let i = 0; i < 10 && host.snapshot().state[HIVE_KEY].phase !== 'play'; i += 1) {
      await flush(2);
      await r.clock.advance(600);
    }
    await r.clock.advance(400);
    const st = r.engines[1].snapshot().state[HIVE_KEY];
    assert.equal(st.phase, 'play');
    assert.equal(st.daily, DAY);
    assert.equal(st.l, 'cehiknt');
    assert.equal(st.c, 'k');
    assert.equal(st.ends - st.starts, DAILY_TIMER * 1000);
    assert.equal(st.total, hiveWords('cehiknt', 'k').length);
    const m = hive.model({ ...r.engines[1].snapshot() });
    assert.equal(m.daily, DAY);
    assert.match(hiveFoot({ ...m, playing: true }), /same for everyone/);
    host.lobby.end();
    await r.clock.advance(300);
    assert.equal(r.engines[1].snapshot().room.last.daily, DAY);
  } finally {
    resetAdmins();
  }
});

test('Letter Hive daily mode shows a friendly message when the puzzle cannot load', async () => {
  configureAdmins({ fetch: fakeFetch([], []), refreshMs: 0, win: null, importDaily: async () => null });
  const r = room(1, { games: [hive] });
  try {
    await r.clock.advance(500);
    const host = r.engines[0];
    host.lobby.setting('daily', true);
    await r.clock.advance(200);
    host.lobby.start();
    for (let i = 0; i < 10 && host.snapshot().state[HIVE_KEY].phase !== 'fail'; i += 1) {
      await flush(2);
      await r.clock.advance(600);
    }
    const st = host.snapshot().state[HIVE_KEY];
    assert.equal(st.phase, 'fail');
    assert.equal(st.why, 'daily');
    assert.match(hiveFoot({ phase: 'fail', why: 'daily' }), /Today's puzzle couldn't load/);
    host.lobby.end();
    await r.clock.advance(300);
    assert.equal(host.snapshot().room.last.daily, undefined);
  } finally {
    resetAdmins();
  }
});

test('Scramble daily mode deals today’s words and accepts any real word from the letters', async () => {
  assert.deepEqual(dailyDeck(puzzle()).map((d) => d.s), ['koob', 'kace']);
  assert.ok(Number.isInteger(dailyTarget('koob')));
  assert.equal(judgeDaily('book', 'koob', 'book'), 'right');
  assert.equal(judgeDaily('cake', 'kace', null), 'right');
  assert.equal(judgeDaily('ceak', 'kace', null), 'unknown');
  assert.equal(judgeDaily('boo', 'koob', 'book'), 'letters');
  assert.deepEqual(dailyAnswers(['book', undefined, 'cake'], 5), ['book', '', 'cake', '', '']);
  const { r, host } = await dailyRoom(scramble);
  try {
    for (let i = 0; i < 10 && host.snapshot().state[SCRAMBLE_KEY].phase !== 'play'; i += 1) {
      await flush(2);
      await r.clock.advance(600);
    }
    const st = host.snapshot().state[SCRAMBLE_KEY];
    assert.equal(st.phase, 'play');
    assert.equal(st.daily, DAY);
    assert.equal(st.s, 'koob');
    assert.equal(st.total, 2);
    r.engines[1].act({ type: 'guess', text: 'book', i: 0 });
    await r.clock.advance(400);
    const m = scramble.model(r.engines[1].snapshot());
    assert.equal(m.gotMe, true);
    assert.equal(m.daily, DAY);
    assert.match(scrambleFoot({ ...m, phase: 'play', gotMe: false, got: [], playing: true }), /same for everyone/);
    assert.equal(scrambleFoot({ phase: 'load' }), 'Getting today’s puzzle…');
  } finally {
    resetAdmins();
  }
});

test('dailyHive rebuilds the puzzle word list from the dictionary', () => {
  const pick = dailyHive(cleanDaily(puzzle()));
  assert.equal(pick.letters, 'cehiknt');
  assert.ok(pick.words.length > 0);
  assert.ok(pick.words.every((w) => w.includes('k')));
  assert.equal(dailyHive(null), null);
});
