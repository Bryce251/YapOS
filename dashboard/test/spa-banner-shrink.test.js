import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, flush, FakeEvent } from './dom-shim.js';

const { document } = installDom({ url: 'https://dash.example.test/u/bea' });
document.documentElement = document.createElement('html');
if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const { profileCard, allBadges, shrinkBanner, shrinkProgress, BANNER_COLLAPSE, SHRINK_VAR } = await import('../web/js/pages/profile.js');
const { BANNER_W, BANNER_H, BANNER_BYTES, bannerCrop, cropAxis, moveFocus, dragDelta, encodeBanner, chooseBannerCrop, processBanner } = await import('../web/js/pages/profile-editor.js');
const { normalizeProfile } = await import('../web/js/community-data.js');
const { readLook } = await import('../web/js/profile-look.js');
const { cleanCard, cardModel } = await import('../web/activity/js/ui/profilecard.js');

const HINTS = { 'first-game': 'Finish your first YapOS Party game.', 'wins-10': 'Win 10 YapOS Party games.' };

function profile() {
  return normalizeProfile({
    profile: {
      username: 'bea',
      name: 'Bea',
      level: 3,
      xp: 400,
      badges: ['first-game', 'wins-10', 'season-party-1-2026-09', 'einstein', 'c-abcdefgh', 'yapos-team'],
      achievements: ['messages-10k'],
      season: [],
      party: { games: 40, wins: 10, favourites: [] },
    },
    partyBadges: [{ id: 'first-game', label: 'First game', emoji: '🎈' }, { id: 'wins-10', label: 'Winner', emoji: '🥇' }],
    catalog: { badges: [{ id: 'c-abcdefgh', label: 'Shizu', emoji: '🌸', note: 'The one and only Shizu.' }, { id: 'einstein', label: 'Einstein', emoji: '🧠' }], achievements: [] },
  });
}

function fakeCanvas(log, { webp = true, bytes = 1000 } = {}) {
  const ctx = {
    drawImage: (...args) => log.push(['draw', ...args.slice(1)]),
  };
  return {
    width: 0,
    height: 0,
    getContext: () => ctx,
    toDataURL(type, q) {
      log.push(['encode', type, q]);
      if (type === 'image/webp' && !webp) return 'data:image/png;base64,AAAA';
      return `data:${type};base64,${'A'.repeat(Math.ceil((bytes * 4) / 3))}`;
    },
  };
}

test('the editor re-encodes every banner to exactly 1500 by 500 as WebP, with JPEG when WebP is missing', () => {
  assert.deepEqual([BANNER_W, BANNER_H], [1500, 500]);
  assert.ok(BANNER_BYTES <= 400 * 1024 && BANNER_BYTES > 190 * 1024);
  const log = [];
  let canvas = null;
  const doc = { createElement: () => (canvas = fakeCanvas(log)) };
  const url = encodeBanner({ width: 3000, height: 1500 }, { doc });
  assert.match(url, /^data:image\/webp;base64,/);
  assert.deepEqual([canvas.width, canvas.height], [1500, 500]);
  assert.deepEqual(log[0], ['draw', 0, 250, 3000, 1000, 0, 0, 1500, 500]);
  const log2 = [];
  const jpeg = encodeBanner({ width: 1500, height: 500 }, { doc: { createElement: () => fakeCanvas(log2, { webp: false }) } });
  assert.match(jpeg, /^data:image\/jpeg;base64,/);
  assert.deepEqual(log2[0], ['draw', 0, 0, 1500, 500, 0, 0, 1500, 500]);
  assert.throws(() => encodeBanner({ width: 1500, height: 500 }, { doc: { createElement: () => fakeCanvas([], { bytes: BANNER_BYTES + 10 }) } }), /too detailed/);
});

test('the chosen focus point moves the 3:1 crop, and stays inside the picture', () => {
  assert.deepEqual(bannerCrop(3000, 500, { focus: { x: 0, y: 0.5 } }), { sx: 0, sy: 0, sw: 1500, sh: 500 });
  assert.deepEqual(bannerCrop(3000, 500, { focus: { x: 1, y: 0.5 } }), { sx: 1500, sy: 0, sw: 1500, sh: 500 });
  assert.deepEqual(bannerCrop(1500, 1500, { focus: { x: 0.5, y: 0.25 } }), { sx: 0, sy: 250, sw: 1500, sh: 500 });
  assert.deepEqual(bannerCrop(1500, 1500, { focus: { x: 0.5, y: 9 } }), { sx: 0, sy: 1000, sw: 1500, sh: 500 });
  assert.deepEqual(bannerCrop(1500, 1500, { focus: { y: 'x' } }), bannerCrop(1500, 1500));
  assert.equal(cropAxis(1500, 500), null);
  assert.equal(cropAxis(1501, 500), null);
  assert.equal(cropAxis(1200, 300), 'x');
  assert.equal(cropAxis(1000, 1000), 'y');
  assert.deepEqual(moveFocus({ x: 0.5, y: 0.5 }, 'x', 0.7), { x: 1, y: 0.5 });
  assert.deepEqual(moveFocus({ x: 0.5, y: 0.5 }, 'y', -0.2), { x: 0.5, y: 0.3 });
  assert.ok(dragDelta('x', 100, 0, 750, 3000, 500) < 0, 'dragging the picture right shows more of its left side');
  assert.equal(dragDelta('x', 750, 0, 750, 3000, 500), -1);
  assert.equal(dragDelta(null, 10, 10, 750, 1500, 500), 0);
  const log = [];
  encodeBanner({ width: 3000, height: 500 }, { doc: { createElement: () => fakeCanvas(log) }, focus: { x: 0, y: 0.5 } });
  assert.deepEqual(log[0], ['draw', 0, 0, 1500, 500, 0, 0, 1500, 500]);
});

test('a picture that is not 3:1 opens a crop frame you can move with the keyboard or cancel', async () => {
  assert.deepEqual(await chooseBannerCrop({ width: 1500, height: 500 }), { x: 0.5, y: 0.5 }, 'a 1500 by 500 picture needs no cropping');
  const pick = chooseBannerCrop({ width: 3000, height: 500 });
  const root = document.querySelector('.pe-crop');
  assert.ok(root, 'the crop dialog opens');
  const frame = root.querySelector('.pe-crop-frame');
  assert.equal(frame.getAttribute('role'), 'slider');
  assert.equal(frame.getAttribute('aria-valuenow'), '50');
  assert.equal(document.activeElement, frame);
  frame.dispatchEvent(new FakeEvent('keydown', { key: 'ArrowRight' }));
  frame.dispatchEvent(new FakeEvent('keydown', { key: 'ArrowRight' }));
  assert.equal(frame.getAttribute('aria-valuenow'), '60');
  assert.match(frame.getAttribute('aria-valuetext'), /toward the right/);
  const down = Object.assign(new FakeEvent('pointerdown'), { clientX: 100, clientY: 0, pointerId: 1 });
  frame.dispatchEvent(down);
  frame.dispatchEvent(Object.assign(new FakeEvent('pointermove'), { clientX: 100, clientY: 40, pointerId: 1 }));
  assert.equal(frame.getAttribute('aria-valuenow'), '60', 'a sideways crop ignores up and down drags');
  frame.dispatchEvent(new FakeEvent('pointerup'));
  root.querySelector('.pe-crop-ok').click();
  const focus = await pick;
  assert.ok(Math.abs(focus.x - 0.6) < 1e-9);
  assert.equal(focus.y, 0.5);
  assert.equal(document.querySelector('.pe-crop'), null);
  const cancelled = chooseBannerCrop({ width: 1000, height: 1000 });
  document.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
  assert.equal(await cancelled, null);
  assert.equal(document.querySelector('.pe-crop'), null);
});

test('cancelling the crop uploads nothing', async () => {
  const file = { size: 10, type: 'image/png', name: 'a.png', slice: () => ({ arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]).buffer }) };
  globalThis.createImageBitmap = async () => ({ width: 1000, height: 1000, close() {} });
  try {
    assert.equal(await processBanner(file, { choose: async () => null }), null);
  } finally {
    delete globalThis.createImageBitmap;
  }
});

function fakeWin({ reduce = false, raf = true } = {}) {
  const listeners = {};
  const frames = [];
  const win = {
    scrollY: 0,
    listeners,
    frames,
    matchMedia: (q) => ({ matches: reduce && q.includes('reduce') }),
    addEventListener: (type, fn, opts) => { listeners[type] = { fn, opts }; },
    removeEventListener: (type) => { delete listeners[type]; },
    getComputedStyle: (el) => (el.localName === 'article' ? { rowGap: '24px' } : { top: '65px', marginBottom: '-12px' }),
    cancelAnimationFrame: () => {},
  };
  if (raf) win.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  return win;
}

function bannerCard() {
  const card = profileCard(profile(), { look: readLook({ banner: 'sunset' }).look, hints: HINTS });
  const banner = card.querySelector('.profile-banner');
  const hero = card.querySelector('.profile-hero');
  Object.defineProperty(banner, 'offsetHeight', { value: 300 });
  hero.getBoundingClientRect = () => ({ top: 400, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  const writes = [];
  for (const el of [card, banner, hero, card.querySelector('.profile-avatar-wrap')]) {
    const set = el.style.setProperty.bind(el.style);
    el.style.setProperty = (k, v) => { writes.push([el === card ? 'card' : el.className, k, v]); set(k, v); };
  }
  return { card, writes };
}

test('the banner shrinks as the page scrolls, writing only one CSS variable once per frame', () => {
  assert.equal(BANNER_COLLAPSE, 0.62);
  assert.equal(shrinkProgress(0, 50, 100), 0);
  assert.equal(shrinkProgress(100, 50, 100), 0.5);
  assert.equal(shrinkProgress(500, 50, 100), 1);
  assert.equal(shrinkProgress(10, 50, 0), 0);
  const { card, writes } = bannerCard();
  const win = fakeWin();
  const stop = shrinkBanner(card, { win });
  assert.ok(card.classList.contains('can-shrink'));
  assert.equal(win.listeners.scroll.opts.passive, true);
  assert.equal(win.listeners.resize.opts.passive, true);
  assert.equal(card.style.props[SHRINK_VAR], '0');
  const start = 400 - 24 + 12 - 300 - 65;
  win.scrollY = start + 93;
  win.listeners.scroll.fn();
  win.listeners.scroll.fn();
  win.listeners.scroll.fn();
  assert.equal(win.frames.length, 1, 'many scroll events wait for one animation frame');
  win.frames.shift()();
  assert.equal(card.style.props[SHRINK_VAR], '0.5');
  win.scrollY = 5000;
  win.listeners.scroll.fn();
  win.frames.shift()();
  assert.equal(card.style.props[SHRINK_VAR], '1');
  win.listeners.scroll.fn();
  win.frames.shift()();
  assert.deepEqual(writes, [['card', SHRINK_VAR, '0'], ['card', SHRINK_VAR, '0.5'], ['card', SHRINK_VAR, '1']], 'nothing but the one variable is written');
  stop();
  assert.equal(card.classList.contains('can-shrink'), false);
  assert.equal(card.style.props[SHRINK_VAR], undefined);
  assert.equal(win.listeners.scroll, undefined);
  assert.equal(win.listeners.resize, undefined);
});

test('reduced motion, the editor preview and cards without a banner never shrink', () => {
  const reduced = bannerCard();
  const win = fakeWin({ reduce: true });
  shrinkBanner(reduced.card, { win });
  assert.equal(reduced.card.classList.contains('can-shrink'), false);
  assert.deepEqual(Object.keys(win.listeners), []);
  assert.deepEqual(reduced.writes, []);
  const preview = profileCard(profile(), { look: readLook({ banner: 'sunset' }).look, hints: HINTS, editing: true });
  const w2 = fakeWin();
  shrinkBanner(preview, { win: w2 });
  assert.deepEqual(Object.keys(w2.listeners), []);
  const plain = profileCard(profile(), { hints: HINTS });
  const w3 = fakeWin();
  shrinkBanner(plain, { win: w3 });
  assert.deepEqual(Object.keys(w3.listeners), []);
  const ctrl = new AbortController();
  const live = bannerCard();
  const w4 = fakeWin();
  shrinkBanner(live.card, { win: w4, signal: ctrl.signal });
  ctrl.abort();
  assert.deepEqual(Object.keys(w4.listeners), [], 'leaving the page removes the listeners');
  const css = readFileSync(new URL('../web/css/profile.css', import.meta.url), 'utf8');
  const motion = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(motion, /\.profile-card\.can-shrink \.profile-banner \{[^}]*clip-path: none/);
  assert.match(css, /\.profile-banner \{[^}]*aspect-ratio: 3 \/ 1/);
  assert.match(css, /\.profile-card\.can-shrink \.profile-banner \{[^}]*position: sticky/);
  assert.doesNotMatch(css.slice(css.indexOf('.profile-card.can-shrink .profile-banner {')).split('}')[0], /height|margin/, 'shrinking never changes layout');
  assert.match(css, /html:has\(\.profile-card\.can-shrink\) \{[^}]*scroll-padding-top: calc\(73px \+ min\(13vw, 110px\)\)/, 'focused controls scroll out from under the shrunk banner');
  assert.match(motion, /html:has\(\.profile-card\.can-shrink\) \{[^}]*scroll-padding-top: 0/);
});

test('special badges in the Party card all-badges view get the same gold border as the badge row', () => {
  const css = readFileSync(new URL('../web/activity/css/profilecard.css', import.meta.url), 'utf8');
  assert.match(css, /\n\.pcard \.is-special \{\s*border-color: var\(--gold\);/);
  assert.ok(css.indexOf('.pcard .is-special {') < css.indexOf('.pcard-all-item.is-pinned {'), 'a pinned badge still shows its pin colour');
});

test('badges list pins first, then one-of-a-kind and special badges, then the rest, everywhere', async () => {
  const p = profile();
  const look = readLook({ pins: ['wins-10'] }).look;
  const card = profileCard(p, { look, hints: HINTS });
  const tiles = card.querySelector('.badge-grid').querySelectorAll('.badge-tile');
  assert.deepEqual(tiles.map((t) => t.querySelector('.badge-tile-label').textContent), ['Winner', 'Shizu', 'Einstein', 'YapOS team', 'First game', '#1 Party · September 2026']);
  assert.deepEqual(tiles.map((t) => t.classList.contains('is-special')), [false, true, true, true, false, false]);
  assert.deepEqual(allBadges(p, HINTS).map((b) => b.key), ['c-abcdefgh', 'einstein', 'yapos-team', 'first-game', 'wins-10', 'season-party-1-2026-09', 'ach:messages-10k']);
  card.querySelector('.profile-all-badges').click();
  await flush();
  const sheet = document.querySelector('.allbadges');
  assert.deepEqual(sheet.querySelectorAll('.allbadges-group').map((g) => g.dataset.group), ['custom', 'special', 'party', 'season', 'achievement']);
  assert.ok(sheet.querySelector('.allbadges-group').classList.contains('is-special'));
  assert.equal(sheet.querySelectorAll('.allbadges-row.is-special').length, 3);
  sheet.remove();
});

test('the Party card keeps the server order after pins and marks special badges', () => {
  const c = cleanCard({
    name: 'Bea',
    badges: [{ id: 'wins-10', label: 'Winner' }, { id: 'c-abcdefgh', label: 'Shizu', rare: 'custom' }, { id: 'einstein', label: 'Einstein', rare: 'special' }, { id: 'first-game', label: 'First game', rare: 'constructor' }],
    achievements: [],
    look: { pins: ['wins-10'] },
  });
  assert.equal(c.badges[3].rare, undefined, 'only known kinds are kept');
  const m = cardModel(c);
  assert.deepEqual(m.all.map((b) => b.id), ['wins-10', 'c-abcdefgh', 'einstein', 'first-game']);
  assert.deepEqual(m.all.map((b) => b.rare || null), [null, 'custom', 'special', null]);
});
