import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, advance, USERS } from './helpers.js';
import { BLOCKED_PATTERN_MAX, BLOCKED_TTL, blockedIn, cleanBlockedPattern, clearBlockedCache } from '../worker/party-blocked.js';
import { shapeProblem, patternProblem, compilePattern, trialRun, windowSpans, PATTERN_CHARS, PATTERN_MAX, PATTERN_TEXT_MAX } from '../web/activity/js/patterns.js';
import { setCustomPatterns, setCustomTerms, customPatternCount, censor, findBlocked, isBlockedWord, isBlockedGameWord, validatePattern, testPattern, decodeTerm, encodeTerm, PATTERN_SAMPLES } from '../web/activity/js/filter.js';
import { cleanShared, hidesWords } from '../web/activity/js/text.js';
import { checkWord } from '../web/activity/js/games/chain.js';
import { modLogSentence, actionLabel } from '../web/js/pages/party-modlog.js';

const OWNER = USERS.alice;
const BOB = USERS.bob;
const ADMIN = { id: '66666666-6666-4666-8666-666666666666', username: 'mod', display_name: 'Mod Person', avatar_url: '' };
const PATH = '/api/party/blocked-patterns';
const WORDS = '/api/party/blocked-words';
const SKIBIDI = 'sk[i1]b+[i1]d[i1]';

async function setup() {
  const h = createHarness({ PARTY_OWNER_ID: OWNER.id });
  h.db.raw.prepare('INSERT INTO party_admins (id, added_by, added_at) VALUES (?, ?, ?)').run(ADMIN.id, OWNER.id, 1);
  const owner = (await h.login(OWNER)).cookie;
  const admin = (await h.login(ADMIN)).cookie;
  const bob = (await h.login(BOB)).cookie;
  return { h, owner, admin, bob };
}

async function call(h, method, path, cookie, body, extra) {
  const res = await h.api(method, path, cookie, body, extra);
  return { status: res.status, body: await res.json() };
}

const EVIL = [
  ['(a+)+', 'nested'], ['(a*)*', 'nested'], ['(a|a)*', 'alt_repeat'], ['(a|aa)+', 'alt_repeat'], ['(.*a){20}', 'nested'],
  ['^(([a-z])+.)+[A-Z]([a-z])+$', 'nested'], ['(\\w+\\s?)+$', 'nested'], ['\\w*\\w*\\w*', 'broad_repeat'], ['.*.*=.*', 'broad_repeat'],
  ['a{1,1000}', 'big_repeat'], ['a{60}', 'big_repeat'], ['a{51,}', 'big_repeat'], ['(x+x+)+y', 'overlap'], ['\\d+\\d+', 'broad_repeat'],
  ['a+a+b', 'overlap'], ['a+b?a+', 'overlap'], ['a+(?:a+)', 'overlap'], ['a+.a+', 'overlap'], ['[a-z]+[a-z]+', 'broad_repeat'],
  ['(?:a|b)+', 'alt_repeat'], ['(a)\\1', 'backref'], ['(?<n>a)\\k<n>', 'backref'], ['(?<=a)b', 'lookbehind'], ['(?<!a)b', 'lookbehind'],
  ['(a?){2}b', 'nested'], ['((ab)+)+c', 'nested'],
];

const GOOD = [SKIBIDI, 'bad\\s*word', '\\bhell\\b', 'bl[o0]+rg?', '(?:ph|f)ish', 'n[o0]{2,4}b', 'ass(?!ist)', '\\d{7,}', '(ab)+c', 'zz[a-z]+word', 'sk[i1]+b+[i1]+d+[i1]+', 'f[u\\*]ck', 'x(?<n>yz)', '.*badword'];

test('the shape checker refuses known catastrophic patterns and keeps ordinary ones', () => {
  for (const [src, code] of EVIL) {
    const p = patternProblem(src);
    assert.ok(p, src);
    assert.equal(p.code, code, src);
    assert.ok(validatePattern(src), src);
  }
  for (const src of GOOD) {
    assert.equal(shapeProblem(src), null, src);
    assert.equal(validatePattern(src), null, src);
  }
});

test('invalid, empty-matching and too long patterns are refused with plain words', () => {
  for (const src of ['(', '[', 'a{2,1}', '\\', '*a', '(?P<x>a)', ')']) assert.equal(patternProblem(src).code, 'bad_pattern', src);
  for (const src of ['', '   ', null, 5]) assert.equal(patternProblem(src).code, 'bad_pattern');
  for (const src of ['.*', 'a*', 'x?', '()', '\\b', '(?=a)', '^', 'a|']) assert.equal(patternProblem(src).code, 'matches_empty', src);
  assert.equal(patternProblem('x'.repeat(PATTERN_CHARS + 1)).code, 'too_long');
  assert.equal(patternProblem('qz'.repeat(PATTERN_CHARS / 2)), null);
  assert.match(patternProblem('(').message, /isn't a valid pattern/);
});

test('patterns that hit harmless text are refused and say which sample they hit', () => {
  for (const [src, sample] of [['\\w+', 'hello'], ['hell', 'hello'], ['[aeiou]', 'hello'], ['x', 'the quick brown fox jumps over the lazy dog'], ['\\d+', 'round 2'], ['g+', 'good game'], ['the', 'hi there'], ['god', 'good game'], ['.+', 'hello']]) {
    const p = validatePattern(src);
    assert.ok(p, src);
    assert.equal(p.code, 'too_broad', src);
    assert.ok(p.message.includes(`"${sample}"`), `${src}: ${p.message}`);
  }
  assert.ok(PATTERN_SAMPLES.length >= 20);
});

test('a slow trial run refuses the pattern', () => {
  let t = 0;
  const slow = () => {
    t += 1000;
    return t;
  };
  const p = validatePattern(SKIBIDI, { now: slow });
  assert.equal(p.code, 'too_slow');
  assert.equal(trialRun(compilePattern(SKIBIDI), SKIBIDI), true);
  const start = performance.now();
  const spans = [];
  windowSpans(compilePattern('zq+'), `${'a'.repeat(PATTERN_TEXT_MAX + 500)}zqq`, (a, b) => spans.push([a, b]));
  assert.deepEqual(spans, []);
  assert.ok(performance.now() - start < 50);
});

test('the activity filter hides pattern matches on raw and normalised text', () => {
  try {
    assert.equal(setCustomPatterns([SKIBIDI, '\\d{7,}', '(a+)+', 'nope(', '.*'], { encoded: false }), 2);
    assert.equal(customPatternCount(), 2);
    for (const t of ['say skibidi now', 'SK1BBBIDI toilet', 'skkkkibidi', 's.k.i.b.i.d.i', 's k i b i d i', 'sk1b1d1', 'skïbidi', 'ѕkibidi', 'call 5551234567']) {
      assert.equal(censor(t).changed, true, t);
      assert.ok(findBlocked(t).length > 0, t);
    }
    assert.equal(censor('I said skibidi ok').text, 'I said ■■■■■■■ ok');
    assert.equal(censor('s k i b i d i').text, '■'.repeat(13));
    for (const t of ['hello there', 'ski bindings', 'skid row', 'call me at 555', 'good game']) assert.equal(censor(t).changed, false, t);
    assert.equal(isBlockedWord('skibidi'), true);
    assert.equal(isBlockedWord('skiing'), false);
    assert.equal(isBlockedGameWord('sk1bidi'), true);
    assert.equal(cleanShared('my skibidi drawing'), 'my ■■■■■■■ drawing');
    assert.equal(hidesWords('skibidi'), true);
    assert.equal(checkWord('skibidi', 's', []), 'blocked');
  } finally {
    setCustomPatterns([]);
  }
  assert.equal(customPatternCount(), 0);
  assert.equal(censor('skibidi').changed, false);
});

test('encoded patterns decode, junk is skipped and the list is capped', () => {
  try {
    const many = Array.from({ length: PATTERN_MAX + 20 }, (_, i) => `zq${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}[x1]+w`);
    assert.equal(setCustomPatterns(many, { encoded: false }), PATTERN_MAX);
    assert.equal(setCustomPatterns([null, 7, {}, '', '(', SKIBIDI, SKIBIDI], { encoded: false }), 1);
    assert.equal(setCustomPatterns([encodeTerm(SKIBIDI)]), 1);
    assert.equal(censor('skibidi').changed, true);
  } finally {
    setCustomPatterns([]);
  }
});

test('a pattern that throws or runs slow is skipped without breaking the filter', () => {
  try {
    setCustomPatterns([SKIBIDI], { encoded: false });
    setCustomTerms(['banana'], { encoded: false });
    const realExec = RegExp.prototype.exec;
    let boom = 0;
    RegExp.prototype.exec = function exec(s) {
      if (this.source === SKIBIDI) {
        boom += 1;
        throw new Error('boom');
      }
      return realExec.call(this, s);
    };
    try {
      assert.equal(censor('banana skibidi').text, '■■■■■■ skibidi');
      assert.equal(censor('banana skibidi').text, '■■■■■■ skibidi');
    } finally {
      RegExp.prototype.exec = realExec;
    }
    assert.equal(boom, 1);
  } finally {
    setCustomPatterns([]);
    setCustomTerms([]);
  }
});

test('50 patterns stay cheap on spammy and very long text', () => {
  const spam = Array.from({ length: 100 }, (_, i) => String.fromCharCode(97 + ((i * 7) % 26))).join(' ');
  const flood = `${'a'.repeat(5000)}!`;
  const time = (text, runs) => {
    const start = performance.now();
    for (let r = 0; r < runs; r += 1) censor(text);
    return (performance.now() - start) / runs;
  };
  const base = time(spam, 10);
  const list = Array.from({ length: PATTERN_MAX }, (_, i) => `zq${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}[x1]+w`);
  list[0] = '.*badword';
  list[1] = 'zz[a-z]+word';
  list[2] = 'a+ba+';
  try {
    assert.equal(setCustomPatterns(list, { encoded: false }), PATTERN_MAX);
    const each = time(spam, 10);
    const long = time(flood, 3);
    assert.ok(each < 60, `censor with patterns took ${each.toFixed(1)} ms (without ${base.toFixed(1)} ms)`);
    assert.ok(long < 120, `censor on a 5000 character flood took ${long.toFixed(1)} ms`);
  } finally {
    setCustomPatterns([]);
  }
});

test('testPattern highlights what one pattern would hide', () => {
  assert.deepEqual(testPattern(SKIBIDI, 'yo SKIBIDI and s-k-i-b-i-d-i').map((s) => s.text), ['SKIBIDI', 's-k-i-b-i-d-i']);
  assert.deepEqual(testPattern('(', 'anything'), []);
  assert.deepEqual(testPattern(SKIBIDI, ''), []);
});

test('only the owner can add, change and remove patterns; party admins see them read-only', async () => {
  const { h, owner, admin, bob } = await setup();
  assert.equal((await call(h, 'GET', PATH, null)).status, 401);
  assert.equal((await call(h, 'GET', PATH, bob)).status, 403);
  assert.equal((await call(h, 'POST', PATH, bob, { pattern: SKIBIDI })).status, 403);
  const denied = await call(h, 'POST', PATH, admin, { pattern: SKIBIDI });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, 'owner_only');
  const csrf = await call(h, 'POST', PATH, owner, { pattern: SKIBIDI }, { Origin: 'https://evil.example' });
  assert.equal(csrf.status, 403);
  assert.equal(csrf.body.error, 'forbidden');
  const added = await call(h, 'POST', PATH, owner, { pattern: `  ${SKIBIDI}  ` });
  assert.equal(added.status, 201);
  assert.equal(added.body.patterns.length, 1);
  assert.equal(added.body.patterns[0].pattern, SKIBIDI);
  assert.equal(added.body.can_patterns, true);
  assert.equal(added.body.pattern_max, BLOCKED_PATTERN_MAX);
  const id = added.body.added_pattern;
  const seen = await call(h, 'GET', WORDS, admin);
  assert.equal(seen.status, 200);
  assert.equal(seen.body.can_patterns, false);
  assert.deepEqual(seen.body.patterns.map((p) => p.pattern), [SKIBIDI]);
  assert.equal((await call(h, 'GET', PATH, admin)).body.patterns.length, 1);
  assert.equal((await call(h, 'PATCH', `${PATH}/${id}`, admin, { pattern: 'zz[o0]+t' })).status, 403);
  assert.equal((await call(h, 'DELETE', `${PATH}/${id}`, admin)).status, 403);
  assert.equal((await call(h, 'DELETE', `${PATH}/${id}`, bob)).status, 403);
  const edited = await call(h, 'PATCH', `${PATH}/${id}`, owner, { pattern: 'zz[o0]+t' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.edited, true);
  assert.deepEqual(edited.body.patterns.map((p) => p.pattern), ['zz[o0]+t']);
  assert.equal((await call(h, 'PATCH', `${PATH}/nothere1234`, owner, { pattern: 'zz[o0]+q' })).status, 404);
  const gone = await call(h, 'DELETE', `${PATH}/${id}`, owner);
  assert.equal(gone.body.removed, true);
  assert.equal(gone.body.patterns.length, 0);
  assert.equal((await call(h, 'DELETE', `${PATH}/${id}`, owner)).body.removed, false);
  assert.equal((await call(h, 'PUT', PATH, owner, { pattern: SKIBIDI })).status, 405);
  const log = h.db.raw.prepare('SELECT actor_id, action, detail FROM party_mod_log ORDER BY created ASC, rowid ASC').all();
  assert.deepEqual(log.map((r) => r.action), ['owner_pattern_add', 'owner_pattern_edit', 'owner_pattern_remove']);
  assert.ok(log.every((r) => r.actor_id === OWNER.id));
  assert.deepEqual(JSON.parse(log[1].detail), { pattern: 'zz[o0]+t', before: SKIBIDI });
});

test('the server refuses bad, risky, broad, repeated and too many patterns', async () => {
  const { h, owner } = await setup();
  for (const [pattern, code] of [['(a+)+', 'nested'], ['(', 'bad_pattern'], ['.*', 'matches_empty'], ['\\w+', 'too_broad'], ['(a)\\1', 'backref'], ['x'.repeat(121), 'too_long'], ['a\nb', 'bad_pattern'], [7, 'bad_pattern']]) {
    const res = await call(h, 'POST', PATH, owner, { pattern });
    assert.equal(res.status, 400, String(pattern));
    assert.equal(res.body.error, code, String(pattern));
  }
  assert.equal((await call(h, 'POST', PATH, owner, { pattern: SKIBIDI, extra: 1 })).status, 400);
  assert.equal((await call(h, 'POST', PATH, owner, { pattern: SKIBIDI })).status, 201);
  const dupe = await call(h, 'POST', PATH, owner, { pattern: SKIBIDI });
  assert.equal(dupe.status, 409);
  assert.equal(dupe.body.error, 'exists');
  const stmt = h.db.raw.prepare('INSERT INTO party_blocked_patterns (id, pattern, added_by, added_name, created) VALUES (?, ?, ?, ?, ?)');
  for (let i = 1; i < BLOCKED_PATTERN_MAX; i += 1) stmt.run(`seedpat${i}`, `qz${i}x`, OWNER.id, 'Alice', i);
  const full = await call(h, 'POST', PATH, owner, { pattern: 'zz[o0]+t' });
  assert.equal(full.status, 409);
  assert.equal(full.body.error, 'too_many');
  assert.throws(() => cleanBlockedPattern('(a*)*'), /repeats inside it/);
  assert.equal(cleanBlockedPattern(' zz[o0]+t '), 'zz[o0]+t');
});

test('the public list carries encoded patterns with a new version, and the activity applies them', async () => {
  const { h, owner } = await setup();
  await call(h, 'POST', WORDS, owner, { word: 'banana' });
  const before = await (await h.request('GET', '/api/activity/blocked')).json();
  assert.deepEqual(before.p, []);
  await call(h, 'POST', PATH, owner, { pattern: SKIBIDI });
  const after = await (await h.request('GET', '/api/activity/blocked')).json();
  assert.notEqual(after.v, before.v);
  assert.equal(after.p.length, 1);
  assert.doesNotMatch(JSON.stringify(after), /sk\[i1\]b/);
  assert.equal(decodeTerm(after.p[0]), SKIBIDI);
  h.db.raw.prepare("INSERT INTO party_blocked_patterns (id, pattern, added_by, added_name, created) VALUES ('sneakypat', 'zz[o0]+t', ?, 'x', 99)").run(OWNER.id);
  assert.equal((await (await h.request('GET', '/api/activity/blocked')).json()).p.length, 1);
  advance(h, BLOCKED_TTL + 1);
  const later = await (await h.request('GET', '/api/activity/blocked')).json();
  assert.equal(later.p.length, 2);
  try {
    setCustomPatterns(later.p);
    assert.equal(censor('omg sk1bidi').changed, true);
    assert.equal(censor('zzooot').changed, true);
  } finally {
    setCustomPatterns([]);
  }
});

test('server-side checks with blockedIn use patterns too, and a missing table never breaks it', async () => {
  const { h, owner } = await setup();
  assert.deepEqual(await blockedIn(h.db, ['hi skibidi', 'hello'], h.clock.t), [false, false]);
  await call(h, 'POST', PATH, owner, { pattern: SKIBIDI });
  assert.deepEqual(await blockedIn(h.db, ['hi skibidi', 'hello', 's k i b i d i'], h.clock.t), [true, false, true]);
  assert.equal(censor('skibidi').changed, false);
  assert.equal(customPatternCount(), 0);
  h.db.raw.exec('DROP TABLE party_blocked_patterns');
  clearBlockedCache(h.db);
  assert.deepEqual(await blockedIn(h.db, ['hi skibidi'], h.clock.t), [false]);
  const pub = await h.request('GET', '/api/activity/blocked');
  assert.equal(pub.status, 200);
  assert.deepEqual((await pub.json()).p, []);
  assert.equal((await call(h, 'GET', WORDS, owner)).status, 200);
});

test('pattern changes read as sentences in the mod log', () => {
  const e = (action, detail) => ({ action, actor: { name: 'Jolli', system: false }, target: null, detail });
  assert.equal(modLogSentence(e('owner_pattern_add', { pattern: SKIBIDI })), `Jolli blocked the pattern “${SKIBIDI}”`);
  assert.equal(modLogSentence(e('owner_pattern_edit', { pattern: 'b', before: 'a' })), 'Jolli changed the pattern “a” to “b”');
  assert.equal(modLogSentence(e('owner_pattern_remove', { pattern: SKIBIDI })), `Jolli unblocked the pattern “${SKIBIDI}”`);
  assert.equal(modLogSentence(e('owner_pattern_add', {})), 'Jolli blocked a pattern');
  assert.equal(actionLabel('owner_pattern_add'), 'Owner: blocked patterns added');
});

test('the activity loader applies patterns from the public list and clears them on reset', async () => {
  const { configureBlocked, loadBlocked, resetBlocked, blockedPatternCount } = await import('../web/activity/js/blocked.js');
  let body = { v: 'p1', n: 0, t: [], p: [encodeTerm(SKIBIDI)] };
  configureBlocked({ fetch: async () => ({ ok: true, json: async () => body }) });
  try {
    assert.equal(await loadBlocked(), true);
    assert.equal(blockedPatternCount(), 1);
    assert.equal(censor('skibidi').changed, true);
    body = { v: 'p2', n: 0, t: [] };
    assert.equal(await loadBlocked(), true);
    assert.equal(blockedPatternCount(), 0);
  } finally {
    resetBlocked();
  }
  assert.equal(censor('skibidi').changed, false);
});

test('letters that only match each other under case folding count as the same letter', () => {
  for (const src of ['ſ+s+x', 's+ſ+x', 'σ+ς+x', 'µ+μ+x', 'K+k+x', '[ſt]+s+x', 'ẞ+ß+x']) assert.equal(shapeProblem(src)?.code, 'overlap', src);
  assert.equal(shapeProblem('ſ+t+x'), null);
  for (const text of ['s'.repeat(2000), 'sſ'.repeat(1000), 'σς'.repeat(1000)]) {
    const start = performance.now();
    windowSpans(compilePattern('zs+q'), text, () => {});
    assert.ok(performance.now() - start < 50);
  }
});

test('patterns that hide whole scripts or every emoji are refused', () => {
  for (const src of ['[^\\x00-\\x7f]', '\\p{Extended_Pictographic}', '[\\u0400-\\u04ff]', '\\p{Script=Cyrillic}', '\\p{Script=Han}', '[\\u3040-\\u30ff]', '\\p{Script=Arabic}', '[é]']) {
    assert.equal(validatePattern(src)?.code, 'too_broad', src);
  }
});

test('window edges do not fake a word boundary or the start of the text', () => {
  const spans = (src, text) => {
    const out = [];
    windowSpans(compilePattern(src), text, (a, b) => out.push([a, b]));
    return out;
  };
  for (const cut of [190, 191, 192, 193, 384, 385]) {
    const text = `${'x '.repeat(Math.floor((cut - 2) / 2))}${cut % 2 ? 'y' : ''}grass and more words here`.padEnd(900, ' y');
    assert.deepEqual(spans('\\bass\\b', text), [], String(cut));
    assert.deepEqual(spans('^ass', text), [], String(cut));
  }
  const text = `${'y '.repeat(400)}ass y y`;
  assert.deepEqual(spans('\\bass\\b', text), [[800, 803]]);
  const long = `${'y '.repeat(150)}${'skibidi '.repeat(20)}`;
  const found = spans(SKIBIDI, long);
  assert.equal(new Set(found.map(([a]) => a)).size, 20);
});
