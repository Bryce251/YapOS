import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, FakeEvent, flush } from './dom-shim.js';
import * as look from '../web/js/profile-look.js';
import * as cl from '../web/activity/js/ui/cardlook.js';
import * as fxm from '../web/activity/js/ui/fxmode.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const activity = path.join(here, '..', 'web', 'activity');
const ID = '11111111-1111-4111-8111-111111111111';
const GIF = '/banner-img/b-devbanner9-78b2e29c0e52fea5.gif';
const STILL = '/banner-img/b-devbanner9-0123456789abcdef-still.webp';

function text(node) {
  if (node.data !== undefined && !node.localName) return node.data;
  return (node.childNodes || []).map(text).join(' ');
}

function palette(theme, extra = {}) {
  return look.themePalette({ ...look.defaultLook(), theme, ...extra });
}

function profile(lookExtra = {}, extra = {}) {
  return {
    hidden: false,
    name: 'Jolli',
    username: 'jolli',
    avatar: null,
    level: 11,
    progress: { into: 50, need: 200 },
    shards: 1000000000000,
    badges: [{ id: 'first-game', label: 'First game', emoji: '🎈' }, { id: 'c-devstar1', label: 'Dev star', image: '/badge-img/c-devstar1-0123456789abcdef.png', rare: 'custom' }],
    badgeCount: 39,
    achievements: [],
    clan: { name: "Yapin'", tag: 'YAP' },
    party: { games: 70, wins: 33, bestStreak: 0, favourites: [{ game: 'draw', played: 7 }] },
    rank: { rank: 4, points: 29638 },
    page: true,
    look: {
      pins: ['c-devstar1'],
      nameGradient: 'aurora',
      nameFont: 'serif',
      banner: 'image',
      bannerImage: GIF,
      bannerMotion: { still: STILL, width: 900, height: 300 },
      bannerCrop: { zoom: 1.5, x: 0.4, y: 0.5 },
      ring: 'gold',
      theme: 'aurora',
      palette: palette('aurora'),
      effect: 'snow',
      featured: 'wins',
      pronouns: 'he/him',
      status: 'Developing YapOS!',
      statusEmoji: '',
      ...lookExtra,
    },
    ...extra,
  };
}

function fakeFx() {
  const calls = [];
  const mod = {
    allowed: true,
    effectsAllowed: () => mod.allowed,
    prefersReducedMotion: () => false,
    startEffect(host, id, opts) {
      const canvas = { style: { props: {}, setProperty(k, v) { this.props[k] = v; } } };
      const h = { running: true, canvas, stopped: false, stop() { h.stopped = true; h.running = false; } };
      calls.push({ host, id, opts, h });
      return h;
    },
  };
  return { mod, calls, load: async () => mod };
}

async function setup(body, { win: extra = {} } = {}) {
  const { document } = installDom({ url: 'https://yapos.dev/activity/' });
  const win = {
    document,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    matchMedia: () => ({ matches: false }),
    fetch: async () => new Response(JSON.stringify({ profile: body }), { status: 200 }),
    ...extra,
  };
  const { avatar, h } = await import('../web/activity/js/ui/dom.js');
  const { createProfileCard } = await import('../web/activity/js/ui/profilecard.js');
  const players = [{ id: ID, name: 'Jolli', initials: 'J', hue: 30, avatar: null, isMe: true, isHost: true, present: true, joined: true }];
  const engine = { snapshot: () => ({ ready: true, me: ID, players, room: { phase: 'lobby' } }) };
  const root = h('div', { class: 'app' });
  document.body.append(root);
  const face = avatar(players[0], 'md');
  root.append(face);
  const pc = createProfileCard({ win, engine });
  pc.bind(root);
  return { document, face, pc, win };
}

function setLevel(level) {
  fxm.resetFxMode();
  if (level === 'full') return null;
  return fxm.startFxMode({ win: { localStorage: { getItem: () => level, setItem() {} }, navigator: {}, matchMedia: () => ({ matches: level === 'static' }) }, probe: false });
}

test('the card helpers agree with the site rules for palettes, crops, effects and gradients', () => {
  assert.deepEqual([...cl.THEME_KEYS], [...look.THEME_KEYS]);
  assert.deepEqual([...cl.THEME_IDS], look.THEME_IDS.filter((t) => t !== 'none'));
  assert.deepEqual([...cl.THEME_PATTERNS], look.THEME_PATTERNS.map((p) => p.id));
  assert.deepEqual([...cl.THEME_MODES], look.THEME_MODES.map((p) => p.id));
  assert.deepEqual([...cl.EFFECT_IDS], [...look.EFFECT_IDS]);
  assert.deepEqual([...cl.FEATURED_IDS], look.FEATURED.map((f) => f.id));
  assert.deepEqual(Object.keys(cl.NAME_GRADIENTS), look.NAME_GRADIENTS.map((g) => g.id));
  for (const t of look.THEMES) {
    const p = palette(t.id, { themeMode: t.mode });
    assert.deepEqual(cl.cleanPalette(p), look.cleanPalette(p), t.id);
  }
  const custom = palette('custom', { themeCustom: { base: '#123456', alt: '#abcdef', accent: '#ff00aa' } });
  assert.deepEqual(cl.cleanPalette(custom), look.cleanPalette(custom));
  const bad = palette('ocean');
  bad.dark.text = 'red;background:url(x)';
  assert.equal(cl.cleanPalette(bad), null);
  assert.equal(cl.cleanPalette({ ...palette('ocean'), id: 'none' }), null);
  for (const [w, ht, crop] of [[900, 300, null], [1200, 300, { zoom: 2, x: 0.1, y: 0.9 }], [600, 400, { zoom: 8, x: 1, y: 0 }], [3000, 1000, { zoom: 1.37, x: 0.33, y: 0.61 }]]) {
    assert.deepEqual(cl.cropBox(w, ht, crop), look.cropBox(w, ht, crop), `${w}x${ht}`);
  }
  assert.deepEqual(cl.readCrop({ zoom: 99, x: -1, y: 'a' }), { zoom: 8, x: 0, y: 0.5 });
  assert.equal(cl.readMotion({ still: '/banner-img/b-devbanner9-0123456789abcdef.png', width: 900, height: 300 }), null);
  assert.deepEqual(cl.readMotion({ still: STILL, width: 900, height: 300 }), { still: STILL, width: 900, height: 300 });
  assert.equal(cl.gradientOf('aurora'), 'linear-gradient(90deg, #7cf0b5, #8ab4ff, #d39bff)');
  assert.equal(cl.gradientOf('aurora', true), 'linear-gradient(90deg, #047857, #4338ca, #7e22ce)');
  assert.equal(cl.gradientOf('__proto__'), null);
});

test('the card look keeps gif banners, motion, crop, theme, effect and featured, and drops anything odd', async () => {
  const { cleanLook, BANNER_IMAGE_RE } = await import('../web/activity/js/ui/profilecard.js');
  assert.ok(BANNER_IMAGE_RE.test(GIF));
  assert.equal(BANNER_IMAGE_RE.source, look.BANNER_IMAGE_RE.source);
  const l = cleanLook(profile().look);
  assert.equal(l.banner, 'image');
  assert.equal(l.bannerImage, GIF);
  assert.deepEqual(l.bannerMotion, { still: STILL, width: 900, height: 300 });
  assert.deepEqual(l.bannerCrop, { zoom: 1.5, x: 0.4, y: 0.5 });
  assert.equal(l.palette.id, 'aurora');
  assert.equal(l.effect, 'snow');
  assert.equal(l.featured, 'wins');
  assert.equal(l.gradient, 'aurora');
  const odd = cleanLook({ banner: 'ocean', effect: 'lava', featured: 'money', theme: 'x', palette: { id: 'ocean', light: {}, dark: {} }, nameGradient: 'toString', bannerMotion: { still: 'javascript:1', width: 1, height: 1 } });
  assert.equal(odd.effect, null);
  assert.equal(odd.featured, null);
  assert.equal(odd.palette, null);
  assert.equal(odd.gradient, null);
  assert.equal(odd.bannerMotion, null);
  assert.equal(cleanLook({ effect: 'none', featured: 'level' }), null, 'defaults alone are no look');
  assert.ok(cleanLook({ effect: 'hearts' }), 'an effect alone is a look');
});

test('the theme colours the whole card and goes away for the next person', async () => {
  setLevel('full');
  const { face, pc, win, document } = await setup(profile());
  const bodies = [profile(), profile({ theme: 'none', palette: null, effect: 'none', banner: 'ocean', bannerImage: null, bannerMotion: null })];
  win.fetch = async () => new Response(JSON.stringify({ profile: bodies.shift() }), { status: 200 });
  face.click();
  await flush();
  const panel = pc.el.querySelector('.pcard');
  const pal = palette('aurora');
  assert.ok(panel.classList.contains('has-theme'));
  assert.ok(panel.classList.contains('pat-glow'));
  assert.equal(panel.classList.contains('is-light'), false, 'aurora is a dark theme');
  for (const [token, key] of [['--surface', 'surface'], ['--surface-2', 'surface2'], ['--border', 'border'], ['--text', 'text'], ['--text-2', 'text2'], ['--accent', 'accent'], ['--on-accent', 'onAccent'], ['--pt-bg', 'bg'], ['--pt-bg2', 'bg2'], ['--pc-ac', 'accent'], ['--pc-ac-text', 'accentText']]) {
    assert.equal(panel.style.props[token], pal.dark[key], token);
  }
  for (const [k, v] of Object.entries(panel.style.props)) assert.match(v, /^#[0-9a-f]{6}$/, k);
  const view = pc.el.querySelector('.pcard-view');
  assert.ok(view.classList.contains('has-accent'));
  assert.ok(view.classList.contains('is-reveal'), 'the first paint with data plays the reveal');
  assert.equal(view.style.props['--pc-ac'], undefined, 'the theme accent wins over the plain accent');
  const link = document.querySelector('link[data-pcard-look]');
  assert.equal(link.getAttribute('href'), '/activity/css/profilecard-look.css');
  assert.equal(link.getAttribute('rel'), 'stylesheet');
  pc.close();
  pc.open('33333333-3333-4333-8333-333333333333');
  await flush();
  assert.equal(document.querySelectorAll('link[data-pcard-look]').length, 1, 'the card sheet is added once');
  assert.equal(panel.classList.contains('has-theme'), false);
  assert.equal(panel.classList.contains('pat-glow'), false);
  assert.deepEqual(Object.keys(panel.style.props), []);
  assert.ok(pc.el.querySelector('.pcard-banner').classList.contains('banner-ocean'));
  pc.close();
});

test('light themes switch the card to the light colours and the name to its light gradient', async () => {
  setLevel('full');
  const body = profile({ theme: 'frost', palette: palette('frost', { themeMode: 'light', themePattern: 'dots' }) });
  const { face, pc } = await setup(body);
  face.click();
  await flush();
  const panel = pc.el.querySelector('.pcard');
  const pal = palette('frost', { themeMode: 'light', themePattern: 'dots' });
  assert.equal(pal.mode, 'light');
  assert.ok(panel.classList.contains('is-light'));
  assert.ok(panel.classList.contains('pat-dots'));
  assert.equal(panel.style.props['--surface'], pal.light.surface);
  assert.equal(panel.style.props['--text'], pal.light.text);
  const name = pc.el.querySelector('.pcard-name');
  assert.ok(name.classList.contains('has-grad'));
  assert.ok(name.classList.contains('font-serif'));
  assert.equal(name.style.props['--pc-grad'], cl.gradientOf('aurora', true));
  assert.ok(look.contrast(pal.light.text, pal.light.surface) >= 4.5);
  assert.ok(look.contrast(pal.light.onAccent, pal.light.accent) >= 4.5);
  pc.close();
});

test('a gif banner plays with the saved crop and keeps a still for reduced motion', async () => {
  setLevel('full');
  const { face, pc } = await setup(profile());
  face.click();
  await flush();
  const banner = pc.el.querySelector('.pcard-banner');
  assert.ok(banner.classList.contains('is-moving'));
  const pic = banner.querySelector('picture');
  assert.ok(pic);
  const source = pic.querySelector('source');
  assert.equal(source.getAttribute('media'), '(prefers-reduced-motion: reduce)');
  assert.equal(source.getAttribute('srcset'), STILL);
  const img = pic.querySelector('img');
  assert.equal(img.getAttribute('src'), GIF);
  assert.ok(img.classList.contains('is-crop'));
  const box = look.cropBox(900, 300, { zoom: 1.5, x: 0.4, y: 0.5 });
  assert.equal(img.style.props['--crop-w'], `${box.width}%`);
  assert.equal(img.style.props['--crop-h'], `${box.height}%`);
  assert.equal(img.style.props['--crop-x'], `${box.left}%`);
  assert.equal(img.style.props['--crop-y'], `${box.top}%`);
  img.dispatchEvent(new FakeEvent('error'));
  assert.equal(img.getAttribute('src'), STILL, 'a broken gif falls back to its still');
  img.dispatchEvent(new FakeEvent('error'));
  assert.equal(banner.querySelector('img'), null, 'then to the accent');
  pc.close();
});

test('lite mode and reduced motion show the still banner and start no effect', async () => {
  for (const level of ['lite', 'static']) {
    const mode = setLevel(level);
    const { face, pc } = await setup(profile());
    face.click();
    await flush();
    const banner = pc.el.querySelector('.pcard-banner');
    assert.equal(banner.querySelector('picture'), null, level);
    const img = banner.querySelector('img');
    assert.equal(img.getAttribute('src'), STILL, level);
    assert.ok(img.classList.contains('is-still'));
    assert.ok(img.classList.contains('is-crop'));
    assert.equal(pc.el.querySelector('canvas'), null);
    pc.close();
    mode.destroy();
  }
  fxm.resetFxMode();
  const { face, pc } = await setup(profile(), { win: { matchMedia: (q) => ({ matches: /reduce/.test(q) }) } });
  face.click();
  await flush();
  assert.equal(pc.el.querySelector('.pcard-banner img').getAttribute('src'), STILL, 'the system reduced motion setting alone is enough');
  pc.close();
});

test('the card effect runs on the shared loop, only in full mode, and stops when the card closes', async () => {
  const off = fxm.sharedLoop();
  fxm.resetFxMode();
  const { mod, calls, load } = fakeFx();
  const host = { isConnected: true, getBoundingClientRect: () => ({ width: 360, height: 528 }) };
  const win = { matchMedia: () => ({ matches: false }), devicePixelRatio: 3 };
  const fx = cl.createCardFx({ win, doc: {}, load });
  assert.equal(await fx.start(host, 'snow'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'snow');
  assert.equal(calls[0].opts.className, 'pcard-fx');
  assert.deepEqual(calls[0].opts.box(), { width: 360, height: 528 });
  assert.equal(calls[0].h.canvas.style.props.position, 'absolute');
  assert.equal(calls[0].h.canvas.style.props['pointer-events'], 'none');
  const loop = fxm.sharedLoop();
  const before = loop.size;
  const frame = calls[0].opts.win.requestAnimationFrame(() => {});
  assert.equal(loop.size, before + 1, 'frames go through the shared loop');
  calls[0].opts.win.cancelAnimationFrame(frame);
  assert.equal(loop.size, before);
  assert.equal(await fx.start(host, 'snow'), true);
  assert.equal(calls.length, 1, 'the same effect keeps running');
  fx.stop();
  assert.equal(calls[0].h.stopped, true);
  assert.equal(fx.running, false);
  assert.equal(await fx.start(host, 'none'), false);
  assert.equal(await fx.start(host, 'lava'), false);
  mod.allowed = false;
  assert.equal(await fx.start(host, 'hearts'), false, 'the visitor switch on the site is respected');
  mod.allowed = true;
  const p = fx.start(host, 'hearts');
  fx.stop();
  assert.equal(await p, false, 'closing before the module loads starts nothing');
  const mode = setLevel('lite');
  assert.equal(await fx.start(host, 'hearts'), false);
  mode.destroy();
  fxm.resetFxMode();
  const still = cl.createCardFx({ win: { matchMedia: () => ({ matches: true }) }, doc: {}, load });
  assert.equal(await still.start(host, 'hearts'), false);
  assert.equal(calls.length, 1);
  assert.ok(off);
});

test('the real effect module loads from the card and the card marks itself while one plays', async () => {
  setLevel('full');
  const m = await import(new URL(cl.FX_MODULE, new URL('../web/activity/js/ui/cardlook.js', import.meta.url)).href);
  assert.equal(typeof m.startEffect, 'function');
  assert.equal(typeof m.effectsAllowed, 'function');
  const { face, pc } = await setup(profile());
  face.click();
  await flush();
  await flush();
  const panel = pc.el.querySelector('.pcard');
  assert.ok(panel.classList.contains('has-fx'));
  pc.close();
  assert.equal(pc.el.querySelector('canvas'), null);
});

test('the featured stat leads the stats row with a glow and the card still fits a 320x560 call', async () => {
  setLevel('full');
  const pcm = await import('../web/activity/js/ui/profilecard.js');
  const model = (extra, more = {}) => pcm.cardModel(pcm.cleanCard(profile(extra, more)));
  const wins = model({});
  assert.deepEqual(wins.stats.map((s) => s.key), ['wins', 'games', 'rate']);
  assert.equal(wins.stats[0].featured, true);
  const badges = model({ featured: 'badges' });
  assert.deepEqual(badges.stats.map((s) => s.key), ['badges', 'games', 'wins', 'rate']);
  assert.equal(badges.stats[0].value, '39');
  const shards = model({ featured: 'shards' }, { party: { games: 70, wins: 33, bestStreak: 6, favourites: [] } });
  assert.deepEqual(shards.stats.map((s) => s.key), ['shards', 'games', 'wins', 'rate']);
  assert.ok(shards.stats.length <= pcm.STATS_SHOWN);
  assert.equal(shards.stats[0].value, '1T');
  assert.deepEqual(shards.facts.map((f) => f.key), ['rank'], 'shards are not shown twice');
  assert.deepEqual(model({ featured: 'level' }).stats.map((s) => s.key), ['games', 'wins', 'rate']);
  assert.deepEqual(model({ featured: 'winrate' }).stats.map((s) => s.key), ['rate', 'games', 'wins']);
  const { face, pc } = await setup(profile());
  face.click();
  await flush();
  const tiles = pc.el.querySelectorAll('.pcard-stat');
  assert.ok(tiles[0].classList.contains('is-featured'));
  assert.equal(tiles[0].getAttribute('title'), 'Featured: Wins');
  assert.ok(pc.el.querySelector('.pcard-avatar').classList.contains('ring-gold'));
  assert.match(text(pc.el.querySelector('.pcard-sub')), /@jolli \[YAP\] Yapin' he\/him Developing YapOS!/);
  assert.ok(pc.el.querySelector('.pcard-sub .pcard-clan.is-live'), 'the clan is a pill you can tap, not plain text');
  assert.match(text(pc.el), /Developing YapOS!/);
  const pinned = pc.el.querySelectorAll('.pcard-badge')[0];
  assert.ok(pinned.classList.contains('is-pinned'));
  assert.ok(pinned.classList.contains('is-special'));
  pc.close();
  const sheet = 560 - 24;
  assert.ok(pcm.cardHeight('ready', 320) <= sheet);
  assert.ok(pcm.cardHeight('ready') <= 560 - 32);
});

test('hidden profiles get no theme, effect or banner picture', async () => {
  setLevel('full');
  const { face, pc } = await setup({ hidden: true, name: 'Jolli', avatar: null, look: profile().look });
  face.click();
  await flush();
  const panel = pc.el.querySelector('.pcard');
  assert.equal(panel.classList.contains('has-theme'), false);
  assert.equal(panel.classList.contains('has-fx'), false);
  assert.equal(pc.el.querySelector('.pcard-banner img'), null);
  pc.close();
});

test('the lazy card sheet is plain, cheap and follows the activity rules', () => {
  const css = readFileSync(path.join(activity, 'css', 'profilecard-look.css'), 'utf8');
  assert.equal(/[^\x00-\x7f]/.test(css), false, 'plain ASCII');
  assert.equal(/\/\*|\/\/ |url\(|@import|@font-face/.test(css), false);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\[data-fx="static"\] \.pcard-fx/);
  assert.match(css, /\[data-fx="lite"\] \.pcard-fx/);
  assert.match(css, /\.pcard-banner-img\.is-crop \{[^}]*width: var\(--crop-w/);
  assert.equal(/infinite/.test(css), false);
  const js = readFileSync(path.join(activity, 'js', 'ui', 'cardlook.js'), 'utf8');
  assert.equal(/\/\/ |\/\*|innerHTML|outerHTML|localStorage|fetch\(|requestAnimationFrame\(/.test(js), false);
  const html = readFileSync(path.join(activity, 'index.html'), 'utf8');
  assert.equal(html.includes('profilecard-look.css'), false, 'not part of the first load');
});

test('a downloaded name font loads the lazy font sheet once, a device font never does', async () => {
  setLevel('full');
  const first = await setup(profile({ nameFont: 'serif' }));
  first.face.click();
  await flush();
  assert.equal(first.document.querySelectorAll('link[data-pcard-fonts]').length, 0);
  first.pc.close();
  const { document, face, pc } = await setup(profile({ nameFont: 'pacifico' }));
  face.click();
  await flush();
  const name = pc.el.querySelector('.pcard-name');
  assert.ok(name.classList.contains('font-pacifico'));
  const links = document.querySelectorAll('link[data-pcard-fonts]');
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute('href'), '/activity/css/profilecard-fonts.css');
  pc.close();
  pc.open(ID);
  await flush();
  assert.equal(document.querySelectorAll('link[data-pcard-fonts]').length, 1);
  pc.close();
});
