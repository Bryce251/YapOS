import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, flush } from './dom-shim.js';
import { room } from './activity-kit.test.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const activity = path.join(here, '..', 'web', 'activity');
const SHEETS = ['activity.css', 'party.css', 'juice.css'];

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

function has(el, cls) {
  return Boolean(el && el.classList && el.classList.contains(cls));
}

test('the shell and party sheets only animate transform and opacity', () => {
  for (const f of SHEETS) {
    const css = readFileSync(path.join(activity, 'css', f), 'utf8');
    assert.equal(/\/\*|url\(|@import|@font-face/.test(css), false, f);
    for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g)) {
      const props = [...m[2].matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]);
      for (const p of props) assert.ok(['transform', 'opacity'].includes(p), `${f} ${m[1]} animates ${p}`);
    }
  }
});

test('blur stays on the header only and the old aurora is gone', () => {
  const party = readFileSync(path.join(activity, 'css', 'party.css'), 'utf8');
  assert.equal(/backdrop-filter:\s*var/.test(party), false);
  const shell = readFileSync(path.join(activity, 'css', 'activity.css'), 'utf8');
  for (const m of shell.matchAll(/([^{}]+)\{[^{}]*backdrop-filter:\s*var[^{}]*\}/g)) assert.equal(m[1].trim(), '.top');
  for (const f of SHEETS) assert.equal(/\.aurora\b/.test(readFileSync(path.join(activity, 'css', f), 'utf8')), false, f);
  assert.match(shell, /\[data-fx="lite"\] \.top/);
  assert.match(shell, /\[data-fx-paused\]/);
  assert.match(shell, /\[data-fx="static"\] \.fx-roundcard/);
  assert.match(party, /\[data-fx="static"\] \.react-float/);
  assert.match(readFileSync(path.join(activity, 'css', 'juice.css'), 'utf8'), /contain: layout paint/);
});

test('the round card model names the game and the game number', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const { roundCardModel } = await import('../web/activity/js/ui/app.js');
  assert.equal(roundCardModel(null), null);
  assert.equal(roundCardModel({ ready: true, room: { phase: 'lobby' }, game: { name: 'Trivia', emoji: '❓' } }), null);
  assert.deepEqual(roundCardModel({ ready: true, room: { phase: 'game', round: 3 }, game: { name: 'Trivia', emoji: '❓' } }), { emoji: '❓', name: 'Trivia', eyebrow: 'Game 3' });
  assert.equal(roundCardModel({ ready: true, room: { phase: 'game', round: 0 }, game: { name: 'Trivia', emoji: '❓' } }).eyebrow, 'Get ready');
});

test('the app mounts the living backdrop and an effects button that switches and remembers the level', async () => {
  const { window } = installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(2, { join: false });
  await r.clock.advance(500);
  const root = document.createElement('div');
  document.body.append(root);
  const store = new Map([['yapos-party-fx', 'full']]);
  const win = Object.assign(window, {
    document,
    parent: window,
    innerWidth: 400,
    innerHeight: 700,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: () => 0,
    clearInterval: () => {},
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
  });
  const { fxLevel } = await import('../web/activity/js/ui/fxmode.js');
  const { mountApp } = await import('../web/activity/js/ui/app.js');
  const app = mountApp({ root, engine: r.engines[0], bridge: { close() {} }, win, juice: false });
  await r.clock.advance(300);
  const backdrop = root.childNodes[0];
  assert.ok(has(backdrop, 'fx-backdrop'));
  assert.equal(backdrop.getAttribute('aria-hidden'), 'true');
  assert.ok(all(backdrop).some((n) => has(n, 'fx-aurora-1')));
  assert.equal(all(root).some((n) => has(n, 'aurora')), false);
  assert.equal(fxLevel(), 'full');
  let btn = byKey(root, 'fx');
  assert.ok(btn, 'the effects button sits in the header');
  assert.ok(has(btn.parentNode, 'top-actions'));
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  assert.equal(btn.getAttribute('aria-label'), 'Effects: Full');
  btn.click();
  await flush();
  btn = byKey(root, 'fx');
  assert.equal(store.get('yapos-party-fx'), 'lite');
  assert.equal(fxLevel(), 'lite');
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  assert.equal(btn.getAttribute('aria-label'), 'Effects: Lite');
  const lobby = all(root).find((n) => has(n, 'lobby'));
  assert.ok(lobby);
  assert.ok(all(root).some((n) => has(n, 'lobby-hero-title') && has(n, 'fx-display')));
  app.destroy();
});

test('reaction floats use a smaller cap in lite mode and stay put when effects are still', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const fxm = await import('../web/activity/js/ui/fxmode.js');
  const { createParty, FLOAT_MAX, LITE_FLOAT_MAX, STILL_FLOAT_MS } = await import('../web/activity/js/ui/party.js');
  assert.ok(LITE_FLOAT_MAX < FLOAT_MAX);
  const handlers = {};
  const engine = { on: (ev, fn) => ((handlers[ev] = fn), () => {}), snapshot: () => null, react: () => true, play: () => false };
  const fakeWin = (pref, reduce = false) => ({ document: { documentElement: { dataset: {} } }, navigator: {}, matchMedia: () => ({ matches: reduce }), localStorage: { getItem: () => pref, setItem() {} } });
  const lite = fxm.startFxMode({ win: fakeWin('lite'), probe: false });
  const party = createParty({ engine, win: { innerWidth: 300, setTimeout: () => 1, clearTimeout() {} } });
  for (let i = 0; i < FLOAT_MAX; i += 1) handlers.react({ emoji: '🔥', name: 'Juno', mine: false });
  assert.equal(party.floats, LITE_FLOAT_MAX);
  party.destroy();
  lite.destroy();
  const still = fxm.startFxMode({ win: fakeWin('full', true), probe: false });
  const quiet = createParty({ engine, win: { innerWidth: 300, setTimeout: () => 1, clearTimeout() {} } });
  handlers.react({ emoji: '🎉', name: 'Juno', mine: false });
  const bit = all(quiet.el).find((n) => has(n, 'react-float'));
  assert.equal(bit.style.props['--dur'], `${STILL_FLOAT_MS}ms`);
  quiet.destroy();
  still.destroy();
  fxm.resetFxMode();
});

test('taking first place puts a crown on the leader and big gains get a shine', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const { board, standings, BIG_GAIN } = await import('../web/activity/js/ui/board.js');
  const mk = (slot, name, game) => ({ id: `p${slot}`, slot, name, initials: name[0], hue: 20, present: true, joined: true, game, isMe: false });
  board(standings([mk(0, 'Ada', 300), mk(1, 'Bo', 200)], 'game'), { label: 'Crown test' });
  const el = board(standings([mk(0, 'Ada', 300), mk(1, 'Bo', 900)], 'game'), { label: 'Crown test', gains: { 1: BIG_GAIN + 200 } });
  const nodes = all(el);
  const crowns = nodes.filter((n) => has(n, 'board-crown'));
  assert.equal(crowns.length, 1);
  assert.equal(crowns[0].getAttribute('aria-hidden'), 'true');
  const gain = nodes.find((n) => has(n, 'board-gain'));
  assert.ok(has(gain, 'is-big') && has(gain, 'fx-shine'));
});

test('the glow-up files carry no comments and no inline style writes', () => {
  for (const f of ['js/ui/app.js', 'js/ui/party.js', 'js/ui/board.js', 'js/ui/lobby.js', 'js/ui/daily.js']) {
    const src = readFileSync(path.join(activity, f), 'utf8');
    assert.equal(/^\s*\/\/|\/\*/m.test(src), false, f);
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'cssText']) assert.equal(src.includes(bad), false, `${f} ${bad}`);
  }
});
