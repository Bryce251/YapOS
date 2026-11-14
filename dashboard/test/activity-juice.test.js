import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, FakeEvent } from './dom-shim.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const activity = path.join(here, '..', 'web', 'activity');

const juice = await import('../web/activity/js/ui/juice.js');
const { burst, burstFrom, floatText, attachJuice, resetJuice, liveParticles, liveFloats, MAX_LIVE, PRESS_CLASS } = juice;

function setup({ reduce = false } = {}) {
  const dom = installDom({ url: 'https://yapos.dev/activity/' });
  dom.window.matchMedia = (q) => ({ matches: reduce && /reduce/.test(q), addEventListener() {}, removeEventListener() {} });
  resetJuice();
  return dom;
}

function all(node, out = []) {
  for (const c of node.childNodes || []) {
    if (c.localName) out.push(c);
    all(c, out);
  }
  return out;
}

function layerOf(doc) {
  return doc.body.querySelector('.juice-layer');
}

function bits(doc) {
  const layer = layerOf(doc);
  return layer ? layer.querySelectorAll('.juice-bit') : [];
}

function finishAll(doc, sel) {
  const layer = layerOf(doc);
  if (!layer) return;
  for (const el of layer.querySelectorAll(sel)) el.dispatchEvent(new FakeEvent('animationend'));
}

function fakeSfx() {
  const played = [];
  return { played, play(name) { played.push(name); } };
}

function press(el, opts = {}) {
  const e = new FakeEvent('pointerdown', { bubbles: true });
  e.clientX = opts.x ?? 40;
  e.clientY = opts.y ?? 60;
  el.dispatchEvent(e);
  return e;
}

function makeButton(doc, attrs = {}) {
  const b = doc.createElement('button');
  b.className = 'btn';
  for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
  const label = doc.createElement('span');
  label.textContent = 'Go';
  b.append(label);
  return b;
}

test('burst adds particles to a shared layer and removes them when they finish', () => {
  const { document } = setup();
  const n = burst(100, 120, { count: 9, emoji: ['🎉', '✨'] });
  assert.equal(n, 9);
  assert.equal(liveParticles(), 9);
  const layer = layerOf(document);
  assert.ok(layer);
  assert.equal(layer.getAttribute('aria-hidden'), 'true');
  assert.equal(bits(document).length, 9);
  for (const b of bits(document)) {
    assert.equal(b.style.props['--px'], '100px');
    assert.equal(b.style.props['--py'], '120px');
    assert.ok(b.style.props['--dx']);
    assert.ok(b.style.props['--dur']);
  }
  finishAll(document, '.juice-bit');
  assert.equal(bits(document).length, 0);
  assert.equal(liveParticles(), 0);
});

test('burst particles also clear on the timer fallback', async () => {
  const { document } = setup();
  burst(10, 10, { count: 3 });
  assert.equal(bits(document).length, 3);
  await new Promise((r) => setTimeout(r, 1800));
  assert.equal(bits(document).length, 0);
  assert.equal(liveParticles(), 0);
});

test('spam bursts never pass the live particle cap', () => {
  const { document } = setup();
  let made = 0;
  for (let i = 0; i < 200; i += 1) made += burst(i, i, { count: 12 });
  assert.equal(made, MAX_LIVE);
  assert.equal(liveParticles(), MAX_LIVE);
  assert.equal(bits(document).length, MAX_LIVE);
  assert.equal(burst(5, 5, { count: 5 }), 0);
  finishAll(document, '.juice-bit');
  assert.equal(liveParticles(), 0);
  assert.equal(burst(5, 5, { count: 5 }), 5);
});

test('reduced motion turns bursts and floating labels into no-ops', () => {
  const { document } = setup({ reduce: true });
  assert.equal(burst(50, 50, { count: 20 }), 0);
  const el = document.createElement('span');
  document.body.append(el);
  assert.equal(floatText(el, '+10'), null);
  assert.equal(burstFrom(el, { count: 4 }), 0);
  assert.equal(bits(document).length, 0);
  assert.equal(liveParticles(), 0);
});

test('floatText adds a label above the element and removes it after', () => {
  const { document } = setup();
  const el = document.createElement('span');
  document.body.append(el);
  const label = floatText(el, '+120', { tone: 'gold' });
  assert.ok(label);
  assert.equal(label.textContent, '+120');
  assert.ok(label.classList.contains('juice-float'));
  assert.ok(label.classList.contains('is-gold'));
  assert.equal(liveFloats(), 1);
  assert.equal(layerOf(document).querySelectorAll('.juice-float').length, 1);
  finishAll(document, '.juice-float');
  assert.equal(layerOf(document).querySelectorAll('.juice-float').length, 0);
  assert.equal(liveFloats(), 0);
});

test('attachJuice squishes buttons, bursts and plays the right sound', () => {
  const { document } = setup();
  const root = document.createElement('div');
  document.body.append(root);
  const sfx = fakeSfx();
  const plain = makeButton(document);
  const pressed = makeButton(document, { 'aria-pressed': 'false' });
  const radio = makeButton(document, { role: 'radio', 'aria-checked': 'true' });
  const tab = document.createElement('div');
  tab.setAttribute('role', 'tab');
  root.append(plain, pressed, radio, tab);
  const detach = attachJuice(root, { sfx });
  press(plain.firstChild);
  assert.ok(plain.classList.contains(PRESS_CLASS));
  assert.ok(bits(document).length > 0);
  assert.deepEqual(sfx.played, ['tap']);
  press(pressed);
  press(radio);
  press(tab);
  assert.deepEqual(sfx.played, ['tap', 'toggle', 'toggle', 'toggle']);
  const key = new FakeEvent('keydown', { bubbles: true, key: 'Enter' });
  plain.dispatchEvent(key);
  assert.deepEqual(sfx.played.slice(-1), ['tap']);
  detach();
  press(plain);
  assert.equal(sfx.played.length, 5);
});

test('attachJuice skips disabled and data-nojuice buttons and survives a broken sfx', () => {
  const { document } = setup();
  const root = document.createElement('div');
  document.body.append(root);
  const sfx = fakeSfx();
  const off = makeButton(document);
  off.disabled = true;
  const ariaOff = makeButton(document, { 'aria-disabled': 'true' });
  const quiet = makeButton(document, { 'data-nojuice': '' });
  const quietSet = makeButton(document);
  quietSet.dataset.nojuice = '';
  const plainDiv = document.createElement('div');
  root.append(off, ariaOff, quiet, quietSet, plainDiv);
  const detach = attachJuice(root, { sfx });
  for (const el of [off, ariaOff, quiet, quietSet, plainDiv]) press(el);
  assert.deepEqual(sfx.played, []);
  assert.equal(bits(document).length, 0);
  for (const el of [off, quiet]) assert.equal(el.classList.contains(PRESS_CLASS), false);
  detach();
  const broken = attachJuice(root, { sfx: { play() { throw new Error('no audio'); } } });
  const ok = makeButton(document);
  root.append(ok);
  assert.doesNotThrow(() => press(ok));
  broken();
  const none = attachJuice(root);
  assert.doesNotThrow(() => press(ok));
  none();
});

test('reduced motion keeps the sound but drops squish and particles', () => {
  const { document } = setup({ reduce: true });
  const root = document.createElement('div');
  document.body.append(root);
  const sfx = fakeSfx();
  const b = makeButton(document);
  root.append(b);
  const detach = attachJuice(root, { sfx });
  press(b);
  assert.deepEqual(sfx.played, ['tap']);
  assert.equal(b.classList.contains(PRESS_CLASS), false);
  assert.equal(bits(document).length, 0);
  detach();
});

test('juice never writes inline style attributes, only custom properties', () => {
  const { document } = setup();
  const root = document.createElement('div');
  document.body.append(root);
  const b = makeButton(document);
  root.append(b);
  const detach = attachJuice(root, { sfx: fakeSfx() });
  press(b);
  burst(1, 2, { count: 6, emoji: '⭐' });
  floatText(b, '+5');
  for (const el of all(document)) {
    assert.equal(el.hasAttribute('style'), false);
    for (const k of Object.keys(el.style.props)) assert.ok(k.startsWith('--'), k);
  }
  detach();
});

test('the board marks rank changes without changing its API', async () => {
  setup();
  const { board } = await import('../web/activity/js/ui/board.js');
  const base = [
    { id: 'a', name: 'A', initials: 'A', hue: 1, pts: 30, place: 1, slot: 0 },
    { id: 'b', name: 'B', initials: 'B', hue: 2, pts: 20, place: 2, slot: 1 },
    { id: 'c', name: 'C', initials: 'C', hue: 3, pts: 10, place: 3, slot: 2 },
    { id: 'd', name: 'D', initials: 'D', hue: 4, pts: 5, place: 4, slot: 3 },
    { id: 'e', name: 'E', initials: 'E', hue: 5, pts: 1, place: 5, slot: 4 },
  ];
  const first = board(base, { label: 'juice-test' });
  assert.equal(first.querySelectorAll('.is-climb').length, 0);
  const next = [
    { ...base[4], pts: 50, place: 1 },
    { ...base[0], place: 2 },
    { ...base[1], place: 3 },
    { ...base[2], place: 4 },
    { ...base[3], place: 5 },
  ];
  const second = board(next, { label: 'juice-test' });
  const climber = second.querySelector('.board-card.place-1');
  assert.ok(climber.classList.contains('is-climb'));
  assert.ok(climber.classList.contains('is-rankup'));
  assert.equal(climber.style.props['--shift'], '3');
  assert.ok(second.querySelector('.board-row.is-drop'));
  for (const el of [second, ...all(second)]) assert.equal(el.hasAttribute('style'), false);
});

test('index.html links juice.css after the other sheets and stays CSP safe', () => {
  const html = readFileSync(path.join(activity, 'index.html'), 'utf8');
  const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  assert.deepEqual(sheets.slice(-1), ['/activity/css/juice.css']);
  assert.ok(sheets.indexOf('/activity/css/activity.css') < sheets.indexOf('/activity/css/juice.css'));
  assert.equal(/style\s*=/.test(html), false);
  assert.equal(/<style/i.test(html), false);
  assert.equal(/\son[a-z]+\s*=/i.test(html), false);
  assert.equal(/https?:\/\//.test(html), false);
  const scripts = html.match(/<script[^>]*>[\s\S]*?<\/script>/g) || [];
  assert.equal(scripts.length, 1);
});

test('juice.css has its reduced motion block, no flashing and no outside resources', () => {
  const css = readFileSync(path.join(activity, 'css', 'juice.css'), 'utf8');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.equal(/url\(|@import|@font-face/.test(css), false);
  assert.equal(/infinite/.test(css), false);
  assert.equal(/\/\*/.test(css), false);
  for (const name of ['juice-fly', 'juice-float', 'juice-squish']) assert.match(css, new RegExp(`@keyframes ${name}\\b`));
});

test('the juice files carry no comments', () => {
  const files = ['js/ui/juice.js', 'js/ui/fx.js', 'js/ui/board.js', 'js/ui/lobby.js', 'js/ui/results.js', 'css/juice.css'];
  for (const f of files) {
    const src = readFileSync(path.join(activity, f), 'utf8');
    assert.equal(/^\s*\/\//m.test(src), false, f);
    assert.equal(/\/\*/.test(src), false, f);
  }
});
