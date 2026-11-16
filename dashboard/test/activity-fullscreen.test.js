import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, FakeEvent, flush } from './dom-shim.js';
import { room } from './activity-kit.test.js';
import {
  createFullscreen,
  screenKey,
  screenButton,
  readFocus,
  saveFocus,
  FOCUS_KEY,
  FOCUS_TOAST,
  ENTER_LABEL,
  EXIT_LABEL,
} from '../web/activity/js/ui/fullscreen.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const activity = path.join(here, '..', 'web', 'activity');

function memoryStore(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

function fakeWin(store = memoryStore()) {
  const listeners = new Map();
  return {
    localStorage: store,
    listeners,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    key(key, extra = {}) {
      const e = new FakeEvent('keydown');
      Object.assign(e, { key, target: extra.target || null }, extra);
      for (const fn of [...(listeners.get('keydown') || [])]) fn(e);
      return e;
    },
  };
}

function fakeDoc({ enabled = true, outcome = 'resolve' } = {}) {
  const listeners = new Map();
  const doc = {
    fullscreenEnabled: enabled,
    fullscreenElement: null,
    requests: 0,
    exits: 0,
    documentElement: {
      requestFullscreen() {
        doc.requests += 1;
        if (outcome === 'reject') return Promise.reject(new TypeError('Permissions check failed'));
        if (outcome === 'throw') throw new Error('nope');
        doc.fullscreenElement = doc.documentElement;
        doc.fire();
        return Promise.resolve();
      },
    },
    exitFullscreen() {
      doc.exits += 1;
      doc.fullscreenElement = null;
      doc.fire();
      return Promise.resolve();
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    fire() {
      for (const fn of [...(listeners.get('fullscreenchange') || [])]) fn({ type: 'fullscreenchange' });
    },
    listeners,
  };
  return doc;
}

function setup(opts = {}) {
  installDom({ url: 'https://yapos.dev/activity/' });
  const root = document.createElement('div');
  const win = opts.win || fakeWin(opts.store);
  const toasts = [];
  const changes = [];
  const fs = createFullscreen({ root, win, doc: opts.doc === undefined ? fakeDoc(opts) : opts.doc, toast: (t) => toasts.push(t), onChange: (m) => changes.push(m) });
  return { root, win, fs, toasts, changes };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test('real full screen is used when the page allows it and stays in sync with the browser', async () => {
  const doc = fakeDoc();
  const { root, fs, toasts, win, changes } = setup({ doc });
  assert.equal(fs.mode, 'off');
  fs.toggle();
  await flush();
  assert.equal(doc.requests, 1);
  assert.equal(fs.mode, 'full');
  assert.equal(root.classList.contains('is-full'), true);
  assert.equal(root.classList.contains('is-focus'), true);
  assert.deepEqual(toasts, []);
  assert.equal(win.localStorage.data.has(FOCUS_KEY), false, 'real full screen is not remembered');
  doc.fullscreenElement = null;
  doc.fire();
  assert.equal(fs.mode, 'off', 'leaving with the browser Esc key updates the button');
  assert.equal(root.classList.contains('is-full'), false);
  assert.equal(root.classList.contains('is-focus'), false);
  fs.toggle();
  await flush();
  fs.toggle();
  await flush();
  assert.equal(doc.exits, 1);
  assert.equal(fs.mode, 'off');
  assert.deepEqual(changes, ['full', 'off', 'full', 'off']);
});

test('focus mode takes over when the frame refuses full screen', async () => {
  for (const doc of [null, fakeDoc({ enabled: false }), fakeDoc({ outcome: 'reject' }), fakeDoc({ outcome: 'throw' }), { documentElement: {} }]) {
    const { root, fs, toasts, win } = setup({ doc });
    fs.toggle();
    await flush();
    assert.equal(fs.mode, 'focus');
    assert.equal(root.classList.contains('is-focus'), true);
    assert.equal(root.classList.contains('is-full'), false);
    assert.deepEqual(toasts, [FOCUS_TOAST]);
    assert.equal(win.localStorage.getItem(FOCUS_KEY), '1');
    if (doc && doc.fullscreenEnabled === false) assert.equal(doc.requests, 0);
    fs.toggle();
    assert.equal(fs.mode, 'off');
    assert.equal(root.classList.contains('is-focus'), false);
    assert.equal(win.localStorage.getItem(FOCUS_KEY), '0');
    fs.toggle();
    await flush();
    assert.equal(fs.mode, 'focus');
    assert.equal(toasts.length, 1, 'the explanation only shows the first time');
    fs.destroy();
    assert.equal(root.classList.contains('is-focus'), false);
  }
});

test('focus mode is remembered per viewer and survives broken storage', async () => {
  const kept = setup({ doc: null, store: memoryStore({ [FOCUS_KEY]: '1' }) });
  assert.equal(kept.fs.mode, 'focus');
  assert.equal(kept.root.classList.contains('is-focus'), true);
  assert.deepEqual(kept.toasts, []);
  const broken = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  const fresh = setup({ doc: null, store: broken });
  assert.equal(fresh.fs.mode, 'off');
  fresh.fs.toggle();
  assert.equal(fresh.fs.mode, 'focus');
  const denied = {};
  Object.defineProperty(denied, 'localStorage', { get() { throw new Error('denied'); } });
  assert.equal(readFocus(denied), false);
  assert.equal(saveFocus(denied, true), false);
  assert.equal(readFocus(null), false);
});

test('F toggles, Esc leaves focus mode, and typing or game keys are left alone', async () => {
  const { fs, win } = setup({ doc: null });
  win.key('f');
  await tick();
  assert.equal(fs.mode, 'focus');
  win.key('F');
  await tick();
  assert.equal(fs.mode, 'off');
  win.key('f', { target: { localName: 'input' } });
  win.key('f', { target: { localName: 'textarea' } });
  win.key('f', { target: { localName: 'div', isContentEditable: true } });
  win.key('f', { ctrlKey: true });
  win.key('f', { metaKey: true });
  win.key('f', { repeat: true });
  await tick();
  assert.equal(fs.mode, 'off');
  const guess = win.key('f');
  guess.preventDefault();
  await tick();
  assert.equal(fs.mode, 'off', 'a game that uses the letter keeps it');
  win.key('Escape');
  assert.equal(fs.mode, 'off');
  fs.toggle();
  assert.equal(fs.mode, 'focus');
  const shut = new FakeEvent('keydown');
  shut.key = 'Escape';
  shut.preventDefault();
  fs.onKey(shut);
  assert.equal(fs.mode, 'focus', 'an open dialog closes first');
  const esc = win.key('Escape', { target: { localName: 'input' } });
  assert.equal(fs.mode, 'off');
  assert.equal(esc.defaultPrevented, true);
  fs.destroy();
  assert.equal((win.listeners.get('keydown') || []).length, 0);
});

test('screenKey reads the shortcut keys', () => {
  assert.equal(screenKey({ key: 'f' }), 'toggle');
  assert.equal(screenKey({ key: 'Escape' }), 'leave');
  assert.equal(screenKey({ key: 'g' }), null);
  assert.equal(screenKey({ key: 'f', altKey: true }), null);
  assert.equal(screenKey({ key: 'f', target: { tagName: 'SELECT' } }), null);
  assert.equal(screenKey(null), null);
});

test('the full screen button has a clear label and icon', () => {
  installDom();
  let taps = 0;
  const off = screenButton('off', () => { taps += 1; });
  assert.equal(off.getAttribute('aria-label'), ENTER_LABEL);
  assert.equal(off.dataset.key, 'screen');
  assert.equal(off.getAttribute('style'), null);
  const svg = off.children[0];
  assert.equal(svg.localName, 'svg');
  assert.equal(svg.getAttribute('aria-hidden'), 'true');
  assert.equal(svg.children[0].localName, 'path');
  off.click();
  assert.equal(taps, 1);
  for (const mode of ['focus', 'full']) {
    const on = screenButton(mode, () => {});
    assert.equal(on.getAttribute('aria-label'), EXIT_LABEL);
    assert.equal(on.classList.contains('is-on'), true);
  }
});

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

test('the top bar shows the button next to sound and switches to focus mode in the call frame', async () => {
  const { window } = installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(2, { join: false });
  await r.clock.advance(500);
  const root = document.createElement('div');
  document.body.append(root);
  const win = Object.assign(window, {
    document,
    parent: window,
    innerWidth: 400,
    innerHeight: 700,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: () => 0,
    clearInterval: () => {},
  });
  const { mountApp } = await import('../web/activity/js/ui/app.js');
  const app = mountApp({ root, engine: r.engines[0], bridge: { close() {} }, win, juice: false });
  await r.clock.advance(300);
  const btn = byKey(root, 'screen');
  assert.ok(btn);
  const sound = byKey(root, 'sound');
  assert.equal(sound.parentNode, btn.parentNode);
  assert.equal(sound.parentNode.childNodes.indexOf(btn), sound.parentNode.childNodes.indexOf(sound) + 1);
  assert.equal(btn.getAttribute('aria-label'), 'Full screen');
  btn.click();
  await flush();
  assert.equal(app.fullscreen.mode, 'focus');
  assert.equal(root.classList.contains('is-focus'), true);
  assert.equal(byKey(root, 'screen').getAttribute('aria-label'), 'Exit full screen');
  assert.match(root.querySelector('.toasts').textContent, /Full screen isn't available here/);
  byKey(root, 'screen').click();
  assert.equal(root.classList.contains('is-focus'), false);
  assert.equal(byKey(root, 'screen').getAttribute('aria-label'), 'Full screen');
  app.destroy();
});

test('focus mode CSS keeps the game controls and scales drawings without hiding them', () => {
  const css = readFileSync(path.join(activity, 'css', 'fullscreen.css'), 'utf8');
  assert.equal(/\/\*/.test(css), false);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /100dvh/);
  assert.match(css, /aspect-ratio: 4 \/ 3/);
  assert.match(css, /\.pixel-frame/);
  const hidden = [...css.matchAll(/([^{}]+)\{\s*display: none;\s*\}/g)].map((m) => m[1].replace(/:not\([^)]*\)/g, '')).join(',');
  for (const keep of ['.draw-tools', '.guess-row', '.word-input', '.timer', '.draw-word', '.swatches', '.game-foot', '.join-row', '.btn-admin', '.ink-canvas', '.pixel-grid', '.draw-side', '.feed']) {
    assert.equal(hidden.includes(keep), false, `${keep} stays visible`);
  }
  assert.match(hidden, /\.score-card/);
  assert.match(hidden, /\.strip/);
  assert.match(css, /\.btn:not\(\.btn-admin\) \.btn-label/);
  const src = readFileSync(path.join(activity, 'js', 'ui', 'fullscreen.js'), 'utf8');
  assert.equal(/\/\/|\/\*/.test(src.replace(/https?:\/\/[^'"]+/g, '')), false);
});

function cssRules(src) {
  const out = [];
  let depth = 0;
  let buf = '';
  let sel = null;
  for (const ch of src) {
    if (ch === '{') {
      if (depth === 0) sel = buf.trim();
      depth += 1;
      buf = '';
    } else if (ch === '}') {
      if (depth === 1 && sel && !sel.startsWith('@')) out.push([sel, buf]);
      depth -= 1;
      buf = '';
    } else {
      buf += ch;
    }
  }
  return out;
}

function compoundMatch(el, c) {
  const re = /:not\(([^)]*)\)|\.([A-Za-z0-9_-]+)|\[([a-z-]+)='([^']*)'\]|^([a-z]+)/g;
  let m;
  while ((m = re.exec(c))) {
    if (m[1] !== undefined) {
      if (compoundMatch(el, m[1])) return false;
    } else if (m[2]) {
      if (!el.classList || !el.classList.contains(m[2])) return false;
    } else if (m[3]) {
      if (el.getAttribute(m[3]) !== m[4]) return false;
    } else if (m[5] && el.localName !== m[5]) {
      return false;
    }
  }
  return true;
}

function selectorMatch(el, sel) {
  const parts = sel.trim().split(/\s+/);
  if (!compoundMatch(el, parts[parts.length - 1])) return false;
  let i = parts.length - 2;
  for (let n = el.parentNode; i >= 0 && n; n = n.parentNode) if (n.localName && compoundMatch(n, parts[i])) i -= 1;
  return i < 0;
}

function lostControls(root, selectors) {
  const lost = [];
  for (const el of all(root)) {
    if (!selectors.some((s) => selectorMatch(el, s))) continue;
    for (const x of [el, ...all(el)]) {
      if (['input', 'textarea', 'select', 'canvas', 'button'].includes(x.localName) || x.classList.contains('pixel-grid')) lost.push(`${el.getAttribute('class')} hides ${x.localName}.${x.getAttribute('class') || ''}`);
    }
  }
  return lost;
}

test('focus mode never hides a button, field or canvas in the lobby, the drawing games, a word game or the results', async () => {
  const { window } = installDom({ url: 'https://yapos.dev/activity/' });
  const hide = cssRules(readFileSync(path.join(activity, 'css', 'fullscreen.css'), 'utf8'))
    .filter(([, body]) => /display:\s*none/.test(body))
    .flatMap(([s]) => s.split(',').map((x) => x.trim()));
  const r = room(4);
  await r.clock.advance(500);
  const win = Object.assign(window, {
    document,
    parent: window,
    innerWidth: 400,
    innerHeight: 700,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: () => 0,
    clearInterval: () => {},
  });
  const { mountApp } = await import('../web/activity/js/ui/app.js');
  const views = r.engines.slice(0, 2).map((engine) => {
    const root = document.createElement('div');
    root.classList.add('app');
    document.body.append(root);
    return { root, app: mountApp({ root, engine, bridge: { close() {} }, win, juice: false }) };
  });
  for (const v of views) v.app.fullscreen.enter();
  await r.clock.advance(300);
  const lost = new Set();
  const seen = new Set();
  const check = (where) => {
    for (const v of views) {
      assert.equal(v.root.classList.contains('is-focus'), true);
      for (const x of lostControls(v.root, hide)) lost.add(`${where}: ${x}`);
    }
  };
  check('lobby');
  for (const id of ['draw', 'odd', 'sketchduel', 'telephone', 'pixel', 'hangman']) {
    r.engines[0].lobby.pick(id);
    await r.clock.advance(300);
    r.engines[0].lobby.start();
    for (let i = 0; i < 48; i += 1) {
      await r.clock.advance(2500);
      const game = views[0].root.querySelector('.game');
      seen.add(`${id}:${views[0].root.dataset.phase}:${game && game.dataset.phase ? game.dataset.phase : ''}`);
      check(id);
    }
    r.engines[0].lobby.end();
    await r.clock.advance(500);
    assert.equal(views[0].root.dataset.phase, 'results');
    check(`${id} results`);
    r.engines[0].lobby.end();
    await r.clock.advance(500);
  }
  assert.deepEqual([...lost], []);
  for (const want of ['draw:game:draw', 'draw:game:reveal', 'odd:game:draw', 'sketchduel:game:draw', 'telephone:game:draw']) assert.ok(seen.has(want), `${want} was reached`);
  for (const v of views) v.app.destroy();
});
