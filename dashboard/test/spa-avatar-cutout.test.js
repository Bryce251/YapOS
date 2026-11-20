import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, flush } from './dom-shim.js';

const { document } = installDom({ url: 'https://dash.example.test/u/bea' });
document.documentElement = document.createElement('html');
if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const { avatar } = await import('../web/js/ui.js');
const bd = await import('../web/js/avatar-backdrop.js');
const av = await import('../web/js/pages/avatar-editor.js');
const party = await import('../web/activity/js/ui/dom.js');
const { THEMES } = await import('../web/js/profile-look.js');
const rules = await import('../web/js/avatar-rules.js');

const CUT = '/avatar-img/a-abcdefghij-0123456789abcdef.png';
const PLAIN = '/avatar-img/a-abcdefghij-1111111111111111.png';
const GIF = '/avatar-img/a-klmnopqrst-0123456789abcdef.gif';
const GIF_STILL = '/avatar-img/a-klmnopqrst-fedcba9876543210-still.webp';
const YAPIN = 'https://files.yapper.website/avatars/u1/r2-1-a.png';

function lookups(looks) {
  const asked = [];
  bd.resetBackdrops();
  bd.setBackdropFetch(async (url) => {
    asked.push(url);
    return { ok: true, json: async () => ({ looks }) };
  });
  return asked;
}

test('site avatars of cut-out pictures get their backdrop from one batched look-up, with no inline style text', async () => {
  const asked = lookups({
    'a-abcdefghij': { cut: true, moving: false, clear: false, stops: ['#112233', '#445566'], ring: '#778899' },
    'a-klmnopqrst': { cut: false, moving: true, clear: false, stops: ['#aa0000', '#00aa00'], ring: '#0000aa' },
  });
  const big = avatar({ name: 'Bea', url: CUT, id: 'x', size: 'xl' });
  const small = avatar({ name: 'Bea', url: CUT, id: 'x', size: 'sm' });
  const gif = avatar({ name: 'Gus', url: GIF, still: GIF_STILL, animate: false, id: 'y', size: 'sm' });
  const yapin = avatar({ name: 'Yap', url: YAPIN, id: 'z' });
  document.body.appendChild(big);
  await bd.flushBackdrops();
  assert.deepEqual(asked, ['/api/avatars/looks?ids=a-abcdefghij,a-klmnopqrst']);
  for (const el of [big, small]) {
    assert.equal(el.classList.contains('av-cut'), true);
    assert.equal(el.style.props['--av-bd-1'], '#112233');
    assert.equal(el.style.props['--av-bd-2'], '#445566');
    assert.equal(el.getAttribute('style'), null);
  }
  assert.equal(gif.classList.contains('av-ring'), true, 'moving pictures keep their background and get a ring');
  assert.equal(gif.classList.contains('av-cut'), false);
  assert.equal(gif.style.props['--av-ring'], '#0000aa');
  assert.equal(yapin.classList.contains('av-cut') || yapin.classList.contains('av-ring'), false);
  const later = avatar({ name: 'Bea', url: CUT, id: 'x' });
  assert.equal(later.classList.contains('av-cut'), true, 'known pictures paint straight away');
  assert.equal(asked.length, 1);
  const sakura = THEMES.find((t) => t.id === 'sakura');
  bd.primeBackdrop(CUT, { stops: [sakura.base, sakura.alt], ring: sakura.accent });
  assert.equal(big.style.props['--av-bd-1'], sakura.base, 'a theme change repaints the pictures already on the page');
  assert.equal(later.style.props['--av-bd-2'], sakura.alt);
  bd.noteBackdrop(CUT, null);
  assert.equal(big.classList.contains('av-cut'), false);
  assert.equal(big.style.props['--av-bd-1'], undefined);
});

test('colours from the server are checked before they reach the page', async () => {
  lookups({ 'a-abcdefghij': { cut: true, stops: ['#112233', 'red;x:url(a)'], ring: '#778899' } });
  const el = avatar({ name: 'Bea', url: CUT, id: 'x' });
  await bd.flushBackdrops();
  assert.equal(el.classList.contains('av-cut'), false);
  assert.deepEqual(el.style.props, { '--avatar-hue': el.style.props['--avatar-hue'] });
  lookups({ 'a-abcdefghij': { cut: true, stops: ['#112233', '#445566'], ring: '#778899' } });
  bd.setBackdropFetch(async () => {
    throw new Error('offline');
  });
  const quiet = avatar({ name: 'Bea', url: CUT, id: 'x' });
  await bd.flushBackdrops();
  assert.equal(quiet.classList.contains('av-cut'), false, 'a failed look-up just leaves the picture as it is');
});

test('Party avatars get the backdrop and load the small lazy sheet only when needed', async () => {
  lookups({ 'a-abcdefghij': { cut: true, moving: false, clear: true, stops: ['#112233', '#445566'], ring: '#778899' } });
  assert.equal(document.querySelector('link[data-av-backdrop]'), null);
  const wrap = party.avatar({ id: 'u1', name: 'Bea', avatar: CUT, initials: 'B' }, 'md');
  const plain = party.avatar({ id: 'u2', name: 'Al', avatar: YAPIN, initials: 'A' }, 'md');
  await bd.flushBackdrops();
  assert.equal(wrap.classList.contains('av-cut'), true);
  assert.equal(wrap.classList.contains('av-cut-clear'), true);
  assert.equal(plain.classList.contains('av-cut'), false);
  const link = document.querySelector('link[data-av-backdrop]');
  assert.ok(link);
  assert.equal(link.getAttribute('href'), '/activity/css/avatar-backdrop.css');
});

test('the editor removes the background of an upload, saves it as a cut-out, and can put the background back', async () => {
  bd.resetBackdrops();
  const sakura = THEMES.find((t) => t.id === 'sakura');
  const posts = [];
  const patches = [];
  const fetched = [];
  let seen = null;
  const before = { custom: { url: PLAIN, animated: false }, cutout: null, yapin: YAPIN, avatar: PLAIN, canUpload: true };
  const after = { custom: { url: CUT, animated: false }, cutout: { source: 'upload', backdrop: 'theme', canRestore: true }, yapin: YAPIN, avatar: CUT, canUpload: true };
  const api = {
    get: async () => before,
    post: async (p, body) => {
      posts.push([p, body]);
      return after;
    },
    patch: async (p, body) => {
      patches.push([p, body]);
      return body.cutout === false ? before : { ...after, cutout: { ...after.cutout, backdrop: body.backdrop } };
    },
  };
  const canvas = { width: 128, toDataURL: (type) => (type === 'image/png' ? 'data:image/png;base64,iVBORw0KGgo=' : 'data:,') };
  const profile = { name: 'Bea', id: 'x', avatar: PLAIN };
  const ctl = av.avatarControls({
    api,
    profile,
    look: () => ({ theme: 'sakura' }),
    fetchImpl: async (url) => {
      fetched.push(url);
      return { ok: true, blob: async () => ({ kind: 'blob' }) };
    },
    load: async () => ({ width: 128, height: 128 }),
    cutout: async (src, { colours }) => {
      seen = colours;
      return { canvas, strength: 45, removed: 0.5, verdict: 'ok' };
    },
  });
  document.body.appendChild(ctl.el);
  await flush();
  const sw = ctl.el.querySelector('.switch');
  assert.equal(sw.getAttribute('aria-checked'), 'false');
  assert.equal(sw.disabled, false);
  assert.match(ctl.el.querySelector('.av-cut-state').textContent, /profile colors/);
  sw.click();
  await flush();
  assert.deepEqual(fetched, [PLAIN], 'the picture comes from the site so the canvas can read it');
  assert.deepEqual(seen.stops, [sakura.base, sakura.alt]);
  assert.deepEqual(posts, [[rules.AVATAR_API, { image: 'data:image/png;base64,iVBORw0KGgo=', cutout: true, source: 'upload', backdrop: 'theme' }]]);
  assert.equal(profile.avatar, CUT);
  assert.equal(sw.getAttribute('aria-checked'), 'true');
  const face = ctl.el.querySelector('.av-ctl-face .avatar');
  assert.equal(face.classList.contains('av-cut'), true);
  assert.equal(face.style.props['--av-bd-1'], sakura.base);
  assert.equal(ctl.el.querySelector('.av-cut-adjust').hidden, false);
  const bdSwitch = ctl.el.querySelectorAll('.switch')[1];
  bdSwitch.click();
  await flush();
  assert.deepEqual(patches[0], [rules.AVATAR_API, { backdrop: 'clear' }]);
  assert.match(ctl.el.querySelector('.av-cut-state').textContent, /nothing is drawn/);
  sw.click();
  await flush();
  const confirm = document.body.querySelectorAll('button').find((b) => /Put it back/.test(b.textContent));
  assert.ok(confirm, 'putting the background back asks first');
  confirm.click();
  await flush();
  assert.deepEqual(patches[1], [rules.AVATAR_API, { cutout: false }]);
  assert.equal(sw.getAttribute('aria-checked'), 'false');
  assert.equal(profile.avatar, PLAIN);
  ctl.el.remove();
});

test('the editor offers the Yapin picture through the site, and moving pictures get a ring instead', async () => {
  assert.deepEqual(av.cutSourcePlan({ custom: null, yapin: YAPIN }), { url: `${rules.AVATAR_API}/yapin`, source: 'yapin' });
  assert.deepEqual(av.cutSourcePlan({ custom: { url: PLAIN, animated: false } }), { url: PLAIN, source: 'upload' });
  assert.deepEqual(av.cutSourcePlan({ custom: { url: CUT }, cutout: { source: 'upload' } }), { url: `${rules.AVATAR_API}/original`, source: 'upload' });
  assert.deepEqual(av.cutSourcePlan({ custom: { url: CUT }, cutout: { source: 'yapin' } }), { url: `${rules.AVATAR_API}/yapin`, source: 'yapin' });
  assert.equal(av.cutSourcePlan({ custom: { url: GIF, animated: true } }), null);
  assert.equal(av.cutSourcePlan({ custom: null, yapin: null }), null);
  assert.match(av.cutBlocked({ canUpload: true, custom: { url: GIF, animated: true } }), /ring/);
  assert.match(av.cutBlocked({ canUpload: false }), /not set up/);
  assert.equal(av.cutBlocked({ canUpload: true, custom: null, yapin: YAPIN }), '');
  const state = av.readAvatarState({ custom: { url: GIF, animated: true }, cutout: { source: 'upload', backdrop: 'theme' } });
  assert.equal(state.cutout, null, 'a moving picture is never treated as a cut-out');
  assert.deepEqual(av.readAvatarState({ custom: { url: CUT }, cutout: { source: 'yapin', backdrop: 'weird' } }).cutout, { source: 'yapin', backdrop: 'theme', canRestore: true });
  const api = { get: async () => ({ custom: { url: GIF, still: GIF_STILL, animated: true }, avatar: GIF, avatarStill: GIF_STILL, canUpload: true }), post: async () => ({}), patch: async () => ({}) };
  const ctl = av.avatarControls({ api, profile: { name: 'Gus', id: 'y' } });
  await flush();
  const sw = ctl.el.querySelector('.switch');
  assert.equal(sw.disabled, true);
  assert.match(ctl.el.querySelector('.av-cut-state').textContent, /ring/);
  assert.match(av.removedText(0.42), /42%/);
});
