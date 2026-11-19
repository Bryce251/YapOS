import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, flush, FakeEvent } from './dom-shim.js';

const { document, window } = installDom({ url: 'https://dash.example.test/u/bea' });
document.documentElement = document.createElement('html');
if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const cp = await import('../web/js/colour-picker.js');
const { NAME_PALETTE } = await import('../web/js/profile-look.js');

function key(el, k, shift = false) {
  const e = new FakeEvent('keydown', { key: k, bubbles: true });
  e.shiftKey = shift;
  el.dispatchEvent(e);
  return e;
}

function pointer(el, type, x, y, extra = {}) {
  const e = new FakeEvent(type, { bubbles: true });
  e.clientX = x;
  e.clientY = y;
  e.pointerId = 7;
  Object.assign(e, extra);
  el.dispatchEvent(e);
  return e;
}

function memoryStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

function walk(node, out = []) {
  for (const c of node.childNodes || []) {
    out.push(c);
    walk(c, out);
  }
  return out;
}

function mounted(opts = {}) {
  const seen = [];
  const commits = [];
  const picker = cp.createColourPicker({ value: '#7c5cff', label: 'Name colour', storage: memoryStore(), onInput: (x) => seen.push(x), onCommit: (x) => commits.push(x), ...opts });
  const host = cp.colourRow(picker);
  document.body.appendChild(host);
  return { picker, host, seen, commits };
}

test('hex and hsv convert both ways without drifting', () => {
  for (let r = 0; r < 256; r += 17) {
    for (let g = 0; g < 256; g += 51) {
      for (let b = 0; b < 256; b += 15) {
        const hex = cp.rgbToHex({ r, g, b });
        assert.equal(cp.hsvToHex(cp.hexToHsv(hex)), hex, hex);
      }
    }
  }
  for (const p of NAME_PALETTE) assert.equal(cp.hsvToHex(cp.hexToHsv(p.hex)), p.hex);
  assert.deepEqual(cp.hexToHsv('#ff0000'), { h: 0, s: 100, v: 100 });
  assert.deepEqual(cp.hexToHsv('#000000'), { h: 0, s: 0, v: 0 });
  assert.equal(cp.hsvToHex({ h: 120, s: 100, v: 100 }), '#00ff00');
  assert.equal(cp.hsvToHex({ h: 360, s: 100, v: 100 }), '#ff0000', 'hue 360 wraps to red');
  assert.equal(cp.hexToHsv('nope'), null);
});

test('values are clamped so nothing out of range reaches a colour', () => {
  assert.equal(cp.clamp(150, 0, 100), 100);
  assert.equal(cp.clamp(-5, 0, 100), 0);
  assert.equal(cp.clamp(Number.NaN, 0, 100), 0);
  assert.equal(cp.clamp('x', 3, 9), 3);
  assert.deepEqual(cp.clampHsv({ h: 999, s: -1, v: 400 }), { h: 360, s: 0, v: 100 });
  assert.deepEqual(cp.clampHsv(null), { h: 0, s: 0, v: 0 });
  assert.equal(cp.hsvToHex({ h: -40, s: 300, v: 300 }), '#ff0000');
  assert.equal(cp.rgbToHex({ r: 300, g: -4, b: 12.6 }), '#ff000d');
  const rect = { left: 10, top: 20, width: 100, height: 50 };
  assert.deepEqual(cp.areaFromPoint(rect, 60, 45), { s: 50, v: 50 });
  assert.deepEqual(cp.areaFromPoint(rect, -500, 900), { s: 0, v: 0 });
  assert.deepEqual(cp.areaFromPoint(rect, 900, -900), { s: 100, v: 100 });
  assert.equal(cp.areaFromPoint({ left: 0, top: 0, width: 0, height: 0 }, 1, 1), null);
  assert.equal(cp.hueFromPoint(rect, 60), 180);
  assert.equal(cp.hueFromPoint(rect, 9999), 360);
  assert.equal(cp.hueFromPoint(rect, -9999), 0);
  assert.equal(cp.hueFromPoint(null, 3), null);
});

test('the hex box takes short and long codes, with or without #, and colour names', () => {
  assert.equal(cp.parseColour('#abc'), '#aabbcc');
  assert.equal(cp.parseColour('ABC'), '#aabbcc');
  assert.equal(cp.parseColour('#AaBbCc'), '#aabbcc');
  assert.equal(cp.parseColour(' 7c5cff '), '#7c5cff');
  assert.equal(cp.parseColour('teal'), '#008080');
  assert.equal(cp.parseColour('Rebecca Purple'), '#663399');
  assert.equal(cp.parseColour('hotpink'), '#ff69b4');
  assert.equal(cp.parseColour('rgb(255, 0, 128)'), '#ff0080');
  for (const bad of ['', '#12', '#12345', '#1234567', 'url(x)', 'red;}*{', 'transparent', 'expression(1)', 'rgb(300, 0, 0)', 'notacolour', null, 7, {}, 'a'.repeat(60)]) {
    assert.equal(cp.parseColour(bad), null, String(bad));
  }
});

test('arrow keys move the shade and hue, shift takes bigger steps, home and end jump', () => {
  const base = { h: 100, s: 50, v: 50 };
  assert.deepEqual(cp.moveArea(base, 'ArrowRight'), { h: 100, s: 51, v: 50 });
  assert.deepEqual(cp.moveArea(base, 'ArrowRight', true), { h: 100, s: 60, v: 50 });
  assert.deepEqual(cp.moveArea(base, 'ArrowUp', true), { h: 100, s: 50, v: 60 });
  assert.deepEqual(cp.moveArea(base, 'ArrowDown'), { h: 100, s: 50, v: 49 });
  assert.deepEqual(cp.moveArea(base, 'Home'), { h: 100, s: 0, v: 50 });
  assert.deepEqual(cp.moveArea({ h: 0, s: 99, v: 99 }, 'ArrowRight', true), { h: 0, s: 100, v: 99 }, 'clamped at the edge');
  assert.equal(cp.moveArea(base, 'a'), null);
  assert.deepEqual(cp.moveHue(base, 'ArrowLeft', true), { h: 90, s: 50, v: 50 });
  assert.deepEqual(cp.moveHue(base, 'End'), { h: 360, s: 50, v: 50 });
  assert.deepEqual(cp.moveHue({ h: 2, s: 1, v: 1 }, 'ArrowDown', true), { h: 0, s: 1, v: 1 });
  assert.equal(cp.moveHue(base, 'Tab'), null);
});

test('the picker opens as a dialog, its sliders answer the keyboard and Escape gives focus back', () => {
  const { picker, seen, commits } = mounted();
  const btn = picker.button;
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  assert.equal(picker.panel.hidden, true);
  btn.click();
  assert.equal(picker.isOpen, true);
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  assert.equal(picker.panel.getAttribute('role'), 'dialog');
  const area = picker.panel.querySelector('.cp-area');
  const hue = picker.panel.querySelector('.cp-hue');
  assert.equal(document.activeElement, area, 'focus moves into the picker');
  assert.equal(area.getAttribute('role'), 'slider');
  assert.equal(hue.getAttribute('role'), 'slider');
  const s0 = Number(area.getAttribute('aria-valuenow'));
  const e = key(area, 'ArrowLeft', true);
  assert.equal(e.defaultPrevented, true);
  assert.equal(Number(area.getAttribute('aria-valuenow')), s0 - 10);
  assert.match(area.getAttribute('aria-valuetext'), /^Saturation \d+%, brightness \d+%, #[0-9a-f]{6}$/);
  key(hue, 'Home');
  assert.equal(hue.getAttribute('aria-valuenow'), '0');
  key(hue, 'ArrowRight', true);
  assert.equal(hue.getAttribute('aria-valuenow'), '10');
  assert.match(hue.getAttribute('aria-valuetext'), /^Hue 10 degrees/);
  assert.ok(seen.length >= 3);
  assert.equal(seen[seen.length - 1], picker.value);
  assert.equal(picker.panel.style.props['--cp-h'], '2.78%');
  assert.match(picker.panel.style.props['--cp-x'], /%$/);
  assert.equal(picker.panel.style.props['--cp-colour'], picker.value);
  const esc = key(area, 'Escape');
  assert.equal(esc.defaultPrevented, true);
  assert.equal(picker.isOpen, false);
  assert.equal(picker.panel.hidden, true);
  assert.equal(document.activeElement, btn, 'focus goes back to the swatch button');
  assert.deepEqual(commits, [picker.value]);
});

test('clicking outside closes the picker without stealing focus, and clicks inside keep it open', () => {
  const listeners = [];
  const doc = { activeElement: null, addEventListener: (t, fn) => listeners.push([t, fn]), removeEventListener: (t, fn) => listeners.splice(listeners.findIndex((l) => l[1] === fn), 1) };
  const { picker } = mounted({ doc });
  picker.open();
  assert.equal(listeners.length, 1);
  const [, outside] = listeners[0];
  outside({ target: picker.panel.querySelector('.cp-hue') });
  assert.equal(picker.isOpen, true);
  const elsewhere = document.createElement('div');
  document.body.appendChild(elsewhere);
  elsewhere.focus();
  outside({ target: elsewhere });
  assert.equal(picker.isOpen, false);
  assert.equal(document.activeElement, elsewhere);
  assert.equal(listeners.length, 0, 'the document listener is removed');
});

test('dragging the square and the hue strip uses pointer capture and clamps to the edges', async () => {
  const frames = [];
  const { picker } = mounted({ frame: (fn) => frames.push(fn) });
  picker.open();
  const area = picker.panel.querySelector('.cp-area');
  const hue = picker.panel.querySelector('.cp-hue');
  const captured = [];
  area.setPointerCapture = (id) => captured.push(['set', id]);
  area.releasePointerCapture = (id) => captured.push(['release', id]);
  area.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 });
  hue.getBoundingClientRect = () => ({ left: 0, top: 0, width: 360, height: 14, right: 360, bottom: 14 });
  const down = pointer(area, 'pointerdown', 200, 0);
  assert.equal(down.defaultPrevented, true);
  assert.deepEqual(captured, [['set', 7]]);
  assert.equal(area.getAttribute('aria-valuenow'), '100');
  pointer(area, 'pointermove', -50, 500);
  pointer(area, 'pointermove', -60, 600);
  assert.equal(frames.length, 1, 'moves are folded into one frame');
  frames.shift()();
  assert.equal(picker.value, '#000000', 'past the corner is clamped to black');
  pointer(area, 'pointerup', 0, 100);
  assert.deepEqual(captured[1], ['release', 7]);
  pointer(area, 'pointermove', 100, 50);
  assert.equal(frames.length, 0, 'no drag after the pointer is up');
  picker.set('#ff0000');
  pointer(hue, 'pointerdown', 120, 5);
  assert.equal(hue.getAttribute('aria-valuenow'), '120');
  assert.equal(picker.value, '#00ff00');
  pointer(hue, 'pointerdown', 99, 5, { button: 2 });
  assert.equal(hue.getAttribute('aria-valuenow'), '120', 'right clicks are ignored');
  const css = readFileSync(new URL('../web/css/colour-picker.css', import.meta.url), 'utf8');
  assert.match(css, /\.cp-area \{[^}]*touch-action: none/);
  assert.match(css, /\.cp-hue \{[^}]*touch-action: none/);
});

test('the hex box inside the picker takes names and says when it cannot read a colour', () => {
  const { picker, seen } = mounted();
  picker.open();
  const hex = picker.panel.querySelector('.cp-hex');
  hex.value = 'tomato';
  hex.dispatchEvent(new FakeEvent('input'));
  assert.equal(picker.value, '#ff6347');
  assert.equal(seen[seen.length - 1], '#ff6347');
  hex.value = 'url(evil)';
  hex.dispatchEvent(new FakeEvent('input'));
  assert.equal(picker.value, '#ff6347', 'half typed text is not an error yet');
  hex.dispatchEvent(new FakeEvent('change'));
  assert.ok(hex.classList.contains('is-invalid'));
  assert.match(picker.panel.querySelector('.cp-note').textContent, /Try a code like/);
  hex.value = 'abc';
  const enter = key(hex, 'Enter');
  assert.equal(enter.defaultPrevented, true);
  assert.equal(picker.value, '#aabbcc');
  assert.equal(hex.classList.contains('is-invalid'), false);
  const swatches = picker.panel.querySelector('.cp-palette').querySelectorAll('.cp-pick');
  assert.equal(swatches.length, NAME_PALETTE.length);
  swatches[2].click();
  assert.equal(picker.value, NAME_PALETTE[2].hex);
  assert.equal(swatches[2].style.props['--sw'], NAME_PALETTE[2].hex);
  assert.equal(picker.panel.querySelector('.cp-chip-text').textContent, NAME_PALETTE[2].hex);
  assert.equal(picker.button.querySelector('.cp-swatch').style.props['--cp-colour'], NAME_PALETTE[2].hex);
});

test('recent colours keep the last 8, skip junk and still work when storage throws', () => {
  cp.forgetRecent();
  const store = memoryStore();
  for (const c of ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777', '#888888', '#999999', '#222222']) cp.pushRecent(store, c);
  const list = cp.readRecent(store);
  assert.equal(list.length, cp.RECENT_MAX);
  assert.equal(list[0], '#222222', 'a reused colour moves to the front');
  assert.equal(list.filter((c) => c === '#222222').length, 1);
  assert.equal(list.includes('#111111'), false, 'the oldest falls off');
  store.setItem(cp.RECENT_KEY, JSON.stringify(['#abcdef', 'url(x)', 5, '#ABCDEF', '#abcdef']));
  assert.deepEqual(cp.readRecent(store), ['#abcdef']);
  store.setItem(cp.RECENT_KEY, '{not json');
  cp.forgetRecent();
  assert.deepEqual(cp.readRecent(store), []);
  cp.forgetRecent();
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(cp.readRecent(broken), []);
  assert.deepEqual(cp.pushRecent(broken, 'teal'), ['#008080']);
  assert.deepEqual(cp.readRecent(broken), ['#008080'], 'kept for this visit even without storage');
  assert.deepEqual(cp.pushRecent(broken, 'nope'), ['#008080']);
  cp.forgetRecent();
  const full = { getItem: () => null, setItem() { throw new Error('quota'); } };
  cp.pushRecent(full, '#123456');
  assert.deepEqual(cp.readRecent(full), ['#123456']);
  cp.forgetRecent();
  const { picker } = mounted({ storage: broken });
  picker.open();
  assert.equal(picker.panel.querySelector('.cp-recent').parentNode.hidden, true, 'no recent row when there are none');
  key(picker.panel.querySelector('.cp-hue'), 'End');
  key(picker.panel.querySelector('.cp-area'), 'ArrowDown', true);
  const picked = picker.value;
  picker.close();
  picker.open();
  const recent = picker.panel.querySelector('.cp-recent').querySelectorAll('.cp-pick');
  assert.deepEqual(recent.map((b) => b.getAttribute('data-colour')), [picked]);
  assert.equal(picker.panel.querySelector('.cp-recent').parentNode.hidden, false);
  cp.forgetRecent();
});

test('the eyedropper button only shows when the browser has one', async () => {
  const plain = mounted({ win: {} });
  assert.equal(plain.picker.panel.querySelector('.cp-drop'), null);
  class EyeDropper {
    async open() {
      return { sRGBHex: '#0fa3a3' };
    }
  }
  const withDrop = mounted({ win: { EyeDropper } });
  const btn = withDrop.picker.panel.querySelector('.cp-drop');
  assert.ok(btn);
  btn.click();
  await flush();
  assert.equal(withDrop.picker.value, '#0fa3a3');
  class Cancelled {
    async open() {
      throw new Error('AbortError');
    }
  }
  const cancel = mounted({ win: { EyeDropper: Cancelled } });
  cancel.picker.panel.querySelector('.cp-drop').click();
  await flush();
  assert.equal(cancel.picker.value, '#7c5cff', 'cancelling keeps the colour');
});

test('the picker never writes a style attribute and its stylesheet is linked and phone friendly', () => {
  const { host, picker } = mounted();
  picker.open();
  for (const n of walk(host)) if (n.getAttribute) assert.equal(n.getAttribute('style'), null);
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="\/css\/colour-picker\.css">/);
  const css = readFileSync(new URL('../web/css/colour-picker.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(max-width: 560px\) \{\s*\.cp-pop \{[^}]*position: static/);
  assert.match(css, /\.cp-area-thumb \{[^}]*left: var\(--cp-x/);
  assert.match(css, /\.cp-hue-thumb \{[^}]*left: var\(--cp-h/);
  assert.equal(/url\(/.test(css), false);
  const js = readFileSync(new URL('../web/js/colour-picker.js', import.meta.url), 'utf8');
  assert.equal(/style\.(?!setProperty|removeProperty)[a-z]/i.test(js), false, 'colours go through custom properties only');
});
