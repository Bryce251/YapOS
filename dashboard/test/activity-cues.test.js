import test from 'node:test';
import assert from 'node:assert/strict';
import { room } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import { VIEWS, cueKit } from '../web/activity/js/views/index.js';
import { chainMoments } from '../web/activity/js/views/chain.js';
import { drawMoments, feedIds } from '../web/activity/js/views/draw.js';
import { triviaMoment } from '../web/activity/js/views/trivia.js';
import { wyrMoment } from '../web/activity/js/views/wyr.js';
import { questionById } from '../web/activity/data/trivia.js';
import { wordById } from '../web/activity/data/draw.js';
import { unmask, REVEAL_MS } from '../web/activity/js/games/draw.js';

function setup() {
  installDom({ url: 'https://yapos.dev/activity/' });
  const proto = Object.getPrototypeOf(document.createElement('div'));
  proto.getBoundingClientRect = () => ({ top: 10, left: 20, right: 60, bottom: 30, width: 40, height: 20 });
}

function recorder() {
  const log = [];
  return {
    log,
    sfx: { play: (name, opts) => log.push({ kind: 'play', name, opts: opts || {} }) },
    juice: {
      burst: (x, y, opts) => log.push({ kind: 'burst', x, y, opts }),
      floatText: (el, text) => log.push({ kind: 'float', text }),
    },
    plays: () => log.filter((e) => e.kind === 'play').map((e) => e.name),
    count: (kind) => log.filter((e) => e.kind === kind).length,
    clear: () => log.splice(0, log.length),
  };
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

function joinIn(e) {
  if (e.lobby && typeof e.lobby.join === 'function') e.lobby.join();
  else if (typeof e.join === 'function') e.join();
}

function bySlot(engines, slot) {
  return engines.find((e) => e.snapshot().meSlot === slot);
}

const fakeWin = (r) => ({ setTimeout: r.clock.setTimeout, clearTimeout: r.clock.clearTimeout, setInterval: () => 0, clearInterval() {} });

function mount(r, id, win = {}) {
  return r.engines.map((engine) => {
    const rec = recorder();
    const v = VIEWS[id]({ engine, fx: { confetti() {} }, toast() {}, win, sfx: rec.sfx, juice: rec.juice });
    engine.on('change', (s) => v.update(s));
    return { engine, v, rec };
  });
}

test('the cue kit never throws when sounds or effects are missing or broken', () => {
  setup();
  const quiet = cueKit({ sfx: { play() {} }, juice: {} });
  quiet.play('tap');
  quiet.burst(document.createElement('div'));
  quiet.float(document.createElement('div'), '+1');
  const broken = cueKit({
    sfx: {
      play() {
        throw new Error('no audio');
      },
    },
    juice: {
      burst() {
        throw new Error('no layer');
      },
      floatText() {
        throw new Error('no layer');
      },
    },
  });
  broken.play('tap');
  broken.burst(document.createElement('div'));
  broken.float(document.createElement('div'), '+1');
  broken.burst(null);
  const real = cueKit();
  real.play('nothing-like-this');
  assert.ok(true);
});

test('bursts start from the middle of the element and skip hidden ones', () => {
  setup();
  const rec = recorder();
  const kit = cueKit({ sfx: rec.sfx, juice: rec.juice });
  kit.burst(document.createElement('div'), { count: 3 });
  assert.deepEqual(rec.log[0], { kind: 'burst', x: 40, y: 20, opts: { count: 3 } });
  const hidden = document.createElement('div');
  hidden.getBoundingClientRect = () => ({ top: 0, left: 0, width: 0, height: 0 });
  kit.burst(hidden);
  assert.equal(rec.count('burst'), 1);
});

test('word chain moments are pure and only fire on changes', () => {
  const base = { phase: 'turn', t: 1, myTurn: false, words: [], players: [{ slot: 0, lives: 3 }, { slot: 1, lives: 3 }] };
  const first = chainMoments(null, base);
  assert.deepEqual(first.cues, []);
  assert.deepEqual(chainMoments(first.now, base).cues, []);
  const played = chainMoments(first.now, { ...base, t: 2, myTurn: true, words: [{ n: 1 }] });
  assert.deepEqual(played.cues.map((c) => c.name), ['send', 'turn']);
  assert.equal(played.cues[1].opts.at, 260);
  const missed = chainMoments(played.now, { ...base, t: 3, words: [{ n: 1 }], players: [{ slot: 0, lives: 2 }, { slot: 1, lives: 3 }] });
  assert.deepEqual(missed.cues.map((c) => [c.name, c.opts.volume]), [['lose', 0.55]]);
  const out = chainMoments(missed.now, { ...base, t: 4, words: [{ n: 1 }], players: [{ slot: 0, lives: 0 }, { slot: 1, lives: 3 }] });
  assert.deepEqual(out.cues.map((c) => [c.name, c.opts.volume]), [['lose', 1]]);
  const over = chainMoments(missed.now, { ...base, phase: 'over', t: 4, words: [{ n: 1 }], players: [{ slot: 0, lives: 0 }, { slot: 1, lives: 3 }] });
  assert.deepEqual(over.cues, [], 'the results screen plays the last-standing sound');
  const struck = chainMoments(played.now, { ...base, t: 5, words: [] });
  assert.deepEqual(struck.cues, [], 'a word voted out is not a new word');
});

test('the word chain view plays send, turn, error and lose for the right people', async () => {
  setup();
  const r = room(3);
  await r.clock.advance(500);
  const views = mount(r, 'chain');
  r.engines[0].lobby.pick('chain');
  r.engines[0].lobby.setting('lives', 3);
  r.engines[0].lobby.start();
  await r.clock.advance(400);
  for (const x of views) x.v.update(x.engine.snapshot());
  for (const x of views) assert.deepEqual(x.rec.plays(), [], 'nothing on the first render');
  let s = r.engines[0].snapshot().state.chain;
  const up = views.find((x) => x.engine.snapshot().meSlot === s.cur);
  const input = byKey(up.v.el, 'chain-input');
  input.value = `${s.letter === 'z' ? 'y' : 'z'}ebra`;
  byKey(up.v.el, 'chain-send').click();
  assert.deepEqual(up.rec.plays(), ['error']);
  assert.equal(input.classList.contains('is-refused'), true);
  for (const x of views.filter((y) => y !== up)) assert.deepEqual(x.rec.plays(), []);
  up.rec.clear();
  input.value = `${s.letter}oom`;
  byKey(up.v.el, 'chain-send').click();
  await r.clock.advance(500);
  s = r.engines[0].snapshot().state.chain;
  assert.equal(s.count, 1);
  const next = views.find((x) => x.engine.snapshot().meSlot === s.cur);
  for (const x of views) {
    const want = x === next ? ['send', 'turn'] : ['send'];
    assert.deepEqual(x.rec.plays(), want, `slot ${x.engine.snapshot().meSlot}`);
    assert.equal(x.rec.count('burst'), 1, 'a small burst on the new word');
  }
  for (const x of views) x.rec.clear();
  await r.clock.advance(15000 + 300);
  s = r.engines[0].snapshot().state.chain;
  assert.equal(s.lives[next.engine.snapshot().meSlot], 2);
  for (const x of views) {
    const loses = x.rec.log.filter((e) => e.name === 'lose');
    assert.equal(loses.length, 1, 'one lose per lost life');
    assert.equal(loses[0].opts.volume, 0.55);
    const turns = x.rec.plays().filter((n) => n === 'turn').length;
    assert.equal(turns, x.engine.snapshot().meSlot === s.cur ? 1 : 0);
  }
  for (const x of views) x.v.destroy();
});

test('draw and guess moments are pure and only fire on changes', () => {
  const me = { slot: 1, isMe: true };
  const them = { slot: 2, isMe: false };
  const base = { n: 1, phase: 'draw', amDrawer: false, got: [], feed: [], drawerGain: 0 };
  const first = drawMoments(null, base);
  assert.deepEqual(first.cues, []);
  assert.deepEqual(drawMoments(first.now, base).cues, []);
  const guessed = { ...base, feed: [{ id: 'u1', mine: true, kind: 'guess' }] };
  const miss = drawMoments(first.now, guessed, [1]);
  assert.deepEqual(miss.cues.map((c) => [c.name, c.opts.volume]), [['type', 0.3]]);
  assert.deepEqual(drawMoments(miss.now, guessed, [1]).cues, []);
  assert.deepEqual(drawMoments(first.now, { ...base, feed: [{ id: 'u2', mine: false, kind: 'guess' }] }, [1]).cues, [], "other people's misses stay quiet");
  assert.deepEqual(feedIds({ draw: { feed: [[4, 1, 'x', 'guess'], [5, 2, '', 'ok']] } }), [4, 5]);
  assert.deepEqual(feedIds({}), []);
  const theirs = drawMoments(first.now, { ...base, got: [them] });
  assert.deepEqual(theirs.cues.map((c) => [c.name, c.opts.volume, c.at]), [['correct', 0.45, undefined]]);
  const mine = drawMoments(theirs.now, { ...base, got: [them, me], feed: [{ id: 'u1', mine: true, kind: 'ok' }] }, [2]);
  assert.deepEqual(mine.cues.map((c) => [c.name, c.opts.volume, c.at]), [['correct', 1, 'guess']]);
  const reveal = drawMoments(mine.now, { ...base, phase: 'reveal', amDrawer: true, drawerGain: 90, got: [them, me] });
  assert.deepEqual(reveal.cues.map((c) => c.name), ['reveal', 'coin']);
  const watcher = drawMoments(mine.now, { ...base, phase: 'reveal', drawerGain: 90, got: [them, me] });
  assert.deepEqual(watcher.cues.map((c) => c.name), ['reveal'], 'only the drawer hears their coins');
  const turn = drawMoments(reveal.now, { ...base, n: 2, phase: 'pick', amDrawer: true });
  assert.deepEqual(turn.cues.map((c) => c.name), ['turn']);
  assert.deepEqual(drawMoments(reveal.now, { ...base, n: 2, phase: 'pick' }).cues, []);
});

test('the draw view cues guesses, the reveal, the drawer coins and the next drawer', async () => {
  setup();
  const r = room(3);
  await r.clock.advance(500);
  for (const e of r.engines) joinIn(e);
  await r.clock.advance(400);
  const host = r.engines[0];
  host.lobby.pick('draw');
  host.lobby.setting('rounds', 2);
  host.lobby.start();
  await r.clock.advance(300);
  const views = mount(r, 'draw', fakeWin(r));
  for (const x of views) x.v.update(x.engine.snapshot());
  let st = host.snapshot().state.draw;
  bySlot(r.engines, st.drawer).act({ type: 'pick', i: 0, n: st.n });
  await r.clock.advance(400);
  for (const x of views) assert.deepEqual(x.rec.plays(), [], 'nothing until something happens');
  st = host.snapshot().state.draw;
  const word = wordById(unmask(st.w, st.nonce)).w;
  const drawer = views.find((x) => x.engine.snapshot().meSlot === st.drawer);
  const [a, b] = views.filter((x) => x !== drawer);
  a.engine.act({ type: 'guess', text: 'qqqqqqqqqq' });
  await r.clock.advance(800);
  assert.deepEqual(a.rec.plays(), ['type']);
  a.v.update(a.engine.snapshot());
  a.v.update(a.engine.snapshot());
  assert.deepEqual(a.rec.plays(), ['type'], 'the once-a-second refresh does not repeat cues');
  assert.deepEqual(b.rec.plays(), []);
  assert.deepEqual(drawer.rec.plays(), []);
  a.rec.clear();
  a.engine.act({ type: 'guess', text: word });
  await r.clock.advance(800);
  assert.deepEqual(a.rec.log.filter((e) => e.kind === 'play').map((e) => [e.name, e.opts.volume]), [['correct', 1]]);
  assert.equal(a.rec.count('burst'), 1, 'my right guess bursts');
  for (const x of [b, drawer]) {
    assert.deepEqual(x.rec.log.filter((e) => e.kind === 'play').map((e) => [e.name, e.opts.volume]), [['correct', 0.45]]);
    assert.equal(x.rec.count('burst'), 0);
  }
  for (const x of views) x.rec.clear();
  b.engine.act({ type: 'guess', text: word });
  await r.clock.advance(800);
  assert.equal(host.snapshot().state.draw.phase, 'reveal');
  assert.deepEqual(drawer.rec.plays(), ['correct', 'reveal', 'coin']);
  assert.equal(drawer.rec.count('float'), 1, 'the drawer sees their points float up');
  assert.deepEqual(a.rec.plays(), ['correct', 'reveal']);
  assert.deepEqual(b.rec.plays(), ['correct', 'reveal']);
  for (const x of views) x.rec.clear();
  await r.clock.advance(REVEAL_MS + 300);
  st = host.snapshot().state.draw;
  assert.equal(st.phase, 'pick');
  for (const x of views) assert.deepEqual(x.rec.plays(), x.engine.snapshot().meSlot === st.drawer ? ['turn'] : []);
  for (const x of views) x.v.destroy();
});

test('trivia and would you rather moments only fire once per reveal', () => {
  const q = { qid: 'q1', phase: 'question', myPick: null, gotIt: false, skipped: false };
  const first = triviaMoment(null, { ...q, phase: 'reveal', myPick: 1, gotIt: true });
  assert.equal(first.cue, null, 'nothing on the first render');
  const asked = triviaMoment(null, q);
  assert.equal(triviaMoment(asked.now, { ...q, phase: 'reveal', myPick: 1, gotIt: true }).cue, 'correct');
  assert.equal(triviaMoment(asked.now, { ...q, phase: 'reveal', myPick: 2 }).cue, 'wrong');
  assert.equal(triviaMoment(asked.now, { ...q, phase: 'reveal' }).cue, null);
  assert.equal(triviaMoment(asked.now, { ...q, phase: 'reveal', myPick: 1, skipped: true }).cue, null);
  const shown = triviaMoment(asked.now, { ...q, phase: 'reveal', myPick: 1, gotIt: true });
  assert.equal(triviaMoment(shown.now, { ...q, phase: 'reveal', myPick: 1, gotIt: true }).cue, null);
  const p = { pid: 'p1', phase: 'vote', myVote: null, side: null };
  const voting = wyrMoment(null, p);
  assert.deepEqual(voting.cues, []);
  assert.deepEqual(wyrMoment(voting.now, { ...p, phase: 'reveal', myVote: 'a', side: 'a' }).cues, ['reveal', 'correct']);
  assert.deepEqual(wyrMoment(voting.now, { ...p, phase: 'reveal', myVote: 'b', side: 'a' }).cues, ['reveal']);
  assert.deepEqual(wyrMoment(voting.now, { ...p, phase: 'reveal', myVote: 'b', side: 'tie' }).cues, ['reveal', 'correct']);
  assert.deepEqual(wyrMoment(voting.now, { ...p, phase: 'reveal', side: 'a' }).cues, ['reveal']);
  const done = wyrMoment(voting.now, { ...p, phase: 'reveal', side: 'a' });
  assert.deepEqual(wyrMoment(done.now, { ...p, phase: 'reveal', side: 'a' }).cues, []);
});

test('the trivia view plays send on a pick and right or wrong only for the people who answered', async () => {
  setup();
  const r = room(3);
  await r.clock.advance(500);
  r.engines[0].lobby.pick('trivia');
  r.engines[0].lobby.start();
  await r.clock.advance(300);
  const views = mount(r, 'trivia');
  for (const x of views) x.v.update(x.engine.snapshot());
  for (const x of views) assert.deepEqual(x.rec.plays(), []);
  const st = r.engines[0].snapshot().state.trivia;
  assert.equal(st.phase, 'question');
  const right = st.q.options.indexOf(questionById(st.q.id).a);
  const wrong = (right + 1) % 4;
  const [good, bad, idle] = views;
  byKey(good.v.el, `opt-${right}`).click();
  byKey(bad.v.el, `opt-${wrong}`).click();
  assert.deepEqual(good.rec.plays(), ['send']);
  assert.deepEqual(bad.rec.plays(), ['send']);
  assert.deepEqual(idle.rec.plays(), []);
  for (const x of views) x.rec.clear();
  for (let i = 0; i < 40 && r.engines[0].snapshot().state.trivia.phase !== 'reveal'; i += 1) await r.clock.advance(1000);
  assert.equal(r.engines[0].snapshot().state.trivia.phase, 'reveal');
  await r.clock.advance(300);
  assert.deepEqual(good.rec.plays(), ['correct']);
  assert.equal(good.rec.count('burst'), 1);
  assert.equal(good.rec.count('float'), 1);
  assert.deepEqual(bad.rec.plays(), ['wrong']);
  assert.equal(bad.rec.count('burst'), 0);
  assert.deepEqual(idle.rec.plays(), []);
  for (const x of views) x.v.destroy();
});

test('the would you rather view plays send on a vote, reveal for all and correct for the winning side', async () => {
  setup();
  const r = room(3);
  await r.clock.advance(500);
  r.engines[0].lobby.pick('wyr');
  r.engines[0].lobby.start();
  await r.clock.advance(300);
  const views = mount(r, 'wyr');
  for (const x of views) x.v.update(x.engine.snapshot());
  for (const x of views) assert.deepEqual(x.rec.plays(), []);
  const picks = ['a', 'a', 'b'];
  views.forEach((x, i) => byKey(x.v.el, `side-${picks[i]}`).click());
  for (const x of views) assert.deepEqual(x.rec.plays(), ['send']);
  for (const x of views) x.rec.clear();
  for (let i = 0; i < 40 && r.engines[0].snapshot().state.wyr.phase !== 'reveal'; i += 1) await r.clock.advance(1000);
  const st = r.engines[0].snapshot().state.wyr;
  assert.equal(st.phase, 'reveal');
  views.forEach((x, i) => {
    const won = st.side === picks[i] || st.side === 'tie';
    assert.deepEqual(x.rec.plays(), won ? ['reveal', 'correct'] : ['reveal'], `voter ${i}`);
    assert.equal(x.rec.count('burst'), won ? 1 : 0);
  });
  for (const x of views) x.v.destroy();
});
