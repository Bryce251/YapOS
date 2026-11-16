import test from 'node:test';
import assert from 'node:assert/strict';
import { room, person } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import { checkProfileFaces } from './talk-faces.js';
import { configureAdmins, resetAdmins, refreshAdmins } from '../web/activity/js/admin.js';
import hottakes, { KEY, ANSWER_PREFIX, ANSWER_MAX, RECAP_MS, VOTE_MS, VOTE_POINTS, TOP_BONUS, LATE_MIN_MS, seal, unseal, tally, chunk, revealMs, promptParts, buildDeck } from '../web/activity/js/games/hottakes.js';
import { createHottakesView, footText, hottakesMoment } from '../web/activity/js/views/hottakes.js';
import { cueKit } from '../web/activity/js/views/index.js';
import { PROMPTS, BLANK } from '../web/activity/data/hottakes.js';
import { jsonBytes, MAX_VALUE_BYTES, stateBytes, MAX_STATE_BYTES } from '../web/activity/js/limits.js';

const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function st(r) {
  return r.hub.state[KEY];
}

async function startGame(n = 3, settings = {}, opts = {}) {
  const r = room(n, { games: [hottakes], ...opts });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('hottakes'), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  return r;
}

function answer(e, text) {
  const s = e.snapshot().state[KEY];
  return e.act({ type: 'answer', n: s.n, code: seal(text, s.nonce) });
}

function cards(r) {
  const s = st(r);
  const out = [];
  for (let i = 0; i < s.chunks; i += 1) for (const row of r.hub.state[`${ANSWER_PREFIX}${i}`] || []) out.push({ id: row[0], text: row[1] });
  return out;
}

function textOf(slot, round) {
  return `answer ${round} from ${slot}`;
}

async function writeAll(r, round, slots) {
  for (const slot of slots) answer(bySlot(r, slot), textOf(slot, round));
  await r.clock.advance(500);
}

function slotsOf(r) {
  return r.engines.map((e) => e.snapshot().meSlot);
}

test('the content is original fill-in prompts with one blank each', () => {
  assert.ok(PROMPTS.length >= 150, `${PROMPTS.length} prompts`);
  assert.equal(new Set(PROMPTS.map((p) => p.t)).size, PROMPTS.length);
  assert.equal(new Set(PROMPTS.map((p) => p.id)).size, PROMPTS.length);
  for (const p of PROMPTS) {
    assert.equal(p.t.split(BLANK).length, 2, p.t);
    for (const re of BANNED) assert.doesNotMatch(p.t, re);
  }
  assert.deepEqual(promptParts('Hello ____ world'), { before: 'Hello ', after: ' world' });
  assert.equal(buildDeck(5, () => 0.3).length, 5);
});

test('the game is a party game for 3 or more with rounds and time settings', () => {
  assert.equal(hottakes.id, 'hottakes');
  assert.equal(hottakes.category, 'party');
  assert.equal(hottakes.minPlayers, 3);
  assert.equal(hottakes.emoji, '🌶️');
  const rounds = hottakes.settings.find((s) => s.id === 'rounds');
  assert.deepEqual(rounds.options.map((o) => o.value), [3, 4, 5, 7]);
  assert.equal(rounds.default, 4);
  const timer = hottakes.settings.find((s) => s.id === 'timer');
  assert.ok(timer.options.some((o) => o.value === 90));
  assert.equal(timer.default, 45);
  const recap = hottakes.settings.find((s) => s.id === 'recap');
  assert.equal(recap.type, 'toggle');
  assert.equal(recap.default, true);
  for (const re of BANNED) assert.doesNotMatch(`${hottakes.name} ${hottakes.blurb}`, re);
});

test('sealed answers round trip, including emoji, and junk opens to nothing', () => {
  for (const text of ['a cat 🐱 in a hat', 'Ünïcode “quotes”', 'x'.repeat(80)]) {
    const code = seal(text, 4321);
    assert.notEqual(code, text);
    assert.equal(code.includes('cat'), false);
    assert.equal(unseal(code, 4321), text);
    assert.notEqual(unseal(code, 4322), text);
  }
  assert.equal(unseal('zzzzz', 1), '');
  assert.equal(unseal(42, 1), '');
  assert.equal(unseal('x'.repeat(3000), 1), '');
});

test('tally gives points per vote and a bonus to every top answer', () => {
  const t = tally({ 0: 1, 1: 2, 2: 3 }, { 1: 1, 2: 1, 3: 0, 4: 2, 5: 2 });
  assert.deepEqual(t.top.sort(), [1, 2]);
  assert.equal(t.gained[2], 2 * VOTE_POINTS + TOP_BONUS);
  assert.equal(t.gained[3], 2 * VOTE_POINTS + TOP_BONUS);
  assert.equal(t.gained[1], VOTE_POINTS);
  const none = tally({ 0: 1 }, {});
  assert.deepEqual(none.top, []);
  assert.deepEqual(none.gained, {});
  const parts = chunk(Array.from({ length: 30 }, (_, i) => [i, '🌶️'.repeat(80)]));
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(jsonBytes(p) <= MAX_VALUE_BYTES);
  assert.ok(revealMs(40) <= 16000);
});

test('a full game with 3 players: write, vote, reveal, score and finish', async () => {
  const r = await startGame(3, { rounds: 3 });
  const slots = slotsOf(r);
  const totals = {};
  for (let round = 1; round <= 3; round += 1) {
    let s = st(r);
    assert.equal(s.phase, 'write');
    assert.equal(s.i, round - 1);
    await writeAll(r, round, slots);
    s = st(r);
    assert.equal(s.phase, 'vote', 'moves on once everyone answered');
    const list = cards(r);
    assert.equal(list.length, 3);
    const own = list.find((c) => c.text === textOf(slots[0], round));
    bySlot(r, slots[0]).act({ type: 'vote', n: s.n, id: own.id });
    await r.clock.advance(300);
    assert.equal(st(r).voted.length, 0, 'cannot vote for your own');
    const target = list.find((c) => c.text === textOf(slots[2], round));
    for (const slot of slots) {
      const pick = slot === slots[2] ? list.find((c) => c.text === textOf(slots[1], round)) : target;
      bySlot(r, slot).act({ type: 'vote', n: s.n, id: pick.id });
    }
    await r.clock.advance(500);
    s = st(r);
    assert.equal(s.phase, 'reveal');
    const top = s.res[0];
    assert.equal(top[1], slots[2]);
    assert.equal(top[2], 2);
    assert.deepEqual(s.top, [top[0]]);
    const mult = round === 3 ? 2 : 1;
    assert.equal(s.gained[slots[2]], (2 * VOTE_POINTS + TOP_BONUS) * mult, 'the final round counts double');
    assert.equal(s.gained[slots[1]], VOTE_POINTS * mult);
    assert.equal(s.gained[slots[0]], undefined);
    for (const [slot, pts] of Object.entries(s.gained)) totals[slot] = (totals[slot] || 0) + pts;
    assert.deepEqual(r.engines[1].snapshot().scores.g, totals);
    await r.clock.advance(revealMs(s.count) + 300);
  }
  assert.equal(st(r).phase, 'recap');
  const recap = hottakes.model(r.engines[1].snapshot());
  assert.equal(recap.rounds.length, 3);
  for (const row of recap.rounds) {
    assert.match(row.text, new RegExp(`^answer [0-9] from ${slots[2]}$`));
    assert.equal(row.votes, 2);
    assert.equal(row.voters.length, 2);
  }
  await r.clock.advance(RECAP_MS + 300);
  const roomState = r.engines[0].snapshot().room;
  assert.equal(roomState.phase, 'results');
  assert.deepEqual(roomState.last.winners, [slots[2]]);
  assert.equal(Object.keys(r.hub.state).some((k) => k.startsWith(ANSWER_PREFIX)), false, 'answers are cleaned up');
  assert.deepEqual(r.hub.violations, []);
});

test('the clock moves things along: missing answers still vote, no votes means no points', async () => {
  const r = await startGame(3, { rounds: 3, timer: 45 });
  const slots = slotsOf(r);
  answer(bySlot(r, slots[0]), '   ');
  await r.clock.advance(300);
  assert.equal(st(r).done.length, 0, 'empty answers are ignored');
  answer(bySlot(r, slots[0]), 'only me');
  answer(bySlot(r, slots[1]), 'me too');
  await r.clock.advance(300);
  answer(bySlot(r, slots[0]), 'second try');
  await r.clock.advance(300);
  let s = st(r);
  assert.deepEqual(s.done.sort(), [slots[0], slots[1]].sort());
  assert.equal(s.phase, 'write');
  await r.clock.advance(45000);
  s = st(r);
  assert.equal(s.phase, 'vote');
  const list = cards(r);
  assert.deepEqual(list.map((c) => c.text).sort(), ['me too', 'only me']);
  bySlot(r, slots[2]).act({ type: 'vote', n: s.n, id: list.find((c) => c.text === 'only me').id });
  await r.clock.advance(300);
  assert.equal(st(r).voted.length, 1, 'someone who did not answer can still vote');
  await r.clock.advance(VOTE_MS);
  s = st(r);
  assert.equal(s.phase, 'reveal');
  assert.equal(s.gained[slots[0]], VOTE_POINTS + TOP_BONUS);
  await r.clock.advance(revealMs(s.count) + 200);
  s = st(r);
  assert.equal(s.phase, 'write');
  assert.equal(s.i, 1);
  await r.clock.advance(45000 + 200);
  s = st(r);
  assert.equal(s.phase, 'reveal', 'nobody answered, so it goes straight to the results');
  assert.deepEqual(s.res, []);
  await r.clock.advance(revealMs(0) + 200);
  s = st(r);
  assert.equal(s.i, 2);
  await writeAll(r, 3, slots);
  await r.clock.advance(VOTE_MS + 200);
  s = st(r);
  assert.equal(s.phase, 'reveal');
  assert.deepEqual(s.top, []);
  assert.deepEqual(s.gained, {});
  assert.deepEqual(r.hub.violations, []);
});

test('late joiners write if there is time, otherwise wait, and can always vote', async () => {
  const r = await startGame(3, { rounds: 3, timer: 45 });
  const early = r.add(4);
  await r.clock.advance(500);
  early.join();
  await r.clock.advance(800);
  const earlySlot = early.snapshot().meSlot;
  assert.ok(Number.isInteger(earlySlot));
  assert.ok(st(r).in.includes(earlySlot), 'joined early enough to write');
  await r.clock.advance(45000 - 1300 - LATE_MIN_MS + 2000);
  const late = r.add(5);
  await r.clock.advance(500);
  late.join();
  await r.clock.advance(800);
  const lateSlot = late.snapshot().meSlot;
  let s = st(r);
  assert.ok(s.wait.includes(lateSlot));
  assert.equal(s.in.includes(lateSlot), false);
  const model = hottakes.model(late.snapshot(), {});
  assert.equal(model.canWrite, false);
  assert.equal(model.waiting, true);
  answer(late, 'sneaky');
  const slots = [0, 1, 2].map((i) => r.engines[i].snapshot().meSlot);
  await writeAll(r, 1, slots.concat([earlySlot]));
  s = st(r);
  assert.equal(s.phase, 'vote', 'the waiting player does not hold things up');
  assert.equal(cards(r).some((c) => c.text === 'sneaky'), false);
  const list = cards(r);
  late.act({ type: 'vote', n: s.n, id: list[0].id });
  await r.clock.advance(400);
  assert.ok(st(r).voted.includes(lateSlot));
  assert.ok(hottakes.model(late.snapshot(), {}).hasVoted);
  assert.deepEqual(r.hub.violations, []);
});

const OWNER = person(2).id;

function fakeFetch() {
  return async (url) => {
    const ids = new URL(url, 'https://yapos.dev').searchParams.get('ids').split(',');
    return { ok: true, status: 200, json: async () => ({ admins: ids.filter((id) => id === OWNER), owner: ids.includes(OWNER) ? OWNER : null }) };
  };
}

async function settle(clock, ms = 600) {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((res) => setImmediate(res));
    await clock.advance(ms / 6);
  }
}

test('admins can skip each phase and add or take time', async () => {
  resetAdmins();
  configureAdmins({ fetch: fakeFetch(), refreshMs: 0, win: null });
  const r = room(3, { games: [hottakes] });
  await r.clock.advance(500);
  await refreshAdmins(r.engines.map((e) => e.snapshot().me));
  await settle(r.clock);
  const [host, owner] = r.engines;
  host.lobby.pick('hottakes');
  host.lobby.setting('rounds', 3);
  assert.equal(host.lobby.start().ok, true);
  await settle(r.clock);
  let s = st(r);
  owner.admin.run({ type: 'time', ms: 30000 });
  await settle(r.clock);
  assert.equal(st(r).ends, s.ends + 30000);
  assert.equal(host.snapshot().room.deadline, st(r).ends);
  owner.admin.run({ type: 'time', ms: -600000 });
  await settle(r.clock);
  assert.ok(st(r).ends - host.now() >= 2000);
  answer(r.engines[2], 'skip me');
  await settle(r.clock);
  owner.admin.run({ type: 'skip' });
  await settle(r.clock);
  s = st(r);
  assert.equal(s.phase, 'vote');
  assert.equal(cards(r).length, 1);
  owner.admin.run({ type: 'skip' });
  await settle(r.clock);
  s = st(r);
  assert.equal(s.phase, 'reveal');
  owner.admin.run({ type: 'skip' });
  await settle(r.clock);
  s = st(r);
  assert.equal(s.phase, 'write');
  assert.equal(s.i, 1);
  assert.deepEqual(r.hub.violations, []);
  resetAdmins();
});

test('if the host leaves while writing the prompt restarts, and mid-vote the round ends without points', async () => {
  const r = await startGame(4, { rounds: 3 });
  const [host, a, b, c] = r.engines;
  answer(a, 'first try');
  answer(b, 'also first');
  await r.clock.advance(400);
  let s = st(r);
  const n = s.n;
  r.hub.leave(host.snapshot().me);
  host.destroy();
  await r.clock.advance(800);
  assert.equal(a.isHost(), true);
  s = st(r);
  assert.equal(s.phase, 'write');
  assert.equal(s.note, 'host');
  assert.ok(s.n > n);
  assert.equal(s.i, 0);
  assert.deepEqual(s.done, []);
  const view = hottakes.model(b.snapshot(), { n, sent: 'also first' });
  assert.equal(view.canWrite, true);
  for (const e of [a, b, c]) answer(e, `again ${e.snapshot().meSlot}`);
  await r.clock.advance(500);
  s = st(r);
  assert.equal(s.phase, 'vote');
  assert.equal(s.note, null);
  const list = cards(r);
  b.act({ type: 'vote', n: s.n, id: list.find((x) => x.text !== `again ${b.snapshot().meSlot}`).id });
  await r.clock.advance(400);
  const before = c.snapshot().scores.g;
  r.hub.leave(a.snapshot().me);
  a.destroy();
  await r.clock.advance(800);
  assert.equal(b.isHost(), true);
  s = st(r);
  assert.equal(s.phase, 'reveal');
  assert.equal(s.lost, true);
  assert.equal(s.res, null);
  assert.deepEqual(c.snapshot().scores.g, before);
  const m = hottakes.model(c.snapshot(), {});
  assert.equal(m.lost, true);
  assert.equal(m.cards.length, 3);
  assert.equal(m.cards[0].author, null);
  assert.match(footText(m), /nobody scored/);
  await r.clock.advance(revealMs(s.count) + 300);
  s = st(r);
  assert.equal(s.phase, 'write');
  assert.equal(s.i, 1);
  assert.equal(s.lost, false);
  assert.deepEqual(r.hub.violations, []);
});

test('16 players with long emoji answers stay under the shared state limits', async () => {
  const r = await startGame(16, { rounds: 3 });
  const slots = slotsOf(r);
  const sizes = [];
  const watch = () => {
    for (const [k, v] of Object.entries(r.hub.state)) sizes.push([k, jsonBytes(v)]);
    sizes.push(['all', stateBytes(r.hub.state)]);
  };
  for (let round = 1; round <= 3; round += 1) {
    slots.forEach((slot, i) => answer(bySlot(r, slot), `${slot}-${round}-${i}|${'🌶️🔥"\\'.repeat(30)}`));
    await r.clock.advance(1500);
    watch();
    let s = st(r);
    assert.equal(s.phase, 'vote');
    const list = cards(r);
    assert.equal(list.length, 16);
    for (const c of list) assert.ok(Array.from(c.text).length <= ANSWER_MAX);
    for (const slot of slots) {
      const mine = list.find((c) => c.text.startsWith(`${slot}-${round}-${slots.indexOf(slot)}|`));
      const pick = list.find((c) => c !== mine);
      bySlot(r, slot).act({ type: 'vote', n: s.n, id: pick.id });
    }
    await r.clock.advance(1500);
    watch();
    s = st(r);
    assert.equal(s.phase, 'reveal', JSON.stringify({ voted: s.voted, n: list.length, v: r.hub.violations }));
    assert.equal(s.res.length, 16);
    await r.clock.advance(revealMs(16) + 500);
  }
  for (const [k, size] of sizes) {
    if (k === 'all') assert.ok(size < MAX_STATE_BYTES, `state ${size}`);
    else assert.ok(size <= MAX_VALUE_BYTES, `${k} is ${size} bytes`);
  }
  assert.ok(Object.keys(r.hub.state).length < 64);
  assert.deepEqual(r.hub.violations, []);
});

test('answers stay hidden while writing and authors stay hidden until the reveal', async () => {
  const r = await startGame(3, { rounds: 3 });
  const sent = [];
  const send = r.hub.send.bind(r.hub);
  r.hub.send = (id, data) => {
    sent.push(JSON.stringify(data));
    return send(id, data);
  };
  const slots = slotsOf(r);
  const secret = { [slots[0]]: 'purple banana phone', [slots[1]]: 'grumpy toaster', [slots[2]]: 'dancing sock puppet' };
  answer(bySlot(r, slots[1]), secret[slots[1]]);
  answer(bySlot(r, slots[2]), secret[slots[2]]);
  await r.clock.advance(400);
  const writing = JSON.stringify(r.hub.state);
  for (const t of Object.values(secret)) assert.equal(writing.includes(t), false, `${t} leaked while writing`);
  assert.ok(sent.length > 0);
  for (const msg of sent) for (const t of Object.values(secret)) assert.equal(msg.includes(t), false, `${t} leaked in a message`);
  answer(bySlot(r, slots[0]), secret[slots[0]]);
  await r.clock.advance(400);
  const s = st(r);
  assert.equal(s.phase, 'vote');
  assert.equal(s.res, null);
  assert.deepEqual(s.gained, {});
  for (let i = 0; i < s.chunks; i += 1) for (const row of r.hub.state[`${ANSWER_PREFIX}${i}`]) assert.equal(row.length, 2, 'only an id and the text');
  const order = cards(r).map((c) => c.text);
  assert.deepEqual(order.slice().sort(), Object.values(secret).sort());
  const main = JSON.stringify(s);
  for (const t of Object.values(secret)) assert.equal(main.includes(t), false);
  assert.deepEqual(r.hub.violations, []);
});

function all(root) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children || []) {
      out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

function text(root) {
  return root.textContent.replace(/\s+/g, ' ');
}

function byKey(root, key) {
  return all(root).find((el) => el.dataset && el.dataset.key === key) || null;
}

function noInlineStyle(root) {
  for (const el of all(root)) assert.equal(el.hasAttribute && el.hasAttribute('style'), false, `${el.className} has a style attribute`);
}

test('the view walks through writing, voting and the reveal with cues and no inline styles', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(3, { games: [hottakes] });
  await r.clock.advance(500);
  const played = r.engines.map(() => []);
  const bursts = r.engines.map(() => []);
  const confetti = r.engines.map(() => 0);
  const toasts = [];
  const views = r.engines.map((engine, i) => {
    const cues = { play: (name) => played[i].push(name), burst: (el) => bursts[i].push(el), float() {} };
    const v = createHottakesView({ engine, fx: { confetti: () => (confetti[i] += 1) }, toast: (t) => toasts.push(t), win: {}, cues });
    engine.on('change', (s) => v.update(s));
    return v;
  });
  assert.equal(typeof createHottakesView({ engine: r.engines[0], fx: {}, cues: cueKit({}) }).update, 'function');
  r.engines[0].lobby.pick('hottakes');
  r.engines[0].lobby.start();
  await r.clock.advance(400);
  const s0 = st(r);
  for (const v of views) {
    assert.match(text(v.el), /Round 1 of/);
    assert.match(text(v.el), /0 of 3 players answered/);
    assert.ok(v.el.querySelector('.hottakes-blank'));
    noInlineStyle(v.el);
  }
  assert.deepEqual(played[0], [], 'no cues on the first render');
  const input0 = byKey(views[0].el, 'hottakes-input');
  assert.equal(input0.disabled, false);
  input0.value = '   ';
  byKey(views[0].el, 'hottakes-send').click();
  assert.match(text(views[0].el), /Write something first/);
  assert.ok(played[0].includes('error'));
  const words = ['a very confused llama', 'soup made of socks', 'my left shoe'];
  views.forEach((v, i) => {
    const input = byKey(v.el, 'hottakes-input');
    input.value = words[i];
    byKey(v.el, 'hottakes-send').click();
    if (i === 0) assert.equal(input.disabled, true);
  });
  await r.clock.advance(150);
  await r.clock.advance(500);
  assert.equal(st(r).phase, 'vote');
  for (const v of views) {
    assert.match(text(v.el), /Tap your favourite/);
    noInlineStyle(v.el);
  }
  assert.ok(played[1].includes('pop'));
  const list = cards(r);
  const own = list.find((c) => c.text === words[0]);
  const ownBtn = byKey(views[0].el, `pick-${own.id}`);
  assert.equal(ownBtn.disabled, true);
  assert.match(text(views[0].el), /Yours/);
  const fav = list.find((c) => c.text === words[2]);
  byKey(views[0].el, `pick-${fav.id}`).click();
  byKey(views[1].el, `pick-${fav.id}`).click();
  byKey(views[2].el, `pick-${list.find((c) => c.text === words[0]).id}`).click();
  await r.clock.advance(600);
  const s = st(r);
  assert.equal(s.phase, 'reveal');
  for (const v of views) {
    assert.match(text(v.el), /Hottest take/);
    assert.ok(v.el.querySelector('.hottakes-blank.is-filled'));
    assert.match(v.el.querySelector('.hottakes-blank.is-filled').textContent, /my left shoe/);
    noInlineStyle(v.el);
    checkProfileFaces(v.el, 6);
  }
  assert.match(text(views[2].el), /Yours was the hottest take/);
  assert.equal(confetti[2], 1);
  assert.equal(confetti[0], 0);
  assert.ok(played[2].includes('correct'));
  assert.ok(played[0].includes('reveal'));
  assert.equal(played.flat().filter((x) => x === 'win' || x === 'start' || x === 'coin').length, 0);
  assert.ok(bursts[0].length >= 1);
  const revealCount = played[0].filter((x) => x === 'reveal').length;
  views[0].update(r.engines[0].snapshot());
  assert.equal(played[0].filter((x) => x === 'reveal').length, revealCount, 'cues fire once per moment');
  await r.clock.advance(revealMs(s.count) + 300);
  assert.equal(st(r).phase, 'write');
  assert.ok(played[0].includes('whoosh'));
  assert.equal(byKey(views[1].el, 'hottakes-input').value, '');
  for (const v of views) noInlineStyle(v.el);
  assert.equal(toasts.length, 0);
  assert.ok(s0.n < st(r).n);
  for (const v of views) for (const re of BANNED) assert.doesNotMatch(text(v.el), re);
  for (const v of views) v.destroy();
});

test('footer and cue helpers say the right thing', () => {
  const base = { phase: 'write', done: 1, players: 3, waiting: false, watching: false, wrote: false };
  assert.match(footText(base), /1 of 3 players answered/);
  assert.match(footText({ ...base, waiting: true }), /joined near the end/);
  assert.match(footText({ phase: 'vote', voted: 2, onlyMine: true }), /only answer/);
  assert.match(footText({ phase: 'reveal', cards: [], topIds: [] }), /Nobody wrote/);
  assert.deepEqual(hottakesMoment(null, { n: 1, phase: 'write' }).cues, []);
  assert.deepEqual(hottakesMoment({ n: 1, phase: 'write' }, { n: 1, phase: 'vote' }).cues, ['pop']);
  assert.deepEqual(hottakesMoment({ n: 1, phase: 'vote' }, { n: 1, phase: 'reveal', iTopped: true }).cues, ['reveal', 'correct']);
  assert.deepEqual(hottakesMoment({ n: 1, phase: 'reveal' }, { n: 1, phase: 'reveal' }).cues, []);
});

test('a full 12 player game plays every round and stays inside the message budget', async () => {
  const r = await startGame(12, { rounds: 5, timer: 45 });
  const slots = slotsOf(r);
  for (let round = 1; round <= 5; round += 1) {
    let s = st(r);
    assert.equal(s.phase, 'write', `round ${round}`);
    await writeAll(r, round, slots);
    s = st(r);
    assert.equal(s.phase, 'vote');
    const list = cards(r);
    assert.equal(list.length, 12);
    for (const slot of slots) {
      const mine = list.find((c) => c.text === textOf(slot, round));
      const pick = list.find((c) => c !== mine);
      bySlot(r, slot).act({ type: 'vote', n: s.n, id: pick.id });
    }
    await r.clock.advance(800);
    s = st(r);
    assert.equal(s.phase, 'reveal');
    assert.equal(s.res.reduce((a, row) => a + row[2], 0), 12);
    await r.clock.advance(revealMs(s.count) + 300);
  }
  assert.equal(st(r).phase, 'recap');
  await r.clock.advance(RECAP_MS + 300);
  assert.equal(r.engines[0].snapshot().room.phase, 'results');
  assert.deepEqual(r.hub.violations, []);
});

test('a game that drops to one player keeps going without getting stuck', async () => {
  const r = await startGame(3, { rounds: 3, timer: 45 });
  const [host, a, b] = r.engines;
  for (const e of [a, b]) {
    r.hub.leave(e.snapshot().me);
    e.destroy();
  }
  await r.clock.advance(800);
  answer(host, 'all alone');
  await r.clock.advance(500);
  let s = st(r);
  assert.equal(s.phase, 'reveal', 'nobody else can vote, so the reveal comes straight away');
  assert.deepEqual(s.top, []);
  await r.clock.advance(revealMs(s.count) + 300);
  s = st(r);
  assert.equal(s.phase, 'write');
  assert.equal(s.i, 1);
  await r.clock.advance(45000 + 300);
  assert.equal(st(r).phase, 'reveal');
  assert.deepEqual(r.hub.violations, []);
});

test('players who joined too late to write still count as voters', async () => {
  const r = await startGame(3, { rounds: 3, timer: 45 });
  await r.clock.advance(45000 - LATE_MIN_MS + 2000);
  const late = r.add(4);
  await r.clock.advance(300);
  late.join();
  await r.clock.advance(600);
  const lateSlot = late.snapshot().meSlot;
  assert.ok(st(r).wait.includes(lateSlot));
  const slots = [0, 1, 2].map((i) => r.engines[i].snapshot().meSlot);
  await writeAll(r, 1, slots);
  let s = st(r);
  assert.equal(s.phase, 'vote');
  assert.ok(s.in.includes(lateSlot));
  assert.deepEqual(s.wait, []);
  const list = cards(r);
  for (const slot of slots) {
    const mine = list.find((c) => c.text === textOf(slot, 1));
    bySlot(r, slot).act({ type: 'vote', n: s.n, id: list.find((c) => c !== mine).id });
  }
  await r.clock.advance(500);
  assert.equal(st(r).phase, 'vote', 'waits for the late player too');
  late.act({ type: 'vote', n: s.n, id: list[0].id });
  await r.clock.advance(500);
  s = st(r);
  assert.equal(s.phase, 'reveal');
  assert.deepEqual(r.hub.violations, []);
});

test('forged and out of turn intents change nothing', async () => {
  const r = await startGame(3, { rounds: 3 });
  const slots = slotsOf(r);
  const cheat = bySlot(r, slots[1]);
  const before = JSON.stringify(cheat.snapshot().scores.g);
  cheat.act({ type: 'vote', n: st(r).n, id: 0 });
  cheat.act({ type: 'points', n: st(r).n, pts: 9999 });
  cheat.act({ type: 'answer', n: st(r).n + 5, code: seal('wrong round', st(r).nonce) });
  cheat.act({ type: 'answer', n: st(r).n, code: 'zz.zz.!!' });
  cheat.act({ type: 'answer', n: st(r).n, code: { x: 1 } });
  await r.clock.advance(400);
  let s = st(r);
  assert.equal(s.phase, 'write');
  assert.deepEqual(s.done, []);
  await writeAll(r, 1, slots);
  s = st(r);
  assert.equal(s.phase, 'vote');
  answer(cheat, 'late extra answer');
  cheat.act({ type: 'vote', n: s.n, id: 99 });
  cheat.act({ type: 'vote', n: s.n, id: '0' });
  const own = cards(r).find((c) => c.text === textOf(slots[1], 1));
  cheat.act({ type: 'vote', n: s.n, id: own.id });
  await r.clock.advance(400);
  s = st(r);
  assert.deepEqual(s.voted, []);
  assert.equal(cards(r).length, 3);
  const other = cards(r).find((c) => c !== own);
  cheat.act({ type: 'vote', n: s.n, id: other.id });
  cheat.act({ type: 'vote', n: s.n, id: own.id === 0 ? 1 : 0 });
  await r.clock.advance(400);
  assert.deepEqual(st(r).voted, [slots[1]]);
  assert.equal(JSON.stringify(cheat.snapshot().scores.g), before);
  assert.deepEqual(r.hub.violations, []);
});

test('a vote the host turns down frees the cards again', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startGame(3, { rounds: 3 });
  const slots = slotsOf(r);
  await writeAll(r, 1, slots);
  const me = bySlot(r, slots[0]);
  const timers = [];
  const win = { setTimeout: (fn) => timers.push(fn) && timers.length, clearTimeout() {} };
  const toasts = [];
  const view = createHottakesView({ engine: me, fx: {}, cues: { play() {}, burst() {}, float() {} }, toast: (t) => toasts.push(t), win });
  me.on('change', (s) => view.update(s));
  view.update(me.snapshot());
  const own = cards(r).find((c) => c.text === textOf(slots[0], 1));
  const btn = byKey(view.el, `pick-${own.id}`);
  assert.equal(btn.disabled, false, 'after a reload the view cannot tell which answer is yours');
  btn.click();
  await r.clock.advance(400);
  assert.deepEqual(st(r).voted, []);
  assert.equal(byKey(view.el, `pick-${own.id}`).disabled, true);
  assert.equal(timers.length, 1);
  timers[0]();
  assert.match(toasts.join(' '), /didn’t go through/);
  const other = cards(r).find((c) => c !== own);
  const again = byKey(view.el, `pick-${other.id}`);
  assert.equal(again.disabled, false);
  again.click();
  await r.clock.advance(400);
  assert.deepEqual(st(r).voted, [slots[0]]);
  view.destroy();
});
