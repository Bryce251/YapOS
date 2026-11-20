import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, flush, FakeEvent } from './dom-shim.js';
import { makeGif, makeAnimWebp } from './motion-fixtures.js';

const { document, window } = installDom({ url: 'https://dash.example.test/u/bea' });
document.documentElement = document.createElement('html');
if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const profilePage = await import('../web/js/pages/profile.js');
const { profileCard, applyTheme, cropVars, effectStage, tiltFor, resetText, noticeLines, THEME_VARS } = profilePage;
const editor = await import('../web/js/pages/profile-editor.js');
const { openProfileEditor, processBanner, processMoving, stillPlan, encodeStill, themeTile, STILL_BYTES } = editor;
const fx = await import('../web/js/profile-fx.js');
const { normalizeProfile } = await import('../web/js/community-data.js');
const { readLook, cropBox, THEME_KEYS, THEMES, EFFECT_IDS } = await import('../web/js/profile-look.js');
const { RESET_PARTS, canReset, lookRows, readStaffProfile } = await import('../web/js/pages/party-person.js');
const { readOwnerLook } = await import('../web/js/pages/owner.js');
const { modLogSentence, actionLabel } = await import('../web/js/pages/party-modlog.js');

const GIF_URL = '/banner-img/b-abcdefghij-0123456789abcdef.gif';
const STILL_URL = '/banner-img/b-abcdefghij-fedcba9876543210-still.webp';

function profile() {
  return normalizeProfile({ profile: { username: 'bea', name: 'Bea', level: 3, xp: 400, badges: ['first-game', 'einstein'], achievements: [], season: [], party: { games: 4, wins: 1, favourites: [] } } });
}

function memoryStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

function fakeCanvasDoc(log = []) {
  return {
    hidden: false,
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    removeEventListener(type) {
      delete this.listeners[type];
    },
    createElement() {
      const canvas = {
        width: 0,
        height: 0,
        className: '',
        attrs: {},
        classList: { add() {} },
        setAttribute(k, v) {
          this.attrs[k] = v;
        },
        removed: false,
        remove() {
          this.removed = true;
        },
        toDataURL(type, q) {
          log.push(['encode', canvas.width, canvas.height, type, q]);
          return `data:${type};base64,${'A'.repeat(400)}`;
        },
        getContext() {
          const ctx = {
            canvas,
            draws: 0,
            translate() {},
            save() {},
            restore() {},
            rotate() {},
            beginPath() {},
            moveTo() {},
            lineTo() {},
            arc() {},
            ellipse() {},
            bezierCurveTo() {},
            quadraticCurveTo() {},
            fill() {},
            stroke() {},
            fillRect() {
              ctx.draws += 1;
            },
            clearRect() {},
            setTransform() {},
            drawImage(...args) {
              ctx.draws += 1;
              log.push(['draw', ...args.slice(1)]);
            },
            createRadialGradient: () => ({ addColorStop() {} }),
            createLinearGradient: () => ({ addColorStop() {} }),
          };
          canvas.ctx = ctx;
          return ctx;
        },
      };
      return canvas;
    },
  };
}

function fakeWin({ reduced = false, width = 1280, height = 800 } = {}) {
  const frames = [];
  return {
    frames,
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: 3,
    requestAnimationFrame: (fn) => {
      frames.push(fn);
      return frames.length;
    },
    cancelAnimationFrame: (id) => {
      frames[id - 1] = null;
    },
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }),
    run(n, step = 34) {
      for (let i = 0; i < n; i++) {
        const fn = frames.shift();
        if (fn) fn(1000 + i * step);
      }
    },
  };
}

test('a moving banner renders as a picture with a still for reduced motion and the exact crop', () => {
  const motion = { still: STILL_URL, width: 600, height: 200 };
  const look = readLook({ banner: 'image', bannerImage: GIF_URL, bannerCrop: { zoom: 2, x: 0.25, y: 0.5 }, bannerMotion: motion });
  assert.deepEqual(look.bannerMotion, motion);
  const card = profileCard(profile(), { look: look.look, bannerImage: look.bannerImage, bannerMotion: look.bannerMotion });
  const banner = card.querySelector('.profile-banner');
  assert.ok(banner.classList.contains('is-moving'));
  const source = banner.querySelector('source');
  assert.equal(source.getAttribute('media'), '(prefers-reduced-motion: reduce)');
  assert.equal(source.getAttribute('srcset'), STILL_URL);
  const img = banner.querySelector('.profile-banner-img');
  assert.equal(img.src || img.getAttribute('src'), GIF_URL);
  assert.ok(img.classList.contains('is-crop'));
  const box = cropBox(600, 200, { zoom: 2, x: 0.25, y: 0.5 });
  assert.deepEqual(box, { width: 200, height: 200, left: 0, top: -50 });
  assert.equal(img.style.props['--crop-w'], '200%');
  assert.equal(img.style.props['--crop-x'], '0%');
  assert.equal(img.style.props['--crop-y'], '-50%');
  const plain = profileCard(profile(), { look: readLook({ banner: 'image', bannerImage: GIF_URL }).look, bannerImage: GIF_URL });
  assert.equal(plain.querySelector('source'), null, 'without a still the banner is a normal picture');
  assert.equal(readLook({ banner: 'image', bannerImage: GIF_URL, bannerMotion: { still: 'https://evil.example/x.webp', width: 600, height: 200 } }).bannerMotion, null);
  assert.equal(readLook({ banner: 'image', bannerImage: GIF_URL, bannerMotion: { still: STILL_URL, width: 'x', height: 200 } }).bannerMotion, null);
  const el = document.createElement('img');
  cropVars(el, motion, null);
  assert.equal(el.style.props['--crop-w'], '100%');
  const css = readFileSync(new URL('../web/css/profile.css', import.meta.url), 'utf8');
  assert.match(css, /\.profile-banner-img\.is-crop,[^{]*\{[^}]*left: var\(--crop-x, 0%\);[^}]*width: var\(--crop-w, 100%\);/);
});

test('a theme colours the whole page through checked colour values only', () => {
  const site = document.createElement('div');
  const look = readLook({ theme: 'midnight', themeMode: 'dark', themePattern: 'stars' }).look;
  const pal = applyTheme(site, look);
  assert.equal(pal.id, 'midnight');
  assert.ok(site.classList.contains('has-ptheme'));
  assert.ok(site.classList.contains('pt-mode-dark'));
  assert.ok(site.classList.contains('pt-pat-stars'));
  assert.equal(THEME_VARS.length, THEME_KEYS.length);
  for (const v of THEME_VARS) {
    assert.match(site.style.props[`--ptl-${v}`], /^#[0-9a-f]{6}$/);
    assert.equal(site.style.props[`--ptl-${v}`], site.style.props[`--ptd-${v}`], 'always dark uses the dark colours in light mode too');
  }
  const auto = applyTheme(site, readLook({ theme: 'ocean' }).look);
  assert.equal(auto.mode, 'auto');
  assert.ok(site.classList.contains('pt-mode-auto'));
  assert.equal(site.classList.contains('pt-mode-dark'), false);
  assert.notEqual(site.style.props['--ptl-surface'], site.style.props['--ptd-surface']);
  assert.equal(applyTheme(site, readLook({}).look), null);
  assert.equal(site.classList.contains('has-ptheme'), false);
  assert.deepEqual(Object.keys(site.style.props), [], 'no theme leaves nothing behind');
  const evil = applyTheme(site, { theme: 'custom', themeCustom: { base: 'red;}*{', alt: '#000000', accent: '#000000' } });
  assert.equal(evil, null, 'colours that are not plain hex never reach the page');
  const css = readFileSync(new URL('../web/css/profile.css', import.meta.url), 'utf8');
  for (const v of ['bg', 'surface', 'surface-2', 'text', 'text-3', 'accent', 'on-accent', 'accent-text']) {
    assert.match(css, new RegExp(`--${v}: var\\(--ptl-${v}\\);`));
    assert.match(css, new RegExp(`--${v}: var\\(--ptd-${v}\\);`));
  }
  assert.match(css, /:root\[data-theme="dark"\] \.public-site\.has-ptheme \{/);
  assert.match(css, /\.public-site\.has-ptheme::before,/);
});

test('effects run on one capped canvas, respect reduced motion, pause when hidden and stop cleanly', () => {
  assert.equal(fx.fxCount('snow', 0, 0), fx.FX_MIN);
  assert.equal(fx.fxCount('snow', 4000, 3000), fx.FX_MAX);
  assert.equal(fx.fxCount('nope', 1000, 1000), 0);
  for (const id of EFFECT_IDS.filter((x) => x !== 'none')) assert.ok(fx.FX_KINDS.includes(id), id);
  const host = document.createElement('div');
  const doc = fakeCanvasDoc();
  const win = fakeWin();
  const run = fx.startEffect(host, 'snowflakes', { win, doc, rand: () => 0.5 });
  assert.equal(run.running, true);
  assert.equal(run.canvas.className, 'pfx-canvas');
  assert.equal(run.canvas.attrs['aria-hidden'], 'true');
  assert.equal(run.canvas.width, 1280 * fx.FX_DPR_MAX, 'device pixels are capped at 2x');
  assert.ok(run.particles() <= fx.FX_MAX);
  win.run(6);
  assert.ok(run.canvas.ctx.draws > 0, 'it draws');
  doc.hidden = true;
  doc.listeners.visibilitychange();
  const before = win.frames.filter(Boolean).length;
  win.run(3);
  assert.equal(win.frames.filter(Boolean).length, 0, 'no frames are asked for while the tab is hidden');
  assert.ok(before <= 1);
  doc.hidden = false;
  doc.listeners.visibilitychange();
  assert.equal(win.frames.filter(Boolean).length, 1, 'it picks up again');
  run.stop();
  assert.equal(run.canvas.removed, true);
  assert.equal(run.running, false);
  assert.equal(doc.listeners.visibilitychange, undefined);
  const still = fakeWin({ reduced: true });
  const sdoc = fakeCanvasDoc();
  const calm = fx.startEffect(host, 'confetti', { win: still, doc: sdoc });
  assert.equal(still.frames.length, 0, 'with reduced motion nothing animates');
  assert.ok(calm.canvas.ctx.draws > 0, 'a still, softer frame is drawn instead');
  calm.stop();
  const none = fx.startEffect(host, 'none', { win, doc });
  assert.equal(none.running, false);
  const flat = fx.startEffect(host, 'snow', { win, doc: { createElement: () => ({}) } });
  assert.equal(flat.running, false, 'no canvas support means no effect and no error');
  for (const id of fx.FX_KINDS) {
    const list = fx.makeParticles(id, 20, 400, 300);
    for (let i = 0; i < 200; i++) fx.stepParticles(id, list, 1 / 30, 400, 300, i / 30);
    for (const p of list) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), id);
      assert.ok(p.x > -400 && p.x < 800 && p.y > -100 && p.y < 400, `${id} stays near the screen`);
    }
  }
  assert.ok(fx.effectThumb('hearts', { doc: fakeCanvasDoc() }).ctx.draws > 0);
  assert.equal(fx.effectThumb('none', { doc: fakeCanvasDoc() }), null);
});

test('visitors can switch effects off and the choice is remembered even when storage fails', () => {
  const store = memoryStore();
  assert.equal(fx.effectsAllowed(store), true);
  fx.setEffectsAllowed(false, store);
  assert.equal(store.getItem(fx.FX_KEY), 'off');
  assert.equal(fx.effectsAllowed(store), false);
  fx.setEffectsAllowed(true, store);
  assert.equal(fx.effectsAllowed(store), true);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(fx.effectsAllowed(broken), true);
  assert.doesNotThrow(() => fx.setEffectsAllowed(false, broken));
  const p = profile();
  const toggled = [];
  const look = readLook({ effect: 'snow' }).look;
  const card = profileCard(p, { look, fx: { toggle: (on) => toggled.push(on) } });
  const btn = card.querySelector('.profile-fx-toggle');
  assert.ok(btn);
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  assert.equal(profileCard(p, { look, editing: true, fx: { toggle() {} } }).querySelector('.profile-fx-toggle'), null, 'the preview has no switch');
  assert.equal(profileCard(p, { look: readLook({}).look, fx: { toggle() {} } }).querySelector('.profile-fx-toggle'), null);
  const stage = effectStage(document.createElement('div'), { win: fakeWin(), doc: fakeCanvasDoc() });
  stage.set('snow');
  assert.equal(stage.id, 'snow');
  stage.stop();
  assert.equal(stage.running, false);
});

test('badges tilt toward the pointer and the CSS turns motion off for reduced motion', () => {
  assert.deepEqual(tiltFor(50, 50, { left: 0, top: 0, width: 100, height: 100 }), { rx: 0, ry: 0, gx: 50, gy: 50 });
  const corner = tiltFor(100, 0, { left: 0, top: 0, width: 100, height: 100 });
  assert.equal(corner.ry, 10);
  assert.equal(corner.rx, 10);
  assert.deepEqual(tiltFor(-50, 500, { left: 0, top: 0, width: 100, height: 100 }), { rx: -10, ry: -10, gx: 0, gy: 100 });
  const css = readFileSync(new URL('../web/css/profile.css', import.meta.url), 'utf8');
  const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.is-tilting[^{]*\{[^}]*transform: none/);
  assert.match(reduced, /animation: none/);
  assert.match(css, /\.pfx-canvas \{[^}]*pointer-events: none/);
  assert.match(css, /\.profile-card\.is-enter \.badge-tile,[^{]*\{[^}]*backwards/, 'entrance animations never hold a transform after they end');
});

test('the editor has a Theme tab with live theme and effect previews', async () => {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const seen = [];
  const ed = openProfileEditor({
    mount,
    profile: profile(),
    look: readLook({}).look,
    api: { post: async () => ({}), request: async () => ({}) },
    renderCard: () => document.createElement('div'),
    onLook: (l) => seen.push({ theme: l.theme, effect: l.effect, custom: l.themeCustom, mode: l.themeMode }),
  });
  ed.showTab('theme');
  await flush();
  const tiles = mount.querySelectorAll('.pe-theme');
  assert.equal(tiles.length, THEMES.length + 2);
  assert.equal(mount.querySelectorAll('.pe-effect').length, EFFECT_IDS.length);
  const thumb = mount.querySelector('.pe-theme[data-choice="sakura"]').querySelector('.pe-theme-thumb');
  assert.match(thumb.style.props['--tt-bg'], /^#[0-9a-f]{6}$/);
  mount.querySelector('.pe-theme[data-choice="neon"]').click();
  assert.deepEqual(seen[seen.length - 1], { theme: 'neon', effect: 'none', custom: null, mode: 'dark' }, 'a theme brings its own light or dark choice');
  mount.querySelector('.pe-effect[data-choice="sakura"]').click();
  assert.equal(seen[seen.length - 1].effect, 'sakura');
  mount.querySelector('.pe-theme[data-choice="custom"]').click();
  const custom = seen[seen.length - 1];
  assert.equal(custom.theme, 'custom');
  assert.deepEqual(Object.keys(custom.custom), ['base', 'alt', 'accent'], 'custom starts from the theme you had');
  assert.equal(mount.querySelector('.pe-theme-custom').hidden, false);
  const hex = mount.querySelector('.pe-theme-custom .pe-hex');
  hex.value = '#ABC';
  hex.dispatchEvent(new FakeEvent('change'));
  assert.equal(ed.draft.themeCustom.base, '#aabbcc');
  hex.value = 'url(x)';
  hex.dispatchEvent(new FakeEvent('change'));
  assert.equal(ed.draft.themeCustom.base, '#aabbcc', 'bad colours are not taken');
  mount.querySelector('.pe-theme[data-choice="none"]').click();
  assert.equal(ed.draft.theme, 'none');
  assert.equal(mount.querySelector('.pe-theme-options').hidden, true);
  ed.reset();
  assert.equal(ed.draft.effect, 'none');
  const tile = themeTile(THEMES[0], 'Midnight');
  assert.equal(tile[1].textContent, 'Midnight');
  mount.remove();
});

test('picking a moving GIF opens the moving cropper and sends the GIF, a still and the crop', async () => {
  const gif = makeGif({ width: 600, height: 200, frames: 3 });
  const file = {
    size: gif.length,
    type: 'image/gif',
    name: 'party.gif',
    slice: (a, b) => ({ arrayBuffer: async () => gif.slice(a, b).buffer }),
    arrayBuffer: async () => gif.slice().buffer,
  };
  globalThis.createImageBitmap = async () => ({ width: 600, height: 200, close() {} });
  try {
    const asked = [];
    const log = [];
    const out = await processBanner(file, {
      choose: async (src, opts) => {
        asked.push([src.width, src.height, opts.moving]);
        return { zoom: 1.4, x: 0.3, y: 0.5 };
      },
      readUrl: async () => 'data:image/gif;base64,R0lGOD',
      doc: fakeCanvasDoc(log),
    });
    assert.deepEqual(asked, [[600, 200, 'data:image/gif;base64,R0lGOD']]);
    assert.equal(out.image, 'data:image/gif;base64,R0lGOD');
    assert.match(out.still, /^data:image\/webp;base64,/);
    assert.deepEqual(out.crop, { zoom: 1.4, x: 0.3, y: 0.5 });
    assert.equal(out.frames, 3);
    assert.deepEqual(log.find((l) => l[0] === 'encode').slice(1, 3), [600, 200], 'the still keeps the GIF shape');
    assert.equal(await processBanner(file, { choose: async () => null, readUrl: async () => 'data:,', doc: fakeCanvasDoc() }), null, 'cancelling uploads nothing');
    const huge = makeGif({ width: 600, height: 200, frames: 2, comment: 'x'.repeat(10 * 1024 * 1024) });
    assert.ok(huge.length > 10 * 1024 * 1024 && huge.length < 10 * 1024 * 1024 + 64 * 1024);
    const big = { ...file, size: huge.length, slice: (a, b) => ({ arrayBuffer: async () => huge.slice(a, b).buffer }), arrayBuffer: async () => huge.slice().buffer };
    await assert.rejects(processBanner(big, { choose: async () => ({ zoom: 1, x: 0.5, y: 0.5 }) }), /bigger than 10 MB/);
    await assert.rejects(processBanner({ ...big, size: 10 * 1024 * 1024 }, { choose: async () => ({ zoom: 1, x: 0.5, y: 0.5 }) }), /Moving banners can be up to 10 MB, and this one is 10\.0\d MB/);
    const under = makeGif({ width: 600, height: 200, frames: 2, comment: 'x'.repeat(10 * 1024 * 1024 - 64 * 1024) });
    assert.ok(under.length < 10 * 1024 * 1024 && under.length > 9.9 * 1024 * 1024);
    const nearly = { ...file, size: under.length, slice: (a, b) => ({ arrayBuffer: async () => under.slice(a, b).buffer }), arrayBuffer: async () => under.slice().buffer };
    const nearOut = await processBanner(nearly, { choose: async () => ({ zoom: 1, x: 0.5, y: 0.5 }), readUrl: async () => 'data:image/gif;base64,R0lGOD', doc: fakeCanvasDoc() });
    assert.equal(nearOut.frames, 2, 'a moving banner just under 10 MB is accepted');
    const many = makeGif({ width: 3200, height: 1000, frames: 2 });
    const wide = { ...file, size: many.length, slice: (a, b) => ({ arrayBuffer: async () => many.slice(a, b).buffer }), arrayBuffer: async () => many.slice().buffer };
    await assert.rejects(processBanner(wide, { choose: async () => ({ zoom: 1, x: 0.5, y: 0.5 }) }), /3000 pixels wide/);
    const webp = makeAnimWebp();
    const wfile = { ...file, type: 'image/webp', name: 'a.webp', size: webp.length, slice: (a, b) => ({ arrayBuffer: async () => webp.slice(a, b).buffer }), arrayBuffer: async () => webp.slice().buffer };
    const wout = await processBanner(wfile, { choose: async () => ({ zoom: 1, x: 0.5, y: 0.5 }), readUrl: async () => 'data:image/webp;base64,UklG', doc: fakeCanvasDoc() });
    assert.equal(wout.frames, 2, 'animated WebP keeps moving too');
  } finally {
    delete globalThis.createImageBitmap;
  }
  assert.deepEqual(stillPlan(3000, 1000), [{ w: 1500, h: 500 }, { w: 1000, h: 333 }, { w: 700, h: 233 }]);
  assert.deepEqual(stillPlan(400, 100), [{ w: 400, h: 100 }]);
  const tooBig = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }), toDataURL: (type) => `data:${type};base64,${'A'.repeat(Math.ceil((STILL_BYTES * 4) / 3) + 400)}` }) };
  assert.throws(() => encodeStill({ width: 600, height: 200 }, { doc: tooBig }), /couldn't be turned into a banner/);
});

test('staff tools, the owner panel, the mod log and the owner notice know about themes and effects', () => {
  assert.deepEqual(RESET_PARTS.map((r) => r.part), ['banner', 'avatar', 'bio', 'status', 'pronouns', 'name-style', 'pins', 'theme', 'effect', 'all']);
  const staff = readStaffProfile({ look: { theme: 'ember', effect: 'embers', banner: GIF_URL, bannerStill: STILL_URL, bannerAnimated: true, custom: true }, canAct: true });
  assert.deepEqual([staff.look.theme, staff.look.effect, staff.look.banner, staff.look.bannerStill], ['ember', 'embers', GIF_URL, STILL_URL]);
  assert.equal(canReset(staff.look, 'theme'), true);
  assert.equal(canReset(staff.look, 'effect'), true);
  assert.equal(canReset({ ...staff.look, theme: 'none', effect: 'none' }, 'theme'), false);
  const rows = Object.fromEntries(lookRows(staff.look));
  assert.equal(rows.Theme, 'Ember');
  assert.equal(rows.Effect, 'Embers');
  assert.equal(rows.Banner, 'Moving banner');
  assert.equal(readStaffProfile({ look: { theme: 'x;y', effect: '<b>' } }).look.theme, 'none');
  const owner = readOwnerLook({ theme: 'custom', effect: 'rain', banner: GIF_URL, bannerStill: STILL_URL });
  assert.deepEqual([owner.theme, owner.effect, owner.banner, owner.bannerStill], ['custom', 'rain', GIF_URL, STILL_URL]);
  assert.deepEqual([readOwnerLook({ effect: 'none' }).effect, readOwnerLook(null).theme], ['none', 'none']);
  const entry = (action, detail = {}) => ({ action, actor: { name: 'Jolli' }, target: { name: 'Rex' }, detail });
  assert.equal(modLogSentence(entry('profile_theme_reset', { theme: 'ember' })), "Jolli reset Rex's profile theme");
  assert.equal(modLogSentence(entry('profile_effect_clear', { effect: 'embers' })), "Jolli turned off Rex's profile effect");
  assert.equal(actionLabel('profile_theme_reset'), 'Profile themes reset');
  assert.equal(resetText({ action: 'profile_theme_reset' }), 'your profile theme was reset');
  assert.match(noticeLines({ resets: [{ action: 'profile_effect_clear', at: 1 }, { action: 'profile_theme_reset', at: 2 }] })[0].text, /profile effect was turned off and your profile theme was reset/);
});
