import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { room, seeded } from './activity-kit.test.js';
import { installDom, FakeEvent } from './dom-shim.js';
import draw, { PICK_MS, REVEAL_MS, TWISTS, TWIST_LINES, drawAwards, drawHighlights, peekText, unmask, mask, slim } from '../web/activity/js/games/draw.js';
import telephone, { telephoneHighlights, telephoneAwards } from '../web/activity/js/games/telephone.js';
import sketchduel, { duelAwards } from '../web/activity/js/games/sketchduel.js';
import odd, { oddHint, oddAwards, secretOdd, wordKey, oddKey } from '../web/activity/js/games/odd.js';
import pixel, { pixelAwards } from '../web/activity/js/games/pixel.js';
import { heat, secsLabel, HEAT } from '../web/activity/js/games/drawfun.js';
import { wordById } from '../web/activity/data/draw.js';
import { fitInk, inkKey, MAX_CHUNKS } from '../web/activity/js/games/ink.js';
import { VIEWS } from '../web/activity/js/views/index.js';
import { MAX_VALUE_BYTES, jsonBytes } from '../web/activity/js/limits.js';
import { CARD_IDS } from '../web/activity/js/fun.js';

const DRAWING = { draw: 'time', telephone: 'draw', sketchduel: 'draw', odd: 'turn', pixel: 'timer' };
const OLD_DEFAULT = { draw: 80, telephone: 70, sketchduel: 75, odd: 20, pixel: 150 };
const GAMES = { draw, telephone, sketchduel, odd, pixel };

function joinIn(e) {
  if (e.lobby && typeof e.lobby.join === 'function') e.lobby.join();
  else if (typeof e.join === 'function') e.join();
}

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function secret(st) {
  return typeof st.w === 'string' ? null : wordById(unmask(st.w, st.nonce)).w;
}

async function startDraw(n, settings = {}, before = null) {
  const r = room(n);
  await r.clock.advance(500);
  for (const e of r.engines) joinIn(e);
  await r.clock.advance(400);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('draw'), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  if (before) before(host);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  return r;
}

async function pickWord(r, i = 0) {
  const st = r.engines[0].snapshot().state.draw;
  bySlot(r, st.drawer).act({ type: 'pick', i, n: st.n });
  await r.clock.advance(400);
  return r.engines[0].snapshot().state.draw;
}

function wrongWord(word) {
  return word.toLowerCase().includes('q') ? 'zebra' : 'quokka';
}

function fakeApi(game, state, { slots = [0, 1, 2, 3], settings = {}, frozen = [] } = {}) {
  const store = { ...state };
  const ice = new Set(frozen);
  const said = [];
  const rounds = [];
  const points = {};
  let finished = null;
  const random = seeded(4);
  const defaults = {};
  for (const s of game.settings || []) defaults[s.id] = s.default;
  return {
    store,
    said,
    rounds,
    ice,
    get finished() {
      return finished;
    },
    id: game.id,
    now: () => 1000,
    random,
    settings: { ...defaults, ...settings },
    memory: {},
    players: () => slots.map((slot) => ({ slot })),
    nameOf: (slot) => `P${slot}`,
    get: (k) => (store[k] === undefined ? null : JSON.parse(JSON.stringify(store[k]))),
    put: (k, v) => {
      if (v === null) delete store[k];
      else store[k] = JSON.parse(JSON.stringify(v));
    },
    keys: () => Object.keys(store),
    deadline: null,
    setDeadline() {},
    clearDeadline() {},
    shift: (ends, ms) => ends + ms,
    addPoints(slot, n) {
      points[slot] = (points[slot] || 0) + n;
      return n;
    },
    points: () => ({ ...points }),
    round(n, total) {
      rounds.push([n, total]);
    },
    say(kind, data) {
      said.push([kind, data]);
      return true;
    },
    frozen: (slot) => ice.has(slot),
    thaw: (slot) => ice.delete(slot),
    finish(w) {
      finished = w || [];
    },
  };
}

test('every drawing game has a Drawing time setting with long options and a default that is kept or raised', () => {
  for (const [id, key] of Object.entries(DRAWING)) {
    const s = GAMES[id].settings.find((x) => x.id === key);
    assert.ok(s, id);
    assert.equal(s.label, 'Drawing time', id);
    const values = s.options.map((o) => o.value);
    assert.ok(values.includes(s.default), id);
    assert.ok(s.default >= OLD_DEFAULT[id], `${id} keeps or raises its default`);
    assert.ok(Math.max(...values) >= OLD_DEFAULT[id] * 2 || Math.max(...values) >= 180, `${id} has a much longer option`);
    for (const o of s.options) assert.match(o.label, /^\d+ (s|min)( \d+ s)?$/, `${id} ${o.label}`);
  }
  assert.equal(secsLabel(90), '90 s');
  assert.equal(secsLabel(120), '2 min');
  assert.equal(secsLabel(150), '2 min 30 s');
});

test('drawing games declare chaos cards and only turn based games take freezes', () => {
  for (const g of Object.values(GAMES)) {
    assert.ok(Array.isArray(g.cards) && g.cards.length >= 2, g.id);
    for (const c of g.cards) assert.ok(CARD_IDS.includes(c), `${g.id} ${c}`);
    const turnBased = g === draw || g === odd;
    assert.equal(g.cards.includes('freeze'), turnBased, g.id);
    assert.equal(g.cards.includes('peek'), typeof g.hint === 'function', g.id);
  }
  assert.equal(draw.settings.find((s) => s.id === 'twists').default, true);
  assert.equal(draw.settings.find((s) => s.id === 'rounds').default, 1, 'a default game is short');
});

test('hot and cold follow how close a wrong guess is', () => {
  assert.equal(heat('elephnt', 'elephant'), 'h');
  assert.equal(heat('elefant', 'elephant'), 'h');
  assert.equal(heat('elevator', 'elephant'), 'w');
  assert.equal(heat('cup', 'elephant'), 'c');
  assert.equal(heat('pizza', 'giraffe'), 'c');
  for (const k of ['h', 'w', 'c']) assert.ok(HEAT[k].emoji && HEAT[k].text);
});

test('wrong guesses get a hot or cold tag, the word never leaks, and hot misses get a callout', async () => {
  const r = await startDraw(3, { time: 60, twists: false });
  const st0 = await pickWord(r, 0);
  const word = secret(st0);
  const guesser = r.engines.find((e) => e.snapshot().meSlot !== st0.drawer);
  const other = r.engines.find((e) => e !== guesser && e.snapshot().meSlot !== st0.drawer);
  const near = word.length >= 5 ? word.slice(0, -2) + 'zz' : `${word}zz`;
  guesser.act({ type: 'guess', text: near });
  await r.clock.advance(500);
  guesser.act({ type: 'guess', text: wrongWord(word) });
  await r.clock.advance(500);
  const st = r.engines[0].snapshot().state.draw;
  const tags = st.feed.map((f) => f[4]);
  assert.ok(tags.includes('c') || tags.includes('w'), JSON.stringify(st.feed));
  const m = draw.model(other.snapshot());
  for (const f of m.feed) {
    assert.ok(['h', 'w', 'c', null].includes(f.heat));
    assert.notEqual(String(f.text).toLowerCase(), word.toLowerCase());
  }
  assert.ok(JSON.stringify(m.feed).toLowerCase().includes(`"text":"${word.toLowerCase()}"`) === false);
});

test('the last drawing turn is the final round and its points count double', async () => {
  const r = await startDraw(2, { rounds: 1, time: 60, twists: false });
  const host = r.engines[0];
  let st = await pickWord(r, 0);
  assert.equal(host.snapshot().fun ? host.snapshot().fun.final : false, false);
  const g1 = bySlot(r, st.drawer === 0 ? 1 : 0);
  g1.act({ type: 'guess', text: secret(st) });
  await r.clock.advance(400);
  st = host.snapshot().state.draw;
  const first = st.got[0];
  assert.equal(st.gained[first[0]], first[1], 'the first turn is not doubled');
  await r.clock.advance(REVEAL_MS + 300);
  st = await pickWord(r, 0);
  assert.equal(host.snapshot().fun.final, true, 'the last turn is the final round');
  const before = host.snapshot().scores.g;
  const g2 = bySlot(r, st.drawer === 0 ? 1 : 0);
  g2.act({ type: 'guess', text: secret(st) });
  await r.clock.advance(400);
  st = host.snapshot().state.draw;
  const got = st.got[0];
  assert.equal(got[2], got[1] * 2);
  assert.equal(host.snapshot().scores.g[got[0]] - (before[got[0]] || 0), got[1] * 2);
  assert.equal(draw.model(g2.snapshot()).myPts, got[1] * 2);
});

test('with twists off there are never twist rounds, and the setting is a lobby toggle', async () => {
  const r = await startDraw(3, { rounds: 3, time: 60, twists: false });
  const seen = [];
  for (let i = 0; i < 9; i += 1) {
    const st = r.engines[0].snapshot().state.draw;
    if (!st || st.phase === 'final') break;
    seen.push(st.tw || null);
    await r.clock.advance(PICK_MS + 60000 + REVEAL_MS + 1000);
  }
  assert.ok(seen.length >= 3);
  assert.deepEqual(seen.filter(Boolean), []);
});

test('twist rounds show up for everyone and never on the first turn', async () => {
  let twisted = 0;
  for (let seed = 1; seed <= 4 && !twisted; seed += 1) {
    const r = await startDraw(3, { rounds: 3, time: 60 });
    for (let i = 0; i < 9; i += 1) {
      const st = r.engines[0].snapshot().state.draw;
      if (!st) break;
      if (st.tn === 1) assert.equal(st.tw, null);
      if (st.tw) {
        twisted += 1;
        assert.ok(TWISTS[st.tw]);
        for (const e of r.engines) {
          const m = draw.model(e.snapshot());
          assert.equal(m.twist.id, st.tw);
          assert.equal(m.lineCap, st.tw === 'l' ? TWIST_LINES : null);
        }
      }
      await r.clock.advance(PICK_MS + 60000 + REVEAL_MS + 1000);
    }
  }
  assert.ok(twisted > 0, 'twist rounds happen');
});

test('a frozen drawer skips their next turn and the freeze is used up', () => {
  const st = { v: 1, phase: 'reveal', order: [0, 1, 2], rounds: 1, round: 1, pos: 0, n: 1, tn: 1, drawer: 0, nonce: 5, w: null, got: [], feed: [], gained: {}, used: [], pu: [], tm: null, pk: null, pm: null };
  const api = fakeApi(draw, { draw: st }, { slots: [0, 1, 2], frozen: [1] });
  assert.equal(draw.canFreeze(api, 1), true);
  assert.equal(draw.canFreeze(api, 0), false, 'no turns left for the current drawer');
  draw.deadline(api);
  const next = api.store.draw;
  assert.equal(next.drawer, 2, 'player 1 is skipped');
  assert.equal(api.ice.has(1), false, 'the freeze is used up');
  assert.ok(api.said.some(([k, d]) => k === 'custom' && /frozen/.test(d.text)));
  assert.deepEqual(api.rounds[api.rounds.length - 1], [2, 2]);
});

test('peek gives a fair letter hint and never the whole word', () => {
  const word = 'balloon';
  const st = { nonce: 7, starts: 0, ends: 60000 };
  const hint = peekText(word, st, 1000);
  assert.match(hint, /starts with "B"/);
  assert.equal(hint.toLowerCase().includes(word), false);
  const later = peekText(word, st, 59000);
  assert.ok(later === null || /Letter \d is "[A-Z]"|starts with "B"/.test(later), later);
  const opened = peekText(word, { nonce: 7, starts: 0, ends: 60000 }, 59000);
  if (opened) assert.equal(opened.toLowerCase().includes(word), false);
  const api = fakeApi(draw, { draw: { phase: 'draw', drawer: 0, got: [[2, 300]], nonce: 9, w: mask(wordById(1) ? 1 : 0, 9), starts: 900, ends: 60900 } });
  assert.equal(draw.hint(api, 0), null, 'not for the drawer');
  assert.equal(draw.hint(api, 2), null, 'not for someone who got it');
  assert.equal(typeof draw.hint(api, 1), 'string');
});

test('drawing awards pick the worst drawing that still won and other fun titles', () => {
  const st = { sx: { d: [[0, 2, 9, 2, 0, 1], [1, 1, 2, 2, 1, 2], [2, 2, 14, 2, 0, 3], [0, 0, 1, 2, 0, 4]], f: { 1: 3, 2: 1 }, h: { 2: 2 } } };
  const list = drawAwards(st);
  const worst = list.find((a) => a.title === 'Worst drawing that still won');
  assert.equal(worst.who, 1, 'fewest lines among drawings someone guessed');
  assert.match(worst.why, /2 lines/);
  assert.ok(list.find((a) => a.title === 'Masterpiece'));
  assert.equal(list.find((a) => a.title === 'Twist survivor').who, 1);
  assert.equal(list.find((a) => a.title === 'Quickest eyes').who, 1);
  assert.equal(list.find((a) => a.title === 'Most dramatic guesser').who, 2);
  for (const a of list) assert.ok(a.title.length <= 32 && a.why.length <= 80, a.title);
  assert.deepEqual(drawAwards({}), []);
  assert.deepEqual(drawHighlights({ hl: [[1, 'a potato', 'giraffe', 2], ['x']] }), [{ who: 1, text: 'Guessed "a potato" for giraffe' }]);
});

test('a full Draw & Guess game ends with drawing awards and a highlight reel, inside the limits', async () => {
  const r = await startDraw(3, { rounds: 1, time: 60, twists: false });
  const host = r.engines[0];
  const random = seeded(3);
  for (let turn = 0; turn < 3; turn += 1) {
    const st = await pickWord(r, 0);
    const word = secret(st);
    const drawer = bySlot(r, st.drawer);
    const strokes = [];
    for (let i = 0; i <= turn * 3; i += 1) strokes.push({ c: 1, z: 1, pts: [[10 + i * 20, 10], [40 + i * 20, 60 + random() * 50]] });
    const fit = fitInk(strokes, st.nonce, 0);
    for (let j = 0; j < MAX_CHUNKS; j += 1) drawer.direct(inkKey(j), fit.chunks[j] || null);
    await r.clock.advance(500);
    const guessers = r.engines.filter((e) => e !== drawer);
    guessers[0].act({ type: 'guess', text: wrongWord(word) });
    await r.clock.advance(500);
    for (const g of guessers) g.act({ type: 'guess', text: word });
    await r.clock.advance(500);
    assert.equal(host.snapshot().state.draw.phase, 'reveal');
    for (const [k, v] of Object.entries(r.hub.state)) assert.ok(jsonBytes(v) <= MAX_VALUE_BYTES, k);
    await r.clock.advance(REVEAL_MS + 300);
  }
  const snap = host.snapshot();
  assert.equal(snap.room.phase, 'results');
  const titles = snap.fun.awards.map((a) => a.title);
  assert.ok(titles.includes('Worst drawing that still won'), titles.join(', '));
  assert.ok(snap.fun.highlights.length >= 1);
  for (const h of snap.fun.highlights) assert.match(h.text, /^Guessed "/);
  assert.deepEqual(r.hub.violations, []);
});

test('Draw & Guess state with every fun stat filled still fits one shared value', () => {
  const big = '🎉'.repeat(40);
  const st = {
    v: 1, tn: 48, tw: 'l', db: 999, sx: { d: Array.from({ length: 24 }, () => [15, 14, 999, 15, 1, 48]), f: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [i, 9])), h: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [i, 9])) },
    hl: Array.from({ length: 5 }, () => [15, big, 'y'.repeat(32), 48]), rounds: 3, round: 3, pos: 15, order: Array.from({ length: 16 }, (_, i) => i), n: 48, drawer: 15, phase: 'draw', nonce: 65535, opts: [], w: 65535, word: null,
    got: Array.from({ length: 15 }, (_, i) => [i, 500, 1000]), feed: Array.from({ length: 8 }, () => [999, 15, big, 'guess', 'c']), fid: 999, gained: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [i, 1000])),
    used: Array.from({ length: 150 }, () => 3999), pu: Array.from({ length: 90 }, () => 89), pk: { c: 'ABCDEFGH', n: 'x'.repeat(40) }, starts: 1e13, ends: 1e13, hx: [15, big],
  };
  assert.ok(jsonBytes(st) > MAX_VALUE_BYTES);
  assert.ok(jsonBytes(slim(st)) <= MAX_VALUE_BYTES);
  assert.equal(st.feed.length, 8, 'the live feed is never cut');
});

test('Odd One Out: turns use the drawing time, frozen players skip a line, and peeks are fair', () => {
  const k = 77;
  const st = { v: 1, r: 1, rounds: 2, laps: 1, k, tms: 45000, t: 'animals', w: mask(1, wordKey(k)), x: mask(2, oddKey(k)), order: [0, 1, 2, 3], cols: [3, 8, 6, 9], phase: 'intro', lap: 1, pos: -1, turn: null, n: 0, cap: 500, marks: [], lens: [], hid: [], wait: [], voted: [], gained: {} };
  const api = fakeApi(odd, { odd: st }, { frozen: [0] });
  assert.equal(secretOdd(st), 2);
  assert.equal(odd.canFreeze(api, 0), true);
  odd.deadline(api);
  const next = api.store.odd;
  assert.equal(next.phase, 'draw');
  assert.equal(next.turn, 1, 'player 0 is frozen and skipped');
  assert.deepEqual(next.marks, [-1]);
  assert.equal(next.ends - next.starts, 45000);
  assert.equal(odd.model({ state: { odd: next }, meSlot: 1, players: [], meJoined: true }).turnMs, 45000);
  assert.equal(api.ice.has(0), false);
  assert.equal(odd.canFreeze(api, 0), false, 'they have no lines left this round');
  const fake = oddHint(next, 2, seeded(1));
  assert.match(fake, /starts with "[A-Z]"/);
  for (let i = 0; i < 10; i += 1) {
    const h = oddHint(next, 0, seeded(i + 1));
    assert.ok(h && Number.isInteger(h.slot));
    assert.notEqual(h.slot, 2, 'never points at the faker');
    assert.notEqual(h.slot, 0, 'never about yourself');
  }
  assert.match(odd.hint(api, 1), /is NOT the odd one out/);
  assert.equal(odd.settings.find((s) => s.id === 'turn').default, 25);
});

test('drawing game awards and highlights are gentle, short and about the game', () => {
  const lists = [
    duelAwards({ sx: { w: { 1: 3, 2: 1 }, s: { 2: 1 }, t: { 0: 1 } } }),
    oddAwards({ sx: { e: { 1: 2 }, s: { 2: 1 }, c: { 3: 2 } } }),
    pixelAwards({ sx: { p: { 0: 40, 1: 12, 2: 6 } } }),
    telephoneAwards({ aw: [{ id: 'fav', e: '🔥', title: 'Crowd favorite', why: 'Got the most reactions', slot: 1 }] }),
  ];
  for (const list of lists) {
    assert.ok(list.length >= 1);
    for (const a of list) {
      assert.ok(a.emoji && a.title && Number.isInteger(a.who));
      assert.ok(a.title.length <= 32 && a.why.length <= 80, a.title);
      assert.equal(/stupid|dumb|bad|terrible|worst player|loser/i.test(`${a.title} ${a.why}`), false, a.title);
    }
  }
  assert.equal(duelAwards({ sx: { w: { 1: 3 } } })[0].who, 1);
  const hl = telephoneHighlights({
    chains: [
      [{ k: 'w', by: 0, t: 'A whale juggling pancakes' }, { k: 'd', by: 1, s: ['x'] }, { k: 't', by: 2, t: 'A toaster with arms' }],
      [{ k: 'w', by: 1, t: 'A cat', miss: 1 }, { k: 'd', by: 2, s: [] }, { k: 't', by: 0, t: 'Dog' }],
    ],
  });
  assert.deepEqual(hl, [{ who: 0, text: '"A whale juggling pancakes" turned into "A toaster with arms"' }]);
});

test('Sketch Duel and Pixel Art report rounds and score through the multiplier', () => {
  const sd = fakeApi(sketchduel, {}, { slots: [0, 1, 2, 3] });
  sketchduel.start(sd);
  assert.deepEqual(sd.rounds[0], [1, 2]);
  const px = fakeApi(pixel, {}, { slots: [0, 1], settings: { rounds: 2 } });
  pixel.start(px);
  assert.deepEqual(px.rounds[0], [1, 2]);
});

function all(node, out = []) {
  for (const c of node.childNodes || []) {
    if (c.localName) out.push(c);
    all(c, out);
  }
  return out;
}

function text(node) {
  if (node.data !== undefined && !node.localName) return node.data;
  return (node.childNodes || []).map(text).join(' ');
}

function byKey(root, key) {
  return all(root).find((el) => el.dataset && el.dataset.key === key) || null;
}

function pointer(type, x, y) {
  const e = new FakeEvent(type, { bubbles: true });
  e.clientX = x;
  e.clientY = y;
  e.pointerId = 1;
  return e;
}

test('the draw view runs each twist for the drawer and shows hot and cold tags', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startDraw(2, { time: 60, twists: false });
  const make2d = document.createElement.bind(document);
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => undefined), set: (t, k, v) => ((t[k] = v), true) });
  document.createElement = (tag) => {
    const el = make2d(tag);
    if (tag === 'canvas') el.getContext = () => ctx;
    return el;
  };
  const win = { setTimeout: r.clock.setTimeout, clearTimeout: r.clock.clearTimeout, setInterval: () => 0, clearInterval() {} };
  const st = await pickWord(r, 0);
  const drawerEngine = bySlot(r, st.drawer);
  const guestEngine = r.engines.find((e) => e !== drawerEngine);
  const toasts = [];
  const v = VIEWS.draw({ engine: drawerEngine, fx: { confetti() {} }, toast: (t) => toasts.push(t), win });
  const canvas = all(v.el).find((x) => x.localName === 'canvas');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 480, height: 360 });
  const withTwist = (snap, tw) => ({ ...snap, state: { ...snap.state, draw: { ...snap.state.draw, tw } } });
  v.update(withTwist(drawerEngine.snapshot(), 'u'));
  assert.match(text(v.el), /Twist round: No undo/);
  assert.equal(byKey(v.el, 'undo').disabled, true);
  assert.equal(byKey(v.el, 'clear').disabled, true);
  v.update(withTwist(drawerEngine.snapshot(), 'b'));
  assert.match(v.el.querySelector('.paper').className, /is-blind/);
  assert.match(text(v.el), /Blind canvas/);
  v.update(withTwist(drawerEngine.snapshot(), 'l'));
  assert.match(text(v.el), /3 lines left/);
  for (let i = 0; i < 4; i += 1) {
    canvas.dispatchEvent(pointer('pointerdown', 20 + i * 30, 20));
    canvas.dispatchEvent(pointer('pointermove', 60 + i * 30, 80));
    canvas.dispatchEvent(pointer('pointerup', 60 + i * 30, 80));
  }
  assert.ok(toasts.includes("That's all your lines!"), toasts.join(' | '));
  v.update(withTwist(drawerEngine.snapshot(), null));
  assert.equal(v.el.querySelector('.twist-banner'), null);
  v.destroy();
  const g = VIEWS.draw({ engine: guestEngine, fx: { confetti() {} }, toast: () => {}, win });
  guestEngine.act({ type: 'guess', text: wrongWord(secret(st)) });
  await r.clock.advance(500);
  g.update(guestEngine.snapshot());
  const tag = g.el.querySelector('.feed-heat');
  assert.ok(tag, 'the wrong guess has a hot or cold tag');
  assert.match(tag.className, /heat-[hwc]/);
  g.destroy();
});

test('the new draw files have no comments, inline styles or outside resources', () => {
  const files = ['web/activity/js/games/drawfun.js', 'web/activity/css/draw.css'];
  for (const f of files) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.equal(/\/\*|(^|[^:'"`])\/\/(?!\S*\.)/m.test(src.replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''")), false, f);
    assert.equal(/https?:\/\//.test(src), false, f);
    assert.equal(/style=/.test(src), false, f);
  }
  const html = readFileSync(new URL('../web/activity/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('/activity/css/draw.css'));
  assert.ok(html.indexOf('/activity/css/draw.css') < html.indexOf('/activity/css/juice.css'));
});

test('cold callouts come at most once per drawing turn', async () => {
  const r = await startDraw(4, { time: 60, twists: false });
  const st0 = await pickWord(r, 0);
  const word = secret(st0);
  const kinds = [];
  let seen = 0;
  for (let i = 0; i < 40; i += 1) {
    for (const e of r.engines) if (e.snapshot().meSlot !== st0.drawer) e.act({ type: 'guess', text: wrongWord(word) });
    await r.clock.advance(1200);
    const line = r.engines[1].snapshot().fun.line;
    if (line && line.i !== seen) {
      seen = line.i;
      kinds.push(line.kind);
    }
  }
  assert.ok(kinds.filter((k) => k === 'cold').length <= 1, kinds.join(','));
});

test('Draw & Guess plays again with the same teams', async () => {
  const r = await startDraw(4, { time: 60, twists: false, teams: 'two' });
  const host = r.engines[0];
  const first = host.snapshot().state.draw.tm;
  assert.ok(first);
  host.lobby.end();
  await r.clock.advance(500);
  assert.equal(host.snapshot().fun.sameTeams, true);
  for (let i = 0; i < 6; i += 1) {
    assert.equal(host.lobby.start({ sameTeams: true }).ok, true);
    await r.clock.advance(400);
    assert.deepEqual(host.snapshot().state.draw.tm, first);
    host.lobby.end();
    await r.clock.advance(500);
  }
});

test('a hot guess shows its tag to everyone but its text only to the guesser', async () => {
  const r = await startDraw(3, { time: 60, twists: false });
  const st0 = await pickWord(r, 0);
  const word = secret(st0).toLowerCase();
  const guesser = r.engines.find((e) => e.snapshot().meSlot !== st0.drawer);
  const other = r.engines.find((e) => e !== guesser && e.snapshot().meSlot !== st0.drawer);
  const near = word.length >= 6 ? `${word.slice(0, -2)}qq` : `${word}qq`;
  guesser.act({ type: 'guess', text: near });
  await r.clock.advance(500);
  const hot = draw.model(other.snapshot()).feed.filter((f) => f.heat === 'h');
  assert.ok(hot.length >= 1, JSON.stringify(r.engines[0].snapshot().state.draw.feed));
  for (const f of hot) assert.equal(f.text, '');
  const mine = draw.model(guesser.snapshot()).feed.filter((f) => f.heat === 'h');
  assert.ok(mine.some((f) => f.text === near));
});

test('a frozen last drawer does not steal the final round from the turn before', () => {
  const st = { v: 1, phase: 'reveal', order: [0, 1, 2, 3], rounds: 1, round: 1, pos: 0, n: 1, tn: 1, drawer: 0, nonce: 5, w: null, got: [], feed: [], gained: {}, used: [], pu: [], tm: null, pk: null, pm: null };
  const api = fakeApi(draw, { draw: st }, { slots: [0, 1, 2, 3], frozen: [3] });
  draw.deadline(api);
  assert.equal(api.store.draw.drawer, 1);
  assert.deepEqual(api.rounds[api.rounds.length - 1], [2, 3]);
  api.store.draw = { ...api.store.draw, phase: 'reveal' };
  draw.deadline(api);
  assert.equal(api.store.draw.drawer, 2);
  assert.deepEqual(api.rounds[api.rounds.length - 1], [3, 3], 'the last real turn is the final round');
});
