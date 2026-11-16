import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { room } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import story, { KEY } from '../web/activity/js/games/story.js';
import { createStoryView } from '../web/activity/js/views/story.js';

const ROOT = new URL('../web/activity/', import.meta.url);
const GAMES = ['draw', 'odd', 'telephone', 'sketchduel', 'pixel', 'story', 'wyr', 'hottakes', 'truths', 'bluff'];

function read(rel) {
  return readFileSync(new URL(rel, ROOT), 'utf8');
}

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

test('the glowed-up game sheets only animate transform and opacity and never blur', () => {
  for (const g of GAMES) {
    const css = read(`css/${g}.css`);
    assert.equal(/backdrop-filter/.test(css), false, `${g}.css uses backdrop-filter`);
    assert.equal(/url\(|@import|@font-face/.test(css), false, g);
    for (const m of css.matchAll(/@keyframes\s+[\w-]+\s*\{([\s\S]*?)\n\}/g)) {
      for (const p of m[1].matchAll(/([a-z-]+)\s*:/g)) assert.ok(['transform', 'opacity'].includes(p[1]), `${g}.css keyframes animate ${p[1]}`);
    }
  }
});

test('every endless loop in these games stops in lite, static, hidden and reduced motion', () => {
  for (const g of GAMES) {
    const css = read(`css/${g}.css`);
    for (const m of css.matchAll(/([^{}]+)\{[^{}]*animation:[^;]*infinite/g)) {
      const sel = m[1].trim().split(',').pop().trim();
      const cls = sel.match(/\.([a-z][a-z0-9-]*)\s*$/)[1];
      const view = read(`js/views/${g}.js`);
      assert.match(view, new RegExp(`${cls} fx-loop`), `${g}: ${cls} loops without fx-loop`);
    }
  }
});

test('the bluff reveal beam is skipped in lite, static and reduced motion', () => {
  const css = read('css/bluff.css');
  assert.match(css, /\[data-fx="lite"\] \.bluff-hero\.is-reveal::after/);
  assert.match(css, /\[data-fx="static"\] \.bluff-hero\.is-reveal::after/);
  assert.match(css, /prefers-reduced-motion[\s\S]*\.bluff-hero\.is-reveal::after/);
});

test('hot takes lights the room during the reveal and cleans up when it closes', () => {
  const src = read('js/views/hottakes.js');
  assert.match(src, /app\.classList\.toggle\('fx-hot', on\)/);
  assert.match(src, /destroy\(\) \{\s*stopVoteTimer\(\);\s*heat\(false\);/);
  assert.match(read('css/hottakes.css'), /\.app\.fx-hot \.fx-aurora-1/);
});

test('the story writer gets the acting ring and the typing dots are a pausable loop', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(2, { games: [story] });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('story'), true);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  const views = r.engines.map((engine) => {
    const v = createStoryView({ engine, fx: { confetti() {} }, toast() {}, win: {}, cues: { play() {}, burst() {}, float() {} } });
    engine.on('change', (snap) => v.update(snap));
    v.update(engine.snapshot());
    return v;
  });
  const writer = r.hub.state[KEY].writer;
  for (const [i, v] of views.entries()) {
    const rings = all(v.el).filter((n) => n.classList && n.classList.contains('fx-acting'));
    assert.equal(rings.length, 1);
    assert.ok(rings[0].classList.contains('story-acting'));
    assert.ok(all(rings[0]).some((n) => n.classList && n.classList.contains('avatar-btn')));
    const dots = all(v.el).find((n) => n.classList && n.classList.contains('story-dots'));
    if (r.engines[i].snapshot().meSlot !== writer && dots) assert.ok(dots.classList.contains('fx-loop'));
    for (const n of all(v.el)) assert.equal(n.hasAttribute && n.hasAttribute('style'), false);
  }
  for (const v of views) v.destroy();
});
