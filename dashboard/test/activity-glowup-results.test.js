import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom } from './dom-shim.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const activity = path.join(here, '..', 'web', 'activity');

const SHEETS = ['results.css', 'leaderboard.css', 'tournament.css', 'profilecard.css', 'signin.css', 'games.css'];

function sheet(name) {
  return readFileSync(path.join(activity, 'css', name), 'utf8');
}

function fakeRaf() {
  const queue = [];
  let id = 0;
  let now = 0;
  return {
    requestAnimationFrame(fn) {
      id += 1;
      queue.push({ id, fn });
      return id;
    },
    cancelAnimationFrame(n) {
      const i = queue.findIndex((q) => q.id === n);
      if (i >= 0) queue.splice(i, 1);
    },
    step(ms = 16) {
      now += ms;
      const run = queue.splice(0, queue.length);
      for (const q of run) q.fn(now);
      return run.length;
    },
    get pending() {
      return queue.length;
    },
  };
}

function fakeCtx() {
  const calls = { clear: 0, rect: 0, arc: 0 };
  return {
    calls,
    setTransform() {},
    clearRect() {
      calls.clear += 1;
    },
    fillRect() {
      calls.rect += 1;
    },
    beginPath() {},
    arc() {
      calls.arc += 1;
    },
    fill() {},
    fillStyle: '',
  };
}

function fakeWin({ reduced = false } = {}) {
  const raf = fakeRaf();
  const made = [];
  const ctx = fakeCtx();
  const doc = {
    hidden: false,
    visibilityState: 'visible',
    body: { append(el) { el.parentNode = this; } },
    createElement(tag) {
      const classes = new Set();
      const el = {
        tag,
        className: '',
        width: 0,
        height: 0,
        attrs: {},
        style: { setProperty() {} },
        classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
        setAttribute(k, v) {
          this.attrs[k] = v;
        },
        getContext: () => ctx,
        remove() {
          this.parentNode = null;
        },
      };
      made.push(el);
      return el;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return {
    raf,
    made,
    ctx,
    win: {
      document: doc,
      innerWidth: 400,
      innerHeight: 600,
      devicePixelRatio: 3,
      matchMedia: () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }),
      requestAnimationFrame: raf.requestAnimationFrame,
      cancelAnimationFrame: raf.cancelAnimationFrame,
      setTimeout: () => 0,
      clearTimeout() {},
      localStorage: { getItem: () => null, setItem() {} },
      navigator: {},
    },
  };
}

test('the glow-up sheets only animate transform and opacity, carry no comments and use no angle properties', () => {
  for (const name of SHEETS) {
    const css = sheet(name);
    assert.equal(/\/\*|url\(|@import|@font-face/.test(css), false, name);
    assert.equal(/@property/.test(css), false, `${name} has no @property`);
    assert.equal(/backdrop-filter/.test(css), false, `${name} has no backdrop blur`);
    for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\s*\}\n/g)) {
      const props = [...m[2].matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]);
      for (const p of props) assert.ok(['transform', 'opacity'].includes(p), `${name} ${m[1]} animates ${p}`);
    }
  }
});

test('every endless loop in the glow-up sheets stops in static mode and pauses when hidden', () => {
  for (const name of ['results.css', 'leaderboard.css', 'tournament.css', 'profilecard.css', 'signin.css']) {
    const css = sheet(name);
    assert.match(css, /\[data-fx-paused\]/, name);
    assert.match(css, /\[data-fx="static"\]/, name);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, name);
  }
  const results = sheet('results.css');
  assert.match(results, /\[data-fx="lite"\] \.avatar-btn\.ring-glow::before/);
  assert.match(results, /@media \(prefers-reduced-motion: no-preference\) \{\n  \.results-wrap\.juice-podium/);
  assert.equal(/results-breathe|results-ring|--angle/.test(results), false);
  assert.equal(/refuse-tint/.test(sheet('games.css')), false);
  assert.equal(/lb-shimmer/.test(sheet('leaderboard.css')), false);
  assert.equal(/pcard-shimmer|pcard-spin|--pcard-angle/.test(sheet('profilecard.css')), false);
  assert.equal(/signin-spin\b|--signin-angle/.test(sheet('signin.css')), false);
});

test('the podium puts second, first and third in place and rises third to first', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const { podiumRows, podiumCard, announce } = await import('../web/activity/js/ui/results.js');
  const rows = [
    { id: 'a', name: 'Pip', pts: 900, place: 1, slot: 0, initials: 'P', hue: 10 },
    { id: 'b', name: 'Juno', pts: 500, place: 2, slot: 1, initials: 'J', hue: 20 },
    { id: 'c', name: 'Ash', pts: 200, place: 3, slot: 2, initials: 'A', hue: 30 },
    { id: 'd', name: 'Bo', pts: 0, place: 4, slot: 3, initials: 'B', hue: 40 },
  ];
  assert.deepEqual(podiumRows(rows).map((r) => [r.name, r.step]), [['Juno', 2], ['Pip', 1], ['Ash', 3]]);
  assert.deepEqual(podiumRows(rows.slice(0, 1)), []);
  assert.deepEqual(podiumRows([rows[0], rows[1]]).map((r) => r.step), [2, 1]);
  const el = podiumCard(rows);
  assert.equal(el.getAttribute('aria-hidden'), 'true');
  const steps = el.querySelectorAll('.podium-step');
  assert.equal(steps.length, 3);
  assert.equal(steps[1].className.includes('step-1'), true);
  assert.equal(steps[1].style.props['--i'], '2');
  assert.equal(steps[2].style.props['--i'], '0');
  assert.equal(steps[1].querySelector('.podium-pts').textContent, '900');
  for (const n of [el, ...el.querySelectorAll('*')]) assert.equal(n.hasAttribute('style'), false);
  assert.equal(announce({ winners: ['Pip'], iWon: false, round: rows }), 'Pip wins with 900 points.');
  assert.equal(announce({ winners: ['Pip'], iWon: true, round: rows }), 'You win with 900 points.');
  assert.equal(announce({ winners: [], iWon: false, round: [] }), 'No winner this time.');
  assert.match(announce({ winners: ['Pip', 'Juno'], iWon: false, round: rows }), /Pip and Juno tie! Pip, Juno\./);
});

test('confetti is pooled, capped at the shared particle cap and limited to one big burst every 3 seconds', async () => {
  const fxm = await import('../web/activity/js/ui/fxmode.js');
  fxm.resetFxMode();
  const { createFx, CONFETTI_MAX, BURST_GAP_MS } = await import('../web/activity/js/ui/fx.js');
  assert.equal(CONFETTI_MAX, fxm.PARTICLE_CAP);
  const { win, raf } = fakeWin();
  const loop = fxm.createLoop(win, win.document);
  let t = 10000;
  const fx = createFx(win, { loop, now: () => t });
  assert.equal(fx.confetti(500), true);
  assert.equal(fx.live(), CONFETTI_MAX);
  assert.equal(raf.pending, 1);
  t += 500;
  fx.confetti(60);
  assert.equal(fx.live(), CONFETTI_MAX, 'a second burst inside the gap adds nothing');
  for (let i = 0; i < 400 && fx.live(); i += 1) raf.step(16);
  assert.equal(fx.live(), 0);
  assert.equal(raf.pending, 0, 'the loop stops when the last particle falls off');
  assert.equal(loop.size, 0);
  t += BURST_GAP_MS;
  assert.equal(fx.confetti(30), true);
  assert.equal(fx.live(), 30);
  fx.clear();
  assert.equal(fx.live(), 0);
  assert.equal(loop.size, 0);
  fx.destroy();
});

test('confetti draws nothing in static mode and the lite cap is smaller', async () => {
  const fxm = await import('../web/activity/js/ui/fxmode.js');
  const { createFx } = await import('../web/activity/js/ui/fx.js');
  const still = fakeWin({ reduced: true });
  const mode = fxm.startFxMode({ win: still.win, root: { dataset: {} }, probe: false });
  assert.equal(mode.level, 'static');
  const fx = createFx(still.win, { loop: fxm.createLoop(still.win, still.win.document) });
  assert.equal(fx.confetti(60), false);
  assert.equal(still.made.length, 0, 'no canvas is made');
  mode.destroy();
  const lite = fakeWin();
  lite.win.localStorage.getItem = () => 'lite';
  const liteMode = fxm.startFxMode({ win: lite.win, root: { dataset: {} }, probe: false });
  assert.equal(liteMode.level, 'lite');
  const fx2 = createFx(lite.win, { loop: fxm.createLoop(lite.win, lite.win.document) });
  fx2.confetti(500);
  assert.equal(fx2.live(), fxm.LITE_PARTICLE_CAP);
  assert.equal(lite.made[0].width, Math.round(400 * 1.5), 'lite mode caps the canvas pixel ratio');
  fx2.destroy();
  liteMode.destroy();
  fxm.resetFxMode();
});

test('the results reveal is skippable, announced once and the awards lift on hover', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const src = readFileSync(path.join(activity, 'js', 'ui', 'results.js'), 'utf8');
  assert.match(src, /'is-cinema'/);
  assert.match(src, /classList\.add\('is-revealed'\)/);
  assert.match(src, /'aria-live': 'polite'/);
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'cssText', 'requestAnimationFrame']) assert.equal(src.includes(bad), false, bad);
  const fxsrc = readFileSync(path.join(activity, 'js', 'ui', 'fx.js'), 'utf8');
  assert.equal(fxsrc.includes('requestAnimationFrame('), false, 'confetti runs on the shared loop');
  const { awardsCard } = await import('../web/activity/js/ui/awards.js');
  const card = awardsCard([{ emoji: '🏅', title: 'Duelist', why: '', who: [{ id: 'a', name: 'Pip', initials: 'P', hue: 1, isMe: false }], mine: false }]);
  assert.ok(card.querySelector('.award').className.includes('fx-lift'));
});
