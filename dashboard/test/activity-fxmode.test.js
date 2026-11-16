import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const activity = path.join(here, '..', 'web', 'activity');

const fxm = await import('../web/activity/js/ui/fxmode.js');
const { liteHint, probeSlow, resolveLevel, nextPref, fxButtonModel, particleCap, createLoop, countTo, mountBackdrop, startFxMode, resetFxMode, fxLevel, FX_STORE_KEY, PARTICLE_CAP, LITE_PARTICLE_CAP } = fxm;

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

function fakeDoc() {
  const listeners = {};
  return {
    hidden: false,
    visibilityState: 'visible',
    documentElement: { dataset: {} },
    addEventListener(t, fn) {
      (listeners[t] ||= []).push(fn);
    },
    removeEventListener(t, fn) {
      listeners[t] = (listeners[t] || []).filter((f) => f !== fn);
    },
    fire(t) {
      for (const fn of listeners[t] || []) fn();
    },
    count(t) {
      return (listeners[t] || []).length;
    },
    createElement(tag) {
      const el = { tag, className: '', attrs: {}, children: [], setAttribute(k, v) { this.attrs[k] = v; }, append(c) { this.children.push(c); } };
      return el;
    },
  };
}

function fakeWin({ reduce = false, nav = {}, store = {} } = {}) {
  const raf = fakeRaf();
  const doc = fakeDoc();
  return {
    raf,
    document: doc,
    navigator: nav,
    requestAnimationFrame: raf.requestAnimationFrame,
    cancelAnimationFrame: raf.cancelAnimationFrame,
    matchMedia: (q) => ({ matches: reduce && /reduce/.test(q), addEventListener() {}, removeEventListener() {} }),
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v);
      },
    },
    timers: [],
    setTimeout(fn) {
      this.timers.push(fn);
      return this.timers.length;
    },
    clearTimeout() {},
  };
}

test('slow device hints pick lite: save data, few cores, little memory', () => {
  assert.equal(liteHint({ connection: { saveData: true }, hardwareConcurrency: 16 }), 'save-data');
  assert.equal(liteHint({ hardwareConcurrency: 4 }), 'cores');
  assert.equal(liteHint({ hardwareConcurrency: 8, deviceMemory: 2 }), 'memory');
  assert.equal(liteHint({ hardwareConcurrency: 8, deviceMemory: 8 }), null);
  assert.equal(liteHint(null), null);
});

test('the frame probe flags janky frames and ignores too few samples', () => {
  assert.equal(probeSlow(Array(30).fill(16.7)), false);
  assert.equal(probeSlow(Array(30).fill(33)), true);
  assert.equal(probeSlow([...Array(24).fill(16), ...Array(6).fill(80)]), false);
  assert.equal(probeSlow([...Array(20).fill(16), ...Array(10).fill(80)]), true);
  assert.equal(probeSlow([40, 40]), false);
});

test('levels: reduced motion wins, then the manual choice, then auto detection', () => {
  assert.equal(resolveLevel({ pref: 'full', reduced: true }), 'static');
  assert.equal(resolveLevel({ pref: 'full', hint: 'cores' }), 'full');
  assert.equal(resolveLevel({ pref: 'lite' }), 'lite');
  assert.equal(resolveLevel({ pref: 'auto', hint: 'memory' }), 'lite');
  assert.equal(resolveLevel({ pref: 'auto', slow: true }), 'lite');
  assert.equal(resolveLevel({ pref: 'weird' }), 'full');
  assert.equal(nextPref('auto'), 'full');
  assert.equal(nextPref('full'), 'lite');
  assert.equal(nextPref('lite'), 'auto');
  assert.equal(particleCap('full'), PARTICLE_CAP);
  assert.equal(particleCap('lite'), LITE_PARTICLE_CAP);
  assert.equal(particleCap('static'), 0);
  assert.ok(PARTICLE_CAP <= 120);
});

test('the effects button model names the mode for screen readers', () => {
  const m = fxButtonModel('auto', 'lite');
  assert.equal(m.label, 'Effects: Auto (Lite)');
  assert.equal(m.pressed, false);
  assert.equal(fxButtonModel('full', 'full').label, 'Effects: Full');
  assert.match(fxButtonModel('auto', 'static').title, /reduced motion/);
});

test('one shared frame loop runs only while something needs it', () => {
  const raf = fakeRaf();
  const loop = createLoop(raf, { hidden: false });
  let a = 0;
  let b = 0;
  const offA = loop.add(() => {
    a += 1;
    return a < 3;
  });
  loop.add(() => {
    b += 1;
    return b < 2;
  });
  assert.equal(raf.pending, 1);
  raf.step();
  assert.equal(raf.pending, 1, 'two subscribers share one frame request');
  raf.step();
  raf.step();
  assert.equal(a, 3);
  assert.equal(b, 2);
  assert.equal(loop.size, 0);
  assert.equal(raf.pending, 0, 'the loop stops when idle');
  offA();
  const doc = { hidden: true };
  const paused = createLoop(raf, doc);
  paused.add(() => true);
  assert.equal(raf.pending, 0, 'nothing runs while the page is hidden');
  doc.hidden = false;
  paused.wake();
  assert.equal(raf.pending, 1);
  paused.clear();
  assert.equal(raf.pending, 0);
});

test('countTo eases to the final number on the shared loop and snaps when static', () => {
  resetFxMode();
  const raf = fakeRaf();
  const loop = createLoop(raf, { hidden: false });
  const el = { textContent: '', isConnected: true };
  countTo(el, 100, { from: 0, ms: 100, loop });
  assert.equal(el.textContent, '0');
  for (let i = 0; i < 10; i += 1) raf.step(16);
  assert.equal(el.textContent, '100');
  assert.equal(raf.pending, 0);
  const now = { textContent: '' };
  countTo(now, 7, { loop });
  assert.equal(now.textContent, '7');
});

test('startFxMode tags the root, remembers the manual choice and pauses when hidden', () => {
  resetFxMode();
  const store = {};
  const win = fakeWin({ nav: { hardwareConcurrency: 2 }, store });
  const mode = startFxMode({ win, probe: false });
  const root = win.document.documentElement;
  assert.equal(root.dataset.fx, 'lite');
  assert.equal(fxLevel(), 'lite');
  const seen = [];
  mode.onChange((l) => seen.push(l));
  mode.setPref('full');
  assert.equal(root.dataset.fx, 'full');
  assert.equal(store[FX_STORE_KEY], 'full');
  assert.deepEqual(seen, ['full']);
  win.document.hidden = true;
  win.document.fire('visibilitychange');
  assert.equal(root.dataset.fxPaused, 'on');
  win.document.hidden = false;
  win.document.fire('visibilitychange');
  assert.equal(root.dataset.fxPaused, undefined);
  mode.destroy();
  assert.equal(root.dataset.fx, undefined);
  assert.equal(win.document.count('visibilitychange'), 0);
  const again = startFxMode({ win: fakeWin({ store }), probe: false });
  assert.equal(again.pref, 'full');
  again.destroy();
  const still = startFxMode({ win: fakeWin({ reduce: true, store }), probe: false });
  assert.equal(still.level, 'static');
  still.destroy();
  resetFxMode();
});

test('a broken storage never stops the effects mode', () => {
  resetFxMode();
  const win = fakeWin();
  win.localStorage = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  const mode = startFxMode({ win, probe: false });
  assert.equal(mode.pref, 'auto');
  assert.equal(mode.setPref('lite'), 'lite');
  mode.destroy();
  resetFxMode();
});

test('the backdrop is plain decorative spans', () => {
  const doc = fakeDoc();
  const el = mountBackdrop(doc);
  assert.equal(el.className, 'fx-backdrop');
  assert.equal(el.attrs['aria-hidden'], 'true');
  assert.deepEqual(el.children.map((c) => c.className), ['fx-aurora fx-aurora-1', 'fx-aurora fx-aurora-2', 'fx-aurora fx-aurora-3', 'fx-floor', 'fx-motif', 'fx-grain', 'fx-vignette']);
});

test('fx.css is linked right after tokens.css and keeps to the performance budget', () => {
  const html = readFileSync(path.join(activity, 'index.html'), 'utf8');
  const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  assert.equal(sheets.indexOf('/activity/css/fx.css'), sheets.indexOf('/activity/css/tokens.css') + 1);
  const css = readFileSync(path.join(activity, 'css', 'fx.css'), 'utf8');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\[data-fx="lite"\]/);
  assert.match(css, /\[data-fx="static"\]/);
  assert.match(css, /\[data-fx-paused\]/);
  assert.equal(/\/\*|url\(|@import|@font-face/.test(css), false);
  for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g)) {
    const props = [...m[2].matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]);
    for (const p of props) assert.ok(['transform', 'opacity'].includes(p), `${m[1]} animates ${p}`);
  }
  assert.ok(css.length < 20000, 'fx.css stays small');
  for (const id of ['trivia', 'draw', 'chain', 'wyr', 'odd', 'telephone', 'scramble', 'hive', 'emoji', 'hottakes', 'truths', 'reflex', 'bluff', 'pixel', 'higherlower', 'sketchduel', 'story', 'hangman', 'musicquiz']) {
    assert.ok(css.includes(`[data-game="${id}"] { --fx-b:`), `${id} has a second backdrop colour`);
    assert.ok(css.includes(`[data-game="${id}"] .fx-motif`), `${id} has a backdrop motif`);
  }
});

test('fxmode.js has no comments, inline styles or forbidden calls', () => {
  const src = readFileSync(path.join(activity, 'js', 'ui', 'fxmode.js'), 'utf8');
  assert.equal(/^\s*\/\/|\/\*/m.test(src), false);
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'cssText']) assert.equal(src.includes(bad), false, bad);
});
