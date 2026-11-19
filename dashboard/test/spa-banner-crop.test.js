import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, flush, FakeEvent } from './dom-shim.js';

const { document } = installDom({ url: 'https://dash.example.test/u/bea' });
document.documentElement = document.createElement('html');
if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const profilePage = await import('../web/js/pages/profile.js');
const { profileCard, allBadges } = profilePage;
const editor = await import('../web/js/pages/profile-editor.js');
const {
  BANNER_W, BANNER_H, BANNER_BYTES, BANNER_MAX_OUT_W, CROP_MAX_ZOOM, coverSize, maxZoom, startView, clampView, cropRect, panView, zoomView, setZoom,
  outputSize, downscaleSteps, encodePlan, softNote, encodeBanner, chooseBannerCrop, processBanner, openProfileEditor,
} = editor;
const { BANNER_MAX, BANNER_MAX_W, BANNER_MAX_H } = await import('../worker/profile-custom.js');
const { normalizeProfile } = await import('../web/js/community-data.js');
const { readLook } = await import('../web/js/profile-look.js');
const { cleanCard, cardModel } = await import('../web/activity/js/ui/profilecard.js');

const HINTS = { 'first-game': 'Finish your first YapOS Party game.', 'wins-10': 'Win 10 YapOS Party games.' };
const PNG_HEAD = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);

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

function fakeDoc(log, { webp = true, bytes = () => 1000 } = {}) {
  const made = [];
  return {
    made,
    createElement() {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: (from, ...args) => log.push(['draw', from === canvas ? 'self' : made.indexOf(from), ...args]) }),
        toDataURL(type, q) {
          log.push(['encode', canvas.width, type, q]);
          if (type === 'image/webp' && !webp) return 'data:image/png;base64,AAAA';
          return `data:${type};base64,${'A'.repeat(Math.ceil((bytes(canvas.width, type, q) * 4) / 3))}`;
        },
      };
      made.push(canvas);
      return canvas;
    },
  };
}

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.02, `${msg || ''} ${a} vs ${b}`);

test('banners are stored up to 3000 by 1000 for sharp 2x screens, and the client stays under the server cap', () => {
  assert.deepEqual([BANNER_W, BANNER_H, BANNER_MAX_OUT_W], [1500, 500, 3000]);
  assert.equal(BANNER_MAX_W, BANNER_MAX_OUT_W);
  assert.equal(BANNER_MAX_H, BANNER_MAX_OUT_W / 3);
  assert.ok(BANNER_BYTES < BANNER_MAX, 'what the editor makes always passes the server check');
  assert.ok(BANNER_BYTES >= 700 * 1024);
  assert.deepEqual(outputSize({ sw: 4000 }), { width: 3000, height: 1000 });
  assert.deepEqual(outputSize({ sw: 1500 }), { width: 1500, height: 500 });
  assert.deepEqual(outputSize({ sw: 900 }), { width: 900, height: 300 }, 'small pictures are not blown up');
  assert.deepEqual(outputSize({ sw: 200 }), { width: 600, height: 200 }, 'only up to the smallest size the server takes');
  assert.deepEqual(downscaleSteps(12000, 3000), [6000, 3000], 'big pictures shrink by halves');
  assert.deepEqual(downscaleSteps(5000, 3000), [3000]);
  assert.deepEqual(downscaleSteps(900, 900), [900]);
  const plan = encodePlan(3000);
  assert.deepEqual(plan[0], { type: 'image/webp', w: 3000, q: 0.92 }, 'starts at high quality WebP');
  assert.deepEqual([...new Set(plan.filter((p) => p.type === 'image/webp').map((p) => p.w))], [3000, 2400, 1800, 1500]);
  assert.ok(plan.findIndex((p) => p.w === 2400) > plan.findIndex((p) => p.w === 3000 && p.q === 0.8), 'quality steps down a little before the size does');
  assert.ok(plan.filter((p) => p.type === 'image/webp' && p.q < 0.8).every((p) => p.w === 1500), 'low quality is a last resort at 1500 wide');
  assert.deepEqual([...new Set(encodePlan(1200).map((p) => p.w))], [1200]);
});

test('the encoder draws the crop once at full size, steps quality down only when needed, and falls back to JPEG', () => {
  const log = [];
  const doc = fakeDoc(log);
  const url = encodeBanner({ width: 3000, height: 1500 }, { doc });
  assert.match(url, /^data:image\/webp;base64,/);
  assert.deepEqual([doc.made[0].width, doc.made[0].height], [3000, 1000]);
  assert.deepEqual(log[0], ['draw', -1, 0, 250, 3000, 1000, 0, 0, 3000, 1000]);
  assert.deepEqual(log[1], ['encode', 3000, 'image/webp', 0.92]);
  assert.equal(log.length, 2);
  const big = [];
  const bigDoc = fakeDoc(big);
  encodeBanner({ width: 9000, height: 3000 }, { doc: bigDoc, rect: { sx: 0, sy: 0, sw: 9000, sh: 3000 } });
  assert.deepEqual(big.slice(0, 2), [['draw', -1, 0, 0, 9000, 3000, 0, 0, 4500, 1500], ['draw', 0, 0, 0, 4500, 1500, 0, 0, 3000, 1000]]);
  const steps = [];
  encodeBanner({ width: 3000, height: 1000 }, { doc: fakeDoc(steps, { bytes: (w, t, q) => (q > 0.87 ? BANNER_BYTES + 1 : 1000) }) });
  assert.deepEqual(steps.filter((e) => e[0] === 'encode'), [['encode', 3000, 'image/webp', 0.92], ['encode', 3000, 'image/webp', 0.86]]);
  const smaller = [];
  const smallerDoc = fakeDoc(smaller, { bytes: (w) => (w > 2400 ? BANNER_BYTES + 1 : 1000) });
  encodeBanner({ width: 3000, height: 1000 }, { doc: smallerDoc });
  assert.deepEqual(smaller.filter((e) => e[0] === 'encode').at(-1), ['encode', 2400, 'image/webp', 0.92]);
  assert.deepEqual(smaller.filter((e) => e[0] === 'draw').map((e) => e.slice(-2)), [[3000, 1000], [2400, 800]], 'each size is drawn from the picture once');
  const jpegLog = [];
  const jpeg = encodeBanner({ width: 1500, height: 500 }, { doc: fakeDoc(jpegLog, { webp: false }) });
  assert.match(jpeg, /^data:image\/jpeg;base64,/);
  assert.deepEqual(jpegLog.filter((e) => e[0] === 'encode').map((e) => e[2]), ['image/webp', 'image/jpeg']);
  const small = [];
  encodeBanner({ width: 900, height: 300 }, { doc: fakeDoc(small) });
  assert.deepEqual(small[0], ['draw', -1, 0, 0, 900, 300, 0, 0, 900, 300]);
  assert.throws(() => encodeBanner({ width: 1500, height: 500 }, { doc: fakeDoc([], { bytes: () => BANNER_BYTES + 10 }) }), /too detailed/);
});

test('crop maths: zoom covers the frame, the crop stays 3:1 and inside the picture, and zoom keeps the point under the pointer', () => {
  assert.deepEqual(coverSize(3000, 500), { sw: 1500, sh: 500 });
  assert.deepEqual(cropRect(3000, 1500, startView(3000, 1500)), { sx: 0, sy: 250, sw: 3000, sh: 1000 });
  assert.deepEqual(cropRect(3000, 1500, { zoom: 2, cx: 1500, cy: 750 }), { sx: 750, sy: 500, sw: 1500, sh: 500 });
  assert.deepEqual(cropRect(3000, 1500, { zoom: 2, cx: 99999, cy: -5 }), { sx: 1500, sy: 0, sw: 1500, sh: 500 });
  assert.equal(clampView(3000, 1500, { zoom: 0.2 }).zoom, 1, 'you can never zoom out past covering the frame');
  assert.equal(clampView(3000, 1500, { zoom: 99 }).zoom, CROP_MAX_ZOOM);
  assert.equal(maxZoom(9000, 3000), 6, 'very big pictures can zoom until 1500 pixels are left');
  assert.equal(maxZoom(30000, 10000), 8);
  assert.equal(maxZoom(800, 400), CROP_MAX_ZOOM);
  for (const [w, ht] of [[3000, 1500], [1000, 1000], [4000, 500], [1501, 500]]) {
    const r = cropRect(w, ht, { zoom: 1.7, cx: w * 0.9, cy: ht * 0.1 });
    near(r.sw / r.sh, 3, `${w}x${ht} ratio`);
    assert.ok(r.sx >= 0 && r.sy >= 0 && r.sx + r.sw <= w + 0.01 && r.sy + r.sh <= ht + 0.01, `${w}x${ht} inside`);
  }
  const panned = panView(3000, 1500, { zoom: 2, cx: 1500, cy: 750 }, 100, 0, 200);
  assert.deepEqual(cropRect(3000, 1500, panned), { sx: 0, sy: 500, sw: 1500, sh: 500 }, 'dragging the picture right shows more of its left side');
  const down = panView(3000, 1500, { zoom: 2, cx: 1500, cy: 750 }, 0, -40, 200);
  assert.equal(cropRect(3000, 1500, down).sy, 800);
  const start = startView(3000, 1500);
  const z = zoomView(3000, 1500, start, 2, 0, 0.5);
  assert.deepEqual(cropRect(3000, 1500, z), { sx: 0, sy: 500, sw: 1500, sh: 500 }, 'zooming at the left edge keeps the left edge');
  const zr = zoomView(3000, 1500, start, 2, 0.75, 0.25);
  const before = cropRect(3000, 1500, start);
  const after = cropRect(3000, 1500, zr);
  near(before.sx + 0.75 * before.sw, after.sx + 0.75 * after.sw, 'x under the pointer');
  near(before.sy + 0.25 * before.sh, after.sy + 0.25 * after.sh, 'y under the pointer');
  assert.equal(setZoom(3000, 1500, start, 3).zoom, 3);
  assert.equal(setZoom(3000, 1500, start, 'x').zoom, 1);
  assert.equal(softNote(3000, 1000, cropRect(3000, 1000, start)), '');
  assert.match(softNote(900, 300, cropRect(900, 300, startView(900, 300))), /smaller than 1500 by 500/);
  assert.match(softNote(3000, 1000, cropRect(3000, 1000, { zoom: 4 })), /only 750 pixels/);
});

function openCrop(src) {
  const pick = chooseBannerCrop(src);
  const root = document.querySelector('.pe-crop');
  const stage = root.querySelector('.pe-crop-stage');
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 300, right: 600, bottom: 300 });
  return { pick, root, stage, range: root.querySelector('.pe-crop-range'), level: root.querySelector('.pe-crop-level') };
}

const key = (el, k, extra = {}) => el.dispatchEvent(Object.assign(new FakeEvent('keydown', { key: k }), extra));
const pointer = (el, type, id, x, y) => el.dispatchEvent(Object.assign(new FakeEvent(type), { pointerId: id, clientX: x, clientY: y }));

test('every upload opens the cropper, even a picture that is already 3:1, with accessible zoom and move controls', async () => {
  const { pick, root, stage, range, level } = openCrop({ width: 3000, height: 1000 });
  assert.ok(root, 'the crop dialog opens for a 3:1 picture too');
  assert.equal(root.querySelector('.pe-crop-panel').getAttribute('role'), 'dialog');
  assert.equal(document.activeElement, stage);
  assert.equal(stage.getAttribute('tabindex'), '0');
  assert.match(stage.getAttribute('aria-label'), /Drag/);
  assert.equal(range.getAttribute('aria-label'), 'Zoom');
  assert.deepEqual([range.getAttribute('min'), range.getAttribute('max')], ['1', '4']);
  assert.equal(level.textContent, '100%');
  assert.equal(root.querySelector('.pe-crop-out').disabled, true, 'you cannot zoom out past covering the frame');
  assert.ok(root.querySelector('.pe-crop-frame'), 'a 3:1 frame sits over the picture');
  assert.deepEqual(root.querySelectorAll('.pe-crop-prev-label').map((n) => n.textContent), ['On your profile', 'On the Party card']);
  key(stage, '+');
  assert.equal(level.textContent, '110%');
  assert.equal(range.getAttribute('aria-valuetext'), '110%');
  key(stage, '=');
  assert.equal(level.textContent, '121%');
  key(stage, '-');
  assert.equal(level.textContent, '110%');
  key(stage, 'ArrowRight');
  key(stage, 'ArrowDown', { shiftKey: true });
  root.querySelector('.pe-crop-in').click();
  assert.equal(level.textContent, '121%');
  range.value = '4';
  range.dispatchEvent(new FakeEvent('input'));
  assert.equal(level.textContent, '400%');
  assert.equal(root.querySelector('.pe-crop-in').disabled, true);
  assert.equal(root.querySelector('.pe-crop-note').hidden, false, 'zooming past the picture detail warns that it will look soft');
  assert.match(root.querySelector('.pe-crop-note').textContent, /soft/);
  key(stage, '0');
  assert.equal(level.textContent, '100%');
  assert.equal(root.querySelector('.pe-crop-note').hidden, true);
  key(stage, '+');
  root.querySelector('.pe-crop-reset').click();
  assert.equal(level.textContent, '100%');
  root.querySelector('.pe-crop-ok').click();
  assert.deepEqual(await pick, { sx: 0, sy: 0, sw: 3000, sh: 1000 });
  assert.equal(document.querySelector('.pe-crop'), null);
});

test('drag, wheel and pinch move and zoom the picture, and the chosen crop is returned', async () => {
  const { pick, root, stage, level } = openCrop({ width: 3000, height: 1500 });
  const wheel = Object.assign(new FakeEvent('wheel'), { deltaY: -200, deltaMode: 0, clientX: 300, clientY: 150 });
  stage.dispatchEvent(wheel);
  assert.equal(wheel.defaultPrevented, true, 'the page does not scroll while zooming');
  assert.equal(level.textContent, `${Math.round(Math.exp(0.4) * 100)}%`);
  root.querySelector('.pe-crop-reset').click();
  pointer(stage, 'pointerdown', 1, 100, 100);
  pointer(stage, 'pointermove', 1, 100, 160);
  pointer(stage, 'pointerup', 1, 100, 160);
  assert.equal(level.textContent, '100%');
  pointer(stage, 'pointerdown', 1, 200, 150);
  pointer(stage, 'pointerdown', 2, 400, 150);
  pointer(stage, 'pointermove', 2, 600, 150);
  assert.equal(level.textContent, '200%', 'spreading two fingers twice as far zooms in twice');
  pointer(stage, 'pointerup', 2, 600, 150);
  pointer(stage, 'pointermove', 1, 200, 150);
  pointer(stage, 'pointerup', 1, 200, 150);
  assert.equal(stage.classList.contains('is-dragging'), false);
  root.querySelector('.pe-crop-ok').click();
  const r = await pick;
  near(r.sw, 1500);
  near(r.sw / r.sh, 3);
  const second = openCrop({ width: 3000, height: 1500 });
  pointer(second.stage, 'pointerdown', 7, 300, 150);
  pointer(second.stage, 'pointermove', 7, 300, 90);
  pointer(second.stage, 'pointerup', 7, 300, 90);
  second.root.querySelector('.pe-crop-ok').click();
  const moved = await second.pick;
  assert.equal(moved.sw, 3000);
  assert.ok(moved.sy > 250, 'dragging the picture up shows more of its bottom');
});

test('cancel, Escape and the backdrop close the cropper without a crop', async () => {
  const a = openCrop({ width: 1000, height: 1000 });
  document.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
  assert.equal(await a.pick, null);
  const b = openCrop({ width: 1000, height: 1000 });
  b.root.querySelector('.pe-crop-cancel').click();
  assert.equal(await b.pick, null);
  const c = openCrop({ width: 1000, height: 1000 });
  c.root.querySelector('.dialog-overlay').click();
  assert.equal(await c.pick, null);
  assert.equal(document.querySelector('.pe-crop'), null);
});

test('cancelling the cropper uploads nothing', async () => {
  const file = { size: 10, type: 'image/png', name: 'a.png', slice: () => ({ arrayBuffer: async () => PNG_HEAD.buffer }) };
  globalThis.createImageBitmap = async () => ({ width: 3000, height: 1000, close() {} });
  try {
    assert.equal(await processBanner(file, { choose: async () => null }), null);
    const posts = [];
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const ed = openProfileEditor({
      mount,
      profile: profile(),
      look: readLook({}).look,
      hints: HINTS,
      api: { post: async (...args) => { posts.push(args); return {}; }, request: async () => ({}) },
      renderCard: () => document.createElement('div'),
    });
    ed.showTab('card');
    const input = mount.querySelector('.pe-upload').parentNode.querySelectorAll('input').find((i) => (i.type || i.getAttribute('type')) === 'file');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new FakeEvent('change'));
    for (let i = 0; i < 5 && !document.querySelector('.pe-crop'); i++) await flush();
    assert.ok(document.querySelector('.pe-crop'), 'picking a file opens the cropper');
    document.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
    await flush();
    await flush();
    assert.deepEqual(posts, []);
    assert.equal(mount.querySelector('.pe-error').hidden, true, 'cancelling is not an error');
    mount.remove();
  } finally {
    delete globalThis.createImageBitmap;
  }
});

test('the profile banner scrolls away with the page: no sticky or shrinking banner', () => {
  assert.equal(profilePage.shrinkBanner, undefined);
  assert.equal(profilePage.SHRINK_VAR, undefined);
  const card = profileCard(profile(), { look: readLook({ banner: 'image', bannerImage: '/banner-img/b-abcdefghij-0123456789abcdef.webp' }).look, bannerImage: '/banner-img/b-abcdefghij-0123456789abcdef.webp', hints: HINTS });
  assert.equal(card.classList.contains('can-shrink'), false);
  const img = card.querySelector('.profile-banner-img');
  assert.equal(img.getAttribute('loading'), null, 'the banner at the top of the page is not lazy loaded');
  assert.equal(card.style.props['--shrink'], undefined);
  const css = readFileSync(new URL('../web/css/profile.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /can-shrink|--shrink|--sticky-top/);
  for (const m of css.matchAll(/([^{}]*)\{([^}]*position: sticky[^}]*)\}/g)) assert.doesNotMatch(m[1], /banner|profile-card|avatar/, `${m[1].trim()} is not sticky`);
  assert.match(css, /\.profile-banner \{[^}]*aspect-ratio: 3 \/ 1/);
  assert.doesNotMatch(css.slice(css.indexOf('.profile-banner {')).split('}')[0], /border|padding/, 'nothing eats into the 3:1 box');
  assert.match(css, /\.profile-banner-img \{[^}]*inset: 0;[^}]*object-fit: cover/);
  const owner = readFileSync(new URL('../web/css/owner.css', import.meta.url), 'utf8');
  const ownerRule = owner.slice(owner.indexOf('.owner-look-banner {')).split('}')[0];
  assert.match(ownerRule, /aspect-ratio: 3 \/ 1/);
  assert.doesNotMatch(ownerRule, /\bborder:/, 'the staff preview is not cropped by a border');
});

test('the banner is never pulled under the accent border, where the card would clip its top edge', () => {
  const css = readFileSync(new URL('../web/css/profile.css', import.meta.url), 'utf8');
  assert.match(css, /\.profile-card\.has-accent \{[^}]*border-top: 3px/);
  assert.match(css, /\.profile-card \{[^}]*overflow: hidden/);
  for (const m of css.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
    if (!/\.profile-banner\b/.test(m[1]) || /\.profile-banner-img/.test(m[1])) continue;
    assert.doesNotMatch(m[2], /-\s*3px/, `${m[1].trim()} does not reach under the 3px accent border`);
  }
});

test('the cropper keeps its buttons in view and its stage steady when the soft note appears', () => {
  const css = readFileSync(new URL('../web/css/profile.css', import.meta.url), 'utf8');
  const panel = css.slice(css.indexOf('.pe-crop-panel {')).split('}')[0];
  assert.match(panel, /overflow-y: auto/);
  assert.match(panel, /scrollbar-gutter: stable/);
  const actions = css.slice(css.indexOf('.pe-crop .dialog-actions {')).split('}')[0];
  assert.match(actions, /position: sticky/);
  assert.match(actions, /bottom: 0/);
  assert.match(actions, /background: var\(--surface\)/);
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
