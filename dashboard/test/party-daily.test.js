import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness, advance, USERS } from './helpers.js';
import { dailyPuzzle, dailyScrambleWords, hiveAnswers, scoreHive, scoreScramble, hivePoints, checkAnswer, answerHash, isDateKey, shiftDay, dayKey, seededRandom } from '../web/activity/js/daily.js';
import { SEEDS } from '../web/activity/data/hive.js';
import { WORDS as SCRAMBLE } from '../web/activity/data/scramble.js';
import { isBlockedGameWord, decodeTerm } from '../web/activity/js/filter.js';
import { resetDailyCache, nextStreak } from '../worker/party-daily.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORDS_TXT = readFileSync(path.join(here, '..', 'web', 'activity', 'data', 'words.txt'), 'utf8');
const uid = (i) => `66666666-6666-4666-8666-${String(i).padStart(12, '0')}`;
const TODAY = '2026-11-12';
const DAY = 24 * 60 * 60 * 1000;

function daily({ words = WORDS_TXT } = {}) {
  resetDailyCache();
  const assets = {
    requests: [],
    async fetch(request) {
      const u = new URL(request.url);
      this.requests.push(u.pathname);
      if (u.pathname === '/activity/data/words.txt' && words !== null) return new Response(words, { status: 200 });
      return new Response('missing', { status: 404 });
    },
  };
  return createHarness({ PARTY_OWNER_ID: USERS.alice.id, ASSETS: assets });
}

function submit(h, body, { ip = '198.51.100.30', origin } = {}) {
  const headers = { Origin: origin === undefined ? h.base : origin };
  if (headers.Origin === null) delete headers.Origin;
  return h.request('POST', '/api/activity/daily', { headers, body, ip });
}

const user = (i, name = `Player ${i}`) => ({ id: uid(i), name, username: `p${i}` });

test('the daily puzzle is the same for everyone on a day and changes the next day', () => {
  const a = dailyPuzzle(TODAY);
  const b = dailyPuzzle(TODAY);
  assert.deepEqual(a, b);
  assert.notDeepEqual(dailyPuzzle(shiftDay(TODAY, 1)), a);
  assert.equal(a.date, TODAY);
  assert.equal(a.hive.letters.length, 7);
  assert.equal(new Set(a.hive.letters).size, 7);
  assert.ok(a.hive.letters.includes(a.hive.centre));
  assert.equal(a.scramble.rounds.length, 5);
  const words = dailyScrambleWords(TODAY);
  assert.equal(words.length, 5);
  assert.equal(new Set(words).size, 5);
  a.scramble.rounds.forEach((r, i) => {
    assert.equal(r.length, words[i].length);
    assert.notEqual(r.letters, words[i]);
    assert.equal([...r.letters].sort().join(''), [...words[i]].sort().join(''));
    assert.ok(checkAnswer(TODAY, i, words[i].toUpperCase(), r.answerHash));
    assert.ok(!checkAnswer(TODAY, i, 'nope', r.answerHash));
    assert.equal(JSON.stringify(r).includes(`"${words[i]}"`), false);
  });
  assert.throws(() => dailyPuzzle('2026-13-01'));
});

test('a month of puzzles always has a pangram, enough hive words and clean scramble words', () => {
  let day = '2026-11-01';
  for (let i = 0; i < 31; i += 1) {
    const p = dailyPuzzle(day);
    const answers = hiveAnswers(p);
    assert.ok(answers.length >= 20, `${day} has ${answers.length} words`);
    assert.ok(answers.some((w) => new Set(w).size === 7), `${day} has a pangram`);
    for (const w of answers) assert.ok(w.includes(p.hive.centre));
    for (const w of dailyScrambleWords(day)) assert.equal(isBlockedGameWord(w), false);
    day = shiftDay(day, 1);
  }
  const custom = dailyPuzzle(TODAY, { hiveSeeds: SEEDS.slice(0, 3), scrambleWords: SCRAMBLE.slice(0, 20) });
  assert.equal(custom.scramble.rounds.length, 5);
});

test('scoring matches the games', () => {
  const p = dailyPuzzle(TODAY);
  const answers = hiveAnswers(p);
  const pangram = answers.find((w) => new Set(w).size === 7);
  const four = answers.find((w) => w.length === 4);
  const r = scoreHive([pangram, pangram.toUpperCase(), four, 'zzzz', 42], p);
  assert.equal(r.found, four ? 2 : 1);
  assert.equal(r.score, hivePoints(pangram, p.hive.letters) + (four ? 1 : 0));
  assert.equal(hivePoints(pangram, p.hive.letters), pangram.length + 7);
  assert.equal(r.pangrams, 1);
  const words = dailyScrambleWords(TODAY);
  assert.deepEqual(scoreScramble([words[0], 'wrong', words[2].toUpperCase()], p).right, [true, false, true, false, false]);
  assert.equal(scoreScramble(words, p).score, 500);
  assert.ok(isDateKey(TODAY));
  assert.ok(!isDateKey('2026-02-30'));
  assert.equal(dayKey(Date.UTC(2026, 10, 12, 23, 59)), TODAY);
  assert.equal(answerHash(TODAY, 0, 'abc'), answerHash(TODAY, 0, 'ABC'));
  const r1 = seededRandom('x');
  const r2 = seededRandom('x');
  assert.equal(r1(), r2());
});

test('streaks count consecutive UTC days', () => {
  assert.deepEqual(nextStreak(null, TODAY), { streak: 1, best: 1, changed: true });
  assert.deepEqual(nextStreak({ last_day: shiftDay(TODAY, -1), streak: 4, best: 4 }, TODAY), { streak: 5, best: 5, changed: true });
  assert.deepEqual(nextStreak({ last_day: TODAY, streak: 5, best: 9 }, TODAY), { streak: 5, best: 9, changed: false });
  assert.deepEqual(nextStreak({ last_day: shiftDay(TODAY, -3), streak: 5, best: 9 }, TODAY), { streak: 1, best: 9, changed: true });
});

test('GET shows today without answers and loads the dictionary once', async () => {
  const h = daily();
  const res = await h.request('GET', '/api/activity/daily');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.date, TODAY);
  assert.equal(body.hive.letters.length, 7);
  assert.ok(body.hive.total >= 20);
  assert.ok(body.hive.max > body.hive.total);
  assert.equal(body.scramble.rounds.length, 5);
  assert.equal(body.resetsAt, Date.UTC(2026, 10, 13));
  const text = JSON.stringify(body);
  for (const w of dailyScrambleWords(TODAY)) assert.equal(text.includes(`"${w}"`), false);
  await h.request('GET', '/api/activity/daily');
  assert.equal(h.env.ASSETS.requests.filter((p) => p.endsWith('words.txt')).length, 1);
});

test('submissions are re-checked, scored, ranked and the best one is kept', async () => {
  const h = daily();
  const p = dailyPuzzle(TODAY);
  const answers = hiveAnswers(p);
  const words = dailyScrambleWords(TODAY);
  const first = await submit(h, { date: TODAY, kind: 'hive', user: user(1), words: [...answers.slice(0, 5), 'qqqq', 'notaword'], ms: 60000 });
  assert.equal(first.status, 200);
  const a = await first.json();
  assert.equal(a.found, 5);
  assert.equal(a.score, scoreHive(answers.slice(0, 5), p).score);
  assert.equal(a.rank, 1);
  assert.equal(a.streak, 1);
  assert.equal(a.improved, true);
  const second = await (await submit(h, { date: TODAY, kind: 'hive', user: user(2), words: answers, ms: 90000 }, { ip: '198.51.100.31' })).json();
  assert.equal(second.rank, 1);
  const worse = await (await submit(h, { date: TODAY, kind: 'hive', user: user(1), words: answers.slice(0, 1), ms: 1000 })).json();
  assert.equal(worse.improved, false);
  assert.equal(worse.best, a.score);
  assert.equal(worse.rank, 2);
  assert.equal(worse.streak, 1);
  const sc = await (await submit(h, { date: TODAY, kind: 'scramble', user: user(1), answers: [words[0], words[1], 'x'], ms: 20000 })).json();
  assert.equal(sc.score, 200);
  assert.equal(sc.correct, 2);
  assert.deepEqual(sc.right, [true, true, false, false, false]);
  const top = await (await h.request('GET', '/api/activity/daily/top?kind=hive')).json();
  assert.equal(top.date, TODAY);
  assert.deepEqual(top.top.map((r) => r.id), [uid(2), uid(1)]);
  assert.deepEqual(Object.keys(top.top[0]).sort(), ['id', 'ms', 'name', 'rank', 'score', 'streak', 'username']);
  assert.equal(top.top[1].score, a.score);
  assert.equal(top.top[1].streak, 1);
  const st = await (await h.request('GET', '/api/activity/daily/top?kind=scramble')).json();
  assert.equal(st.top.length, 1);
  assert.equal((await h.request('GET', '/api/activity/daily/top?kind=chess')).status, 400);
});

test('ties are broken by the faster time', async () => {
  const h = daily();
  const words = dailyScrambleWords(TODAY);
  await submit(h, { date: TODAY, kind: 'scramble', user: user(1), answers: words, ms: 50000 });
  const fast = await (await submit(h, { date: TODAY, kind: 'scramble', user: user(2), answers: words, ms: 30000 }, { ip: '198.51.100.32' })).json();
  assert.equal(fast.rank, 1);
  const top = await (await h.request('GET', '/api/activity/daily/top?kind=scramble')).json();
  assert.deepEqual(top.top.map((r) => r.id), [uid(2), uid(1)]);
});

test('playing on the next day grows the streak and old puzzles are closed', async () => {
  const h = daily();
  await submit(h, { date: TODAY, kind: 'hive', user: user(1), words: [], ms: 1000 });
  advance(h, DAY);
  const tomorrow = shiftDay(TODAY, 1);
  const old = await submit(h, { date: TODAY, kind: 'hive', user: user(1), words: [], ms: 1000 });
  assert.equal(old.status, 409);
  assert.equal((await old.json()).date, tomorrow);
  const next = await (await submit(h, { date: tomorrow, kind: 'scramble', user: user(1), answers: [], ms: 1000 })).json();
  assert.equal(next.streak, 2);
  advance(h, 3 * DAY);
  const reset = await (await submit(h, { date: shiftDay(TODAY, 4), kind: 'hive', user: user(1), words: [], ms: 1000 })).json();
  assert.equal(reset.streak, 1);
  assert.equal(reset.bestStreak, 2);
});

test('bad submissions, other origins, bans and floods are refused', async () => {
  const h = daily();
  const base = { date: TODAY, kind: 'hive', user: user(1), words: [], ms: 1000 };
  const cases = [
    [{ date: 'today' }, 'bad_date'],
    [{ kind: 'chess' }, 'bad_kind'],
    [{ user: { id: 'no spaces!', name: 'x' } }, 'bad_id'],
    [{ user: null }, 'bad_person'],
    [{ ms: -1 }, 'bad_time'],
    [{ ms: '5' }, 'bad_time'],
    [{ words: 'abc' }, 'bad_list'],
    [{ words: Array(201).fill('abcd') }, 'bad_list'],
    [{ words: ['a'.repeat(40)] }, 'bad_list'],
    [{ kind: 'scramble', answers: Array(6).fill('a') }, 'bad_list'],
  ];
  let ip = 50;
  for (const [over, code] of cases) {
    const res = await submit(h, { ...base, ...over }, { ip: `198.51.100.${ip++}` });
    assert.equal(res.status, 400, code);
    assert.equal((await res.json()).error, code);
  }
  assert.equal((await submit(h, base, { origin: null })).status, 403);
  h.db.raw.prepare("INSERT INTO party_bans (id, name, username, reason, banned_by, banned_at) VALUES (?, NULL, NULL, NULL, ?, 1)").run(uid(9), USERS.alice.id);
  const banned = await submit(h, { ...base, user: user(9) }, { ip: '198.51.100.99' });
  assert.equal(banned.status, 403);
  let last;
  for (let i = 0; i < 21; i += 1) last = await submit(h, base, { ip: '198.51.100.120' });
  assert.equal(last.status, 429);
});

test('the dictionary is used when it loads and the curated list is the fallback', async () => {
  const p = dailyPuzzle(TODAY);
  const answers = hiveAnswers(p);
  const keep = answers.slice(1);
  const h = daily({ words: keep.join('\n') });
  const body = await (await h.request('GET', '/api/activity/daily')).json();
  assert.equal(body.hive.total, keep.length);
  const r = await (await submit(h, { date: TODAY, kind: 'hive', user: user(1), words: [answers[0], answers[1]], ms: 1000 })).json();
  assert.equal(r.found, 1);
  const h2 = daily({ words: null });
  const body2 = await (await h2.request('GET', '/api/activity/daily')).json();
  assert.equal(body2.hive.total, answers.length);
});

test('cleanup keeps a week of daily scores and every streak', async () => {
  const h = daily();
  await submit(h, { date: TODAY, kind: 'hive', user: user(1), words: [], ms: 1000 });
  advance(h, 9 * DAY);
  await h.worker.scheduled({}, h.env, { waitUntil() {} });
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_daily_scores').get().n, 0);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_daily_streaks').get().n, 1);
});

test('slurs in daily names are hidden and a slower or lower run never replaces a better one', async () => {
  const h = daily();
  const slur = decodeTerm('yogqkz');
  const words = dailyScrambleWords(TODAY);
  await submit(h, { date: TODAY, kind: 'scramble', user: { id: uid(9), name: `${slur} fan`, username: slur }, answers: words, ms: 30000 });
  await Promise.all([
    submit(h, { date: TODAY, kind: 'scramble', user: user(9), answers: words.slice(0, 1), ms: 1000 }, { ip: '198.51.100.33' }),
    submit(h, { date: TODAY, kind: 'scramble', user: user(9), answers: words, ms: 90000 }, { ip: '198.51.100.34' }),
  ]);
  const row = h.db.raw.prepare('SELECT * FROM party_daily_scores WHERE user_id = ? AND kind = ?').get(uid(9), 'scramble');
  assert.equal(row.score, words.length * 100);
  assert.equal(row.ms, 30000);
  const fresh = daily();
  await submit(fresh, { date: TODAY, kind: 'scramble', user: { id: uid(8), name: `${slur} fan`, username: slur }, answers: words, ms: 30000 });
  const top = await (await fresh.request('GET', '/api/activity/daily/top?kind=scramble')).json();
  assert.ok(!top.top[0].name.toLowerCase().includes(slur));
  assert.equal(top.top[0].username, null);
});
