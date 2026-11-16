import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const activity = path.join(here, '..', 'web', 'activity');
const cssDir = path.join(activity, 'css');
const jsDir = path.join(activity, 'js');

const TOTAL_CSS_BUDGET = 455000;
const FX_CSS_BUDGET = 20000;

const CHEAP_PROPS = new Set(['transform', 'opacity', 'translate', 'scale', 'rotate', 'visibility', 'animation-timing-function']);
const LAYOUT_PROPS = /(^|[\s,])(all|width|height|min-width|min-height|max-width|max-height|top|left|right|bottom|inset|margin[\w-]*|padding[\w-]*|flex[\w-]*|gap|font-size|line-height|grid[\w-]*|border-width)(?=[\s,]|$)/;
const PAINT_PROPS = /(^|[\s,])(box-shadow|filter|backdrop-filter|-webkit-backdrop-filter)(?=[\s,]|$)/;
const BIG_AREA = /(^|[\s.>-])(paper|frame|stage|side|backdrop|screen|shell|hero|book|layer|panel|sheet|aurora|motif|floor|grain|vignette|wrap|top|body|html|app)(?=$|[\s.:>[-])/;
const TINY_FILL = /-fill$/;
const FUNCTIONAL_LOOPS = new Set([
  '.spinner',
  '.pulse-dot',
  '.timer.is-low .timer-num',
  '.countdown.is-low .countdown-num',
  '.pcard-bone',
  '.pcard-badge.is-skeleton',
  '.lb-ghost-bar',
  '.signin-code-row.is-loading .signin-code',
]);
const TIMED_EFFECTS = new Set(['.shell.troll-shake', '.rain-drop', '.taco-drop']);
const TRANSIENT_WILL_CHANGE = new Set(['.juice-bit', '.react-float']);
const RAF_FILES = new Set(['ui/fxmode.js', 'views/draw.js', 'views/odd.js', 'views/reflex.js']);

function linkedSheets() {
  const html = readFileSync(path.join(activity, 'index.html'), 'utf8');
  return [...html.matchAll(/<link rel="stylesheet" href="\/activity\/css\/([^"]+)">/g)].map((m) => m[1]);
}

function splitTop(text, sep) {
  const out = [];
  let depth = 0;
  let buf = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === sep && depth === 0) {
      out.push(buf);
      buf = '';
    } else buf += ch;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

function parseCss(css, file, fileIdx) {
  const rules = [];
  const stack = [];
  let buf = '';
  let order = 0;
  let quote = null;
  for (const ch of css) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '{') {
      const head = buf.trim();
      const semi = head.lastIndexOf(';');
      stack.push(semi >= 0 ? head.slice(semi + 1).trim() : head);
      buf = '';
    } else if (ch === '}') {
      const sel = stack.pop();
      const body = buf.trim();
      buf = '';
      if (!body || sel.startsWith('@') || stack.some((a) => a.startsWith('@keyframes'))) continue;
      const decls = splitTop(body, ';').map((d) => {
        const i = d.indexOf(':');
        const value = d.slice(i + 1).trim();
        return { prop: d.slice(0, i).trim(), value: value.replace(/\s*!important$/, ''), important: /!important$/.test(value) };
      });
      rules.push({ file, fileIdx, order: order++, at: stack.slice(), selectors: splitTop(sel.replace(/\s+/g, ' '), ','), decls });
    } else buf += ch;
  }
  return rules;
}

function keyframesOf(css) {
  const out = new Map();
  for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      if (css[i] === '}') depth -= 1;
      i += 1;
    }
    out.set(m[1], new Set([...css.slice(start, i - 1).matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1])));
  }
  return out;
}

function specificity(sel) {
  let s = sel.replace(/:where\([^)]*\)/g, '');
  s = s.replace(/:(is|not|has)\(/g, ' (');
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const elements = (s.match(/::[\w-]+/g) || []).length;
  s = s.replace(/::[\w-]+/g, '');
  const classes = (s.match(/\.[\w-]+/g) || []).length + (s.match(/\[[^\]]+\]/g) || []).length + (s.match(/:[\w-]+/g) || []).length;
  const types = (s.replace(/\[[^\]]+\]/g, '').replace(/[.#:][\w-]+/g, '').match(/(^|[\s>+~(])[a-z][\w-]*/g) || []).length;
  return ids * 10000 + classes * 100 + elements + types;
}

function load() {
  const sheets = linkedSheets();
  const files = readdirSync(cssDir).filter((f) => f.endsWith('.css'));
  const rules = [];
  const frames = new Map();
  for (const file of files) {
    const css = readFileSync(path.join(cssDir, file), 'utf8');
    const idx = sheets.indexOf(file);
    rules.push(...parseCss(css, file, idx < 0 ? 999 : idx));
    for (const [k, v] of keyframesOf(css)) frames.set(k, { file, props: v });
  }
  return { sheets, files, rules, frames };
}

function plain(rule) {
  return !rule.at.some((a) => /prefers-reduced-motion/.test(a));
}

function liteWins(rule, sel, liteRule, liteSel) {
  const kill = liteRule.decls.find((d) => (d.prop === 'animation' || d.prop === 'animation-name') && d.value === 'none') || liteRule.decls.find((d) => d.prop === 'display' && d.value === 'none');
  if (!kill) return false;
  if (kill.important || kill.prop === 'display') return true;
  const a = specificity(liteSel);
  const b = specificity(sel);
  if (a !== b) return a > b;
  if (liteRule.fileIdx !== rule.fileIdx) return liteRule.fileIdx > rule.fileIdx;
  return liteRule.order > rule.order;
}

function infiniteLoops(rules) {
  const out = [];
  for (const r of rules) {
    if (!plain(r)) continue;
    for (const d of r.decls) {
      if ((d.prop === 'animation' || d.prop === 'animation-iteration-count') && /\binfinite\b/.test(d.value)) {
        for (const sel of r.selectors) out.push({ rule: r, sel, value: d.value });
      }
    }
  }
  return out;
}

function jsFiles(dir, base = '') {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...jsFiles(path.join(dir, ent.name), rel));
    else if (ent.name.endsWith('.js')) out.push({ rel, src: readFileSync(path.join(dir, ent.name), 'utf8') });
  }
  return out;
}

const all = load();

test('every activity stylesheet is linked and the total stays under the byte budget', () => {
  let total = 0;
  for (const f of all.files) total += readFileSync(path.join(cssDir, f), 'utf8').length;
  for (const f of all.files) assert.ok(all.sheets.includes(f), `${f} is linked`);
  assert.ok(total <= TOTAL_CSS_BUDGET, `activity css is ${total} bytes, budget ${TOTAL_CSS_BUDGET}`);
  assert.ok(readFileSync(path.join(cssDir, 'fx.css'), 'utf8').length <= FX_CSS_BUDGET);
});

test('keyframes only animate transform and opacity', () => {
  for (const [name, { file, props }] of all.frames) {
    for (const p of props) assert.ok(CHEAP_PROPS.has(p), `${file} @keyframes ${name} animates ${p}`);
  }
});

test('every animation names a keyframes block that exists', () => {
  const known = new Set([...all.frames.keys(), 'none', 'infinite', 'alternate', 'both', 'forwards', 'backwards', 'reverse', 'linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'normal', 'paused', 'running', 'alternate-reverse', 'step-start', 'step-end']);
  for (const r of all.rules) {
    for (const d of r.decls) {
      if (d.prop !== 'animation' && d.prop !== 'animation-name') continue;
      for (const part of splitTop(d.value, ',')) {
        const words = part.replace(/[\w-]+\([^)]*\)/g, ' ').split(/\s+/).filter((w) => /^[a-z][\w-]*$/.test(w));
        const name = words.find((w) => !known.has(w) || all.frames.has(w));
        if (!name || name.startsWith('var')) continue;
        assert.ok(all.frames.has(name), `${r.file} ${r.selectors.join(', ')} uses missing @keyframes ${name}`);
      }
    }
  }
});

test('nothing transitions layout properties, and big areas never transition shadows or filters', () => {
  for (const r of all.rules) {
    for (const d of r.decls) {
      if (d.prop !== 'transition' && d.prop !== 'transition-property') continue;
      if (d.value === 'none') continue;
      for (const part of splitTop(d.value, ',')) {
        const prop = part.split(/\s+/)[0];
        for (const sel of r.selectors) {
          if (LAYOUT_PROPS.test(` ${prop} `)) assert.ok(TINY_FILL.test(sel) && prop === 'width', `${r.file} ${sel} transitions ${prop}`);
          if (PAINT_PROPS.test(` ${prop} `)) assert.equal(BIG_AREA.test(sel), false, `${r.file} ${sel} transitions ${prop} on a big area`);
        }
      }
    }
  }
});

test('reduced motion turns every animation and transition off', () => {
  const css = readFileSync(path.join(cssDir, 'activity.css'), 'utf8');
  const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(block, /\*,\s*\*::before,\s*\*::after\s*\{\s*animation-duration: 1ms !important;\s*animation-iteration-count: 1 !important;\s*transition-duration: 1ms !important;/);
  for (const { rule } of infiniteLoops(all.rules)) {
    assert.ok(rule.fileIdx >= 0 && rule.fileIdx < 999, `${rule.file} is linked so the global rule reaches it`);
  }
});

test('lite mode stops every decorative loop and wins the cascade', () => {
  const loopClassed = new Set();
  for (const { src } of jsFiles(jsDir)) {
    for (const line of src.split('\n')) {
      if (!line.includes('fx-loop')) continue;
      for (const m of line.matchAll(/'([\w-]+)'/g)) loopClassed.add(m[1]);
      for (const m of line.matchAll(/class: '([^']+)'/g)) for (const c of m[1].split(/\s+/)) loopClassed.add(c);
      for (const m of line.matchAll(/'([\w\s-]+)'/g)) for (const c of m[1].split(/\s+/)) loopClassed.add(c);
    }
  }
  const lite = [];
  for (const r of all.rules) {
    if (!plain(r)) continue;
    for (const sel of r.selectors) if (sel.startsWith('[data-fx="lite"] ')) lite.push({ rule: r, sel, inner: sel.slice('[data-fx="lite"] '.length) });
  }
  const missed = [];
  for (const { rule, sel } of infiniteLoops(all.rules)) {
    if (FUNCTIONAL_LOOPS.has(sel) || TIMED_EFFECTS.has(sel)) continue;
    if (/^\.fx-(aurora|motif|floor|grain|vignette)|\.fx-motif$/.test(sel)) continue;
    const head = sel.split(' ').pop().replace(/::(before|after)$/, '');
    const classes = (head.match(/\.[\w-]+/g) || []).map((c) => c.slice(1));
    const viaLoop = classes.length > 0 && classes.every((c) => loopClassed.has(c));
    if (viaLoop) continue;
    const hit = lite.find((l) => l.inner === sel && liteWins(rule, sel, l.rule, l.sel));
    if (!hit) missed.push(`${rule.file} ${sel}`);
  }
  assert.deepEqual(missed, []);
  const fx = readFileSync(path.join(cssDir, 'fx.css'), 'utf8');
  assert.match(fx, /\[data-fx="lite"\] \.fx-loop,[\s\S]*?animation: none !important;/);
  assert.match(fx, /\[data-fx="lite"\] \{[^}]*--fx-depth-2:[^}]*--fx-num-shadow:/);
});

test('a hidden call pauses every animation at once', () => {
  const fx = readFileSync(path.join(cssDir, 'fx.css'), 'utf8');
  assert.match(fx, /\[data-fx-paused\] \*,\s*\[data-fx-paused\] \*::before,\s*\[data-fx-paused\] \*::after\s*\{\s*animation-play-state: paused !important;/);
});

test('backdrop blur is rare and lite turns every one off', () => {
  const blurs = [];
  for (const r of all.rules) {
    for (const d of r.decls) {
      if (d.prop !== 'backdrop-filter' || d.value === 'none') continue;
      for (const sel of r.selectors) blurs.push({ rule: r, sel });
    }
  }
  assert.ok(new Set(blurs.map((b) => b.sel)).size <= 3, `backdrop-filter on ${blurs.map((b) => b.sel).join(', ')}`);
  for (const b of blurs) {
    const off = all.rules.some((r) => r.selectors.includes(`[data-fx="lite"] ${b.sel}`) && r.decls.some((d) => d.prop === 'backdrop-filter' && d.value === 'none'));
    assert.ok(off, `lite keeps the blur on ${b.sel}`);
  }
});

test('will-change is only used on short-lived particles', () => {
  for (const r of all.rules) {
    if (!r.decls.some((d) => d.prop === 'will-change')) continue;
    for (const sel of r.selectors) assert.ok(TRANSIENT_WILL_CHANGE.has(sel), `${r.file} ${sel} keeps will-change`);
  }
});

test('frame loops go through the shared loop and every interval is cleared', () => {
  for (const { rel, src } of jsFiles(jsDir)) {
    if (/requestAnimationFrame\(/.test(src)) assert.ok(RAF_FILES.has(rel), `${rel} runs its own requestAnimationFrame loop`);
    if (/setInterval\(/.test(src)) assert.ok(/clearInterval\(/.test(src), `${rel} never clears its interval`);
    assert.equal(/style\.(width|height|top|left)\s*=/.test(src), false, `${rel} writes layout styles directly`);
  }
});

test('lite caps confetti, juice bits and floating text', async () => {
  const fxm = await import('../web/activity/js/ui/fxmode.js');
  const juice = await import('../web/activity/js/ui/juice.js');
  fxm.resetFxMode();
  assert.deepEqual(juice.juiceRoom('full'), { bits: juice.MAX_LIVE, floats: juice.MAX_FLOATS });
  assert.deepEqual(juice.juiceRoom('static'), { bits: 0, floats: 0 });
  const lite = juice.juiceRoom('lite');
  assert.ok(lite.bits <= fxm.LITE_PARTICLE_CAP);
  assert.ok(lite.floats < juice.MAX_FLOATS);
  assert.deepEqual(juice.juiceRoom(), juice.juiceRoom('full'));
  const mode = fxm.startFxMode({ win: { localStorage: { getItem: () => 'lite', setItem() {} }, navigator: {}, matchMedia: () => ({ matches: false }) }, probe: false });
  assert.equal(fxm.fxLevel(), 'lite');
  assert.deepEqual(juice.juiceRoom(), lite);
  mode.destroy();
  fxm.resetFxMode();
});

function fakeLoop() {
  const subs = new Set();
  return {
    add(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    step(ts = 16) {
      for (const fn of [...subs]) if (fn(ts, 16) === false) subs.delete(fn);
    },
    get size() {
      return subs.size;
    },
  };
}

function spotScene() {
  let reads = 0;
  const props = {};
  const el = {
    isConnected: true,
    getBoundingClientRect() {
      reads += 1;
      return { left: 10, top: 20 };
    },
    style: {
      setProperty(k, v) {
        props[k] = v;
      },
    },
  };
  const target = { closest: () => el };
  const handlers = {};
  const root = {
    addEventListener(t, fn) {
      handlers[t] = fn;
    },
    removeEventListener(t) {
      delete handlers[t];
    },
  };
  return { el, target, root, handlers, props, reads: () => reads };
}

test('the hover spotlight reads layout at most once per frame and sleeps in lite', async () => {
  const fxm = await import('../web/activity/js/ui/fxmode.js');
  const { createFx } = await import('../web/activity/js/ui/fx.js');
  fxm.resetFxMode();
  const loop = fakeLoop();
  const fx = createFx({ document: {}, matchMedia: () => ({ matches: false }) }, { loop });
  const s = spotScene();
  const stop = fx.spotlight(s.root);
  for (let i = 0; i < 6; i += 1) s.handlers.pointermove({ target: s.target, clientX: 50 + i, clientY: 60, pointerType: 'mouse' });
  assert.equal(s.reads(), 0);
  assert.equal(loop.size, 1);
  loop.step();
  assert.equal(s.reads(), 1);
  assert.equal(s.props['--mx'], '45px');
  assert.equal(s.props['--my'], '40px');
  assert.equal(loop.size, 0);
  s.handlers.pointermove({ target: s.target, clientX: 1, clientY: 1, pointerType: 'touch' });
  assert.equal(loop.size, 0);
  const mode = fxm.startFxMode({ win: { localStorage: { getItem: () => 'lite', setItem() {} }, navigator: {}, matchMedia: () => ({ matches: false }) }, probe: false });
  s.handlers.pointermove({ target: s.target, clientX: 5, clientY: 5, pointerType: 'mouse' });
  assert.equal(loop.size, 0);
  mode.destroy();
  fxm.resetFxMode();
  s.handlers.pointermove({ target: s.target, clientX: 5, clientY: 5, pointerType: 'mouse' });
  assert.equal(loop.size, 1);
  stop();
  assert.equal(loop.size, 0);
  assert.equal(s.handlers.pointermove, undefined);
});
