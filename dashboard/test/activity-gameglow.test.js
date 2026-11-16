import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom } from './dom-shim.js';
import { h } from '../web/activity/js/ui/dom.js';
import { koBar } from '../web/activity/js/views/knockout.js';
import { createHigherlowerView } from '../web/activity/js/views/higherlower.js';
import { createReflexView } from '../web/activity/js/views/reflex.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const activity = path.join(here, '..', 'web', 'activity');
const SHEETS = ['higherlower', 'emoji', 'musicquiz', 'reflex', 'chain', 'scramble', 'hive', 'hangman'];
const VIEWS = ['trivia', 'emoji', 'musicquiz', 'higherlower', 'reflex', 'knockout', 'chain', 'scramble', 'hive', 'hangman'];

function css(name) {
  return readFileSync(path.join(activity, 'css', `${name}.css`), 'utf8');
}

test('game sheets only animate transform and opacity and honour static mode', () => {
  for (const name of SHEETS) {
    const src = css(name);
    assert.equal(/\/\*|url\(|@import|@font-face|backdrop-filter/.test(src), false, name);
    for (const m of src.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g)) {
      const props = [...m[2].matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]);
      for (const p of props) assert.ok(['transform', 'opacity'].includes(p), `${name} ${m[1]} animates ${p}`);
    }
    assert.match(src, /\[data-fx="static"\]/, `${name} has a static mode`);
    assert.match(src, /@media \(prefers-reduced-motion: reduce\)/, `${name} has reduced motion`);
    assert.equal(/will-change/.test(src), false, name);
  }
});

test('infinite loops in game sheets stop in lite and static and pause when hidden', () => {
  const chain = css('chain');
  assert.match(chain, /\[data-fx="lite"\] \.game-chain \.chain-player\.is-up::after/);
  assert.match(chain, /\[data-fx-paused\] \.game-chain \.chain-player\.is-up::after/);
  const music = readFileSync(path.join(activity, 'js', 'views', 'musicquiz.js'), 'utf8');
  assert.match(music, /musicquiz-bar fx-loop/);
  for (const view of ['higherlower', 'reflex']) {
    const src = readFileSync(path.join(activity, 'js', 'views', `${view}.js`), 'utf8');
    assert.match(src, /'is-duel fx-loop'/, view);
  }
});

test('game views stay free of comments and inline styles', () => {
  for (const name of VIEWS) {
    const src = readFileSync(path.join(activity, 'js', 'views', `${name}.js`), 'utf8');
    assert.equal(/^\s*\/\/|\/\*/m.test(src), false, name);
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'cssText', 'setAttribute(\'style']) assert.equal(src.includes(bad), false, `${name} ${bad}`);
  }
});

test('the knockout duel lights an acting ring on both players', () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const p = (id, name) => ({ id, name, initials: name[0], hue: 10 });
  const duel = koBar({ alive: [p('a', 'Pip'), p('b', 'Ro')], out: [], duel: true });
  assert.equal(duel.querySelectorAll('.ko-face.fx-acting').length, 2);
  const many = koBar({ alive: [p('a', 'Pip'), p('b', 'Ro'), p('c', 'Lu')], out: [], duel: false });
  assert.equal(many.querySelectorAll('.fx-acting').length, 0);
});

test('reflex and higher or lower clear the backdrop rush when they close', () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const engine = { act() {}, now: () => 0, snapshot: () => null };
  for (const make of [createHigherlowerView, createReflexView]) {
    const app = h('div', { class: 'app' });
    const view = make({ engine, fx: { confetti() {} }, cues: null });
    app.append(view.el);
    app.classList.add('fx-rush');
    view.destroy();
    assert.equal(app.classList.contains('fx-rush'), false);
  }
});
