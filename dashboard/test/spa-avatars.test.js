import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, flush, FakeEvent } from './dom-shim.js';
import { makeGif } from './motion-fixtures.js';

const { document } = installDom({ url: 'https://dash.example.test/u/bea' });
document.documentElement = document.createElement('html');
if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const { avatar } = await import('../web/js/ui.js');
const { safeImageUrl } = await import('../web/js/format.js');
const heal = await import('../web/js/avatar-heal.js');
const av = await import('../web/js/pages/avatar-editor.js');
const rules = await import('../web/js/avatar-rules.js');
const { RESET_PARTS, canReset, lookRows, readStaffProfile, readPerson } = await import('../web/js/pages/party-person.js');
const { modLogSentence, actionLabel } = await import('../web/js/pages/party-modlog.js');
const { resetText } = await import('../web/js/pages/profile.js');
const { readInbox } = await import('../web/js/pages/inbox.js');
const { normalizeBoard, boardPeople } = await import('../web/js/public-data.js');
const { normalizeLeaderboard, boardRows } = await import('../web/js/pages/party-leaderboard.js');
const { normalizeProfile } = await import('../web/js/community-data.js');

const OWN = '/avatar-img/a-abcdefghij-0123456789abcdef.gif';
const OWN_STILL = '/avatar-img/a-abcdefghij-fedcba9876543210-still.webp';
const YAPIN = 'https://files.yapper.website/avatars/u1/r2-1-a.png';
const ID = '11111111-1111-4111-8111-111111111111';

function timers() {
  const queue = [];
  return { queue, setTimeout: (fn) => queue.push(fn), run: async () => { while (queue.length) await queue.shift()(); } };
}

test('only exact uploaded picture paths and Yapin hosts pass the image allow-list', () => {
  assert.equal(safeImageUrl(OWN), OWN);
  assert.equal(safeImageUrl(OWN_STILL), OWN_STILL);
  for (const bad of ['/avatar-img/../x.png', '/avatar-img/a-abcdefghij-0123456789abcdef.svg', '/avatar-img/a-ABCDEFGHIJ-0123456789abcdef.png', '//evil.example/avatar-img/a-abcdefghij-0123456789abcdef.png', '/avatar-img/a-abcdefghij-0123456789abcdef.png?x=1', '/banner-img/b-abcdefghij-0123456789abcdef.png']) {
    assert.equal(safeImageUrl(bad), '', bad);
  }
  assert.equal(safeImageUrl(YAPIN), YAPIN);
  assert.equal(rules.isAvatarImagePath(OWN), true);
  assert.equal(rules.isYapinAvatar(YAPIN), true);
  assert.equal(rules.isYapinAvatar(OWN), false, 'uploaded pictures are never reported as broken Yapin pictures');
});

test('avatars show the still in lists, keep moving elsewhere with a reduced motion source, and fall back to initials', () => {
  const list = avatar({ name: 'Bea Bee', url: OWN, still: OWN_STILL, animate: false, id: ID, size: 'sm' });
  assert.equal(list.querySelector('img').src, OWN_STILL);
  assert.equal(list.querySelector('picture'), null);
  const big = avatar({ name: 'Bea Bee', url: OWN, still: OWN_STILL, id: ID, size: 'xl' });
  assert.equal(big.querySelector('img').src, OWN);
  const source = big.querySelector('source');
  assert.equal(source.getAttribute('media'), '(prefers-reduced-motion: reduce)');
  assert.equal(source.getAttribute('srcset'), OWN_STILL);
  assert.equal(big.querySelector('.avatar-initials').textContent, 'BB', 'initials sit underneath until the picture loads');
  const none = avatar({ name: 'Bea', url: 'https://evil.example/x.png', id: ID });
  assert.equal(none.querySelector('img'), null);
});

test('a broken Yapin picture switches to initials straight away and is reported once, in small batches', async () => {
  heal.resetHeal();
  const posts = [];
  const t = timers();
  heal.configureHeal({ fetch: async (url, init) => posts.push({ url, body: JSON.parse(init.body), headers: init.headers }), setTimeout: t.setTimeout });
  const el = avatar({ name: 'Bea', url: YAPIN, id: ID });
  el.classList.add('has-image');
  el.querySelector('img').dispatchEvent(new FakeEvent('error'));
  assert.equal(el.querySelector('img'), null);
  assert.equal(el.classList.contains('has-image'), false);
  const again = avatar({ name: 'Bea', url: YAPIN, id: ID });
  again.querySelector('img').dispatchEvent(new FakeEvent('error'));
  const own = avatar({ name: 'Bea', url: OWN, id: ID });
  own.querySelector('img').dispatchEvent(new FakeEvent('error'));
  const page = avatar({ name: 'Bea', url: YAPIN, id: 'bea', healName: 'bea' });
  page.querySelector('img').dispatchEvent(new FakeEvent('error'));
  for (let i = 0; i < 12; i++) heal.reportBrokenAvatar(`id${i}`, YAPIN);
  await t.run();
  assert.equal(posts[0].url, rules.AVATAR_REFRESH_API);
  assert.deepEqual(posts[0].body, { ids: [ID.toLowerCase(), 'id0', 'id1', 'id2', 'id3', 'id4', 'id5', 'id6', 'id7'], names: ['bea'] });
  assert.equal(posts[0].body.ids.length + posts[0].body.names.length, rules.AVATAR_REFRESH_MAX);
  assert.deepEqual(posts[1].body, { ids: ['id8', 'id9', 'id10', 'id11'] });
  assert.equal(posts.length, 2);
  for (let i = 0; i < heal.HEAL_PAGE_MAX; i++) heal.reportBrokenAvatar(`more${i}`, YAPIN);
  assert.equal(heal.healState().sent.length, heal.HEAL_PAGE_MAX, 'a page never reports more than its limit');
  assert.equal(heal.reportBrokenAvatar('bad id!', YAPIN), false);
  heal.resetHeal();
});

test('square crop maths keep the circle inside the picture and zoom within limits', () => {
  const v = av.avatarStartView(1000, 500);
  assert.deepEqual(av.avatarRect(1000, 500, v), { sx: 250, sy: 0, sw: 500, sh: 500 });
  const z = av.avatarZoom(1000, 500, v, 100);
  assert.equal(z.zoom, av.avatarMaxZoom(1000, 500));
  assert.ok(av.avatarMaxZoom(1000, 500) <= av.AV_MAX_ZOOM);
  const far = av.avatarPan(1000, 500, z, 99999, 99999, 100);
  const r = av.avatarRect(1000, 500, far);
  assert.ok(r.sx >= 0 && r.sy >= 0 && r.sx + r.sw <= 1000.0001 && r.sy + r.sh <= 500.0001);
  assert.equal(av.avatarOutSide({ sw: 4000 }), rules.AVATAR_SIDE, 'big pictures are stored at most 512 wide');
  assert.equal(av.avatarOutSide({ sw: 20 }), rules.AVATAR_MIN_SIDE, 'tiny crops are grown to the smallest size the server takes');
  assert.equal(av.avatarOutSide({ sw: 300 }), 300);
});

function fakeDoc(log, { webp = true, bytes = () => 1000 } = {}) {
  return {
    createElement() {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: (...args) => log.push(['draw', canvas.width, ...args.slice(1)]) }),
        toDataURL(type, q) {
          log.push(['encode', canvas.width, type, q]);
          if (type === 'image/webp' && !webp) return 'data:image/png;base64,AAAA';
          return `data:${type};base64,${'A'.repeat(Math.ceil((bytes(canvas.width, type, q) * 4) / 3))}`;
        },
      };
      return canvas;
    },
  };
}

test('the picture is encoded square, WebP first, and stays under the server cap', () => {
  const log = [];
  const url = av.encodeAvatar({}, { sx: 10, sy: 20, sw: 800, sh: 800 }, { doc: fakeDoc(log) });
  assert.match(url, /^data:image\/webp;base64,/);
  assert.deepEqual(log[0], ['draw', 512, 10, 20, 800, 800, 0, 0, 512, 512]);
  const heavy = [];
  const out = av.encodeAvatar({}, { sx: 0, sy: 0, sw: 512, sh: 512 }, { doc: fakeDoc(heavy, { webp: false, bytes: (w, type) => (type === 'image/png' && w > 256 ? 400 * 1024 : 50 * 1024) }) });
  assert.match(out, /^data:image\/jpeg;base64,/, 'without WebP, a PNG that is too big falls back to JPEG at the same size');
  assert.ok(heavy.filter((x) => x[0] === 'encode').every((x) => x[1] === 512), 'it tries every format before shrinking');
  const alpha = av.encodeAvatar({}, { sx: 0, sy: 0, sw: 300, sh: 300 }, { doc: fakeDoc([], { webp: false }) });
  assert.match(alpha, /^data:image\/png;base64,/, 'PNG keeps transparency when WebP is missing');
  assert.throws(() => av.encodeAvatar({}, { sx: 0, sy: 0, sw: 512, sh: 512 }, { doc: fakeDoc([], { bytes: () => rules.AVATAR_STILL_MAX + 1 }) }), /too detailed/);
});

function fakeFile(bytes, { type = 'image/png', name = 'a.png', size = bytes.length } = {}) {
  return { size, type, name, slice: (a, b) => ({ arrayBuffer: async () => bytes.slice(a, b).buffer }), arrayBuffer: async () => bytes.buffer };
}

test('picking a file checks size and kind, opens the cropper, and a moving GIF gets a centred still first frame', async () => {
  const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  await assert.rejects(av.processAvatar(fakeFile(PNG, { size: rules.AVATAR_FILE_MAX + 1 })), /bigger than 2 MB/);
  await assert.rejects(av.processAvatar(fakeFile(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), { type: 'image/svg+xml', name: 'a.svg' })), /SVG/);
  await assert.rejects(av.processAvatar(fakeFile(new TextEncoder().encode('hello there friend'), { type: 'text/plain', name: 'a.txt' })), /isn't a picture/);
  globalThis.createImageBitmap = async () => ({ width: 800, height: 600, close() {} });
  try {
    const seen = [];
    assert.equal(await av.processAvatar(fakeFile(PNG), { choose: async (src) => { seen.push(src.width); return null; } }), null, 'cancelling the cropper uploads nothing');
    assert.deepEqual(seen, [800]);
    const log = [];
    const pic = await av.processAvatar(fakeFile(PNG), { choose: async () => ({ sx: 100, sy: 0, sw: 600, sh: 600 }), doc: fakeDoc(log) });
    assert.match(pic.image, /^data:image\/webp/);
    assert.equal(pic.still, undefined);
    const gif = makeGif({ width: 300, height: 200, frames: 3 });
    const glog = [];
    const asked = [];
    const moving = await av.processAvatar(fakeFile(gif, { type: 'image/gif', name: 'a.gif' }), { choose: async (src, opts) => { asked.push(opts.moving); return true; }, readUrl: async () => 'data:image/gif;base64,R0lG', doc: fakeDoc(glog) });
    assert.deepEqual(asked, ['data:image/gif;base64,R0lG'], 'the moving preview is shown before upload');
    assert.equal(moving.image, 'data:image/gif;base64,R0lG');
    assert.match(moving.still, /^data:image\/webp/);
    assert.equal(moving.frames, 3);
    assert.deepEqual(glog[0].slice(0, 6), ['draw', 200, 50, 0, 200, 200], 'the still is the centred square of the first frame');
    const tooBig = makeGif({ width: 200, height: 200, frames: 3, comment: 'x'.repeat(rules.AVATAR_ANIM_MAX) });
    await assert.rejects(av.processAvatar(fakeFile(tooBig, { type: 'image/gif', name: 'a.gif' }), { choose: async () => true, readUrl: async () => '' }), /KB/);
    await assert.rejects(av.processAvatar(fakeFile(makeGif({ width: 900, height: 200, frames: 3 }), { type: 'image/gif', name: 'a.gif' }), { choose: async () => true, readUrl: async () => '' }), /close to square/);
  } finally {
    delete globalThis.createImageBitmap;
  }
});

test('the cropper dialog has a circle frame, previews, zoom controls and returns the crop', async () => {
  const canvasStub = { width: 900, height: 600 };
  const done = av.chooseAvatarCrop(canvasStub);
  await flush();
  const root = document.querySelector('.av-crop');
  assert.ok(root);
  assert.ok(root.querySelector('.av-crop-ring'));
  assert.equal(root.querySelectorAll('.av-crop-prev').length, 2);
  assert.ok(root.querySelector('.av-crop-range'));
  assert.equal(root.querySelector('[role="dialog"]').getAttribute('aria-modal'), 'true');
  root.querySelector('.av-crop-in').click();
  root.querySelector('.av-crop-ok').click();
  const rect = await done;
  assert.ok(rect.sw < 600 && Math.abs(rect.sw - rect.sh) < 1e-9, 'zooming in crops a smaller square');
  const moving = av.chooseAvatarCrop(canvasStub, { moving: 'data:image/gif;base64,R0lG' });
  await flush();
  const m = document.querySelector('.av-crop');
  assert.equal(m.querySelector('.av-crop-range'), null, 'moving pictures are centred without zoom');
  assert.equal(m.querySelector('.av-crop-moving').src, 'data:image/gif;base64,R0lG');
  document.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
  assert.equal(await moving, null);
});

test('the editor control uploads a picture, updates the profile, and offers going back to the Yapin picture', async () => {
  const profile = normalizeProfile({ profile: { username: 'bea', name: 'Bea', level: 1, xp: 0 } });
  const posts = [];
  const changes = [];
  const api = {
    get: async () => ({ custom: null, yapin: YAPIN, avatar: YAPIN, avatarStill: null, canUpload: true }),
    post: async (path, body) => {
      posts.push([path, body]);
      return { custom: { url: OWN, still: OWN_STILL, animated: true }, yapin: YAPIN, avatar: OWN, avatarStill: OWN_STILL, canUpload: true };
    },
    request: async () => ({ custom: null, yapin: YAPIN, avatar: YAPIN, avatarStill: null, canUpload: true }),
  };
  const ctl = av.avatarControls({ api, profile, onChange: (s) => changes.push(s), process: async () => ({ image: 'data:image/gif;base64,R0lG', still: 'data:image/webp;base64,UklG' }) });
  document.body.appendChild(ctl.el);
  await flush();
  assert.equal(ctl.el.querySelector('.av-use-yapin').hidden, true, 'nothing to go back to yet');
  assert.match(ctl.el.querySelector('.av-ctl-note').textContent, /Yapin picture/);
  const input = ctl.el.querySelectorAll('input').find((i) => (i.type || i.getAttribute('type')) === 'file');
  Object.defineProperty(input, 'files', { value: [{}], configurable: true });
  input.dispatchEvent(new FakeEvent('change'));
  await flush();
  assert.deepEqual(posts, [[rules.AVATAR_API, { image: 'data:image/gif;base64,R0lG', still: 'data:image/webp;base64,UklG' }]]);
  assert.equal(profile.avatar, OWN);
  assert.equal(profile.avatarStill, OWN_STILL);
  assert.equal(changes.length, 1);
  assert.equal(ctl.el.querySelector('.av-use-yapin').hidden, false);
  assert.match(ctl.el.querySelector('.av-ctl-note').textContent, /moving picture/);
  ctl.el.remove();
  const noProfile = av.avatarControls({ api: { ...api, get: async () => ({ canUpload: false }) }, profile });
  await flush();
  assert.equal(noProfile.el.querySelector('.av-upload').disabled, true);
  assert.match(noProfile.el.querySelector('.av-ctl-note').textContent, /not set up yet/);
});

test('staff see the uploaded picture, can remove it, and the mod log and the person read it plainly', () => {
  assert.ok(RESET_PARTS.some((r) => r.part === 'avatar'));
  const staff = readStaffProfile({ look: { avatar: '/avatar-img/a-abcdefghij-0123456789abcdef.png', avatarAnimated: false }, canAct: true });
  assert.equal(staff.look.avatar, '/avatar-img/a-abcdefghij-0123456789abcdef.png');
  assert.equal(canReset(staff.look, 'avatar'), true);
  assert.equal(canReset(staff.look, 'all'), true);
  assert.equal(canReset(readStaffProfile({ look: { avatar: 'https://evil.example/a.png' } }).look, 'avatar'), false);
  assert.equal(Object.fromEntries(lookRows(staff.look))['Profile picture'], 'Uploaded picture');
  assert.equal(Object.fromEntries(lookRows(readStaffProfile({ look: {} }).look))['Profile picture'], 'Their Yapin picture');
  assert.equal(modLogSentence({ action: 'profile_avatar_remove', actor: { name: 'Jolli' }, target: { name: 'Rex' }, detail: {} }), "Jolli removed Rex's uploaded profile picture");
  assert.equal(actionLabel('profile_avatar_remove'), 'Uploaded profile pictures removed');
  assert.equal(resetText({ action: 'profile_avatar_remove' }), 'your uploaded profile picture was removed');
  const person = readPerson({ person: { id: 'x', name: 'Rex', avatar: OWN, avatarStill: OWN_STILL } });
  assert.equal(person.person.avatarStill, OWN_STILL);
});

test('leaderboards, the global board, clan lists and inbox items pass pictures and stills through', () => {
  const lb = normalizeLeaderboard({ rows: [{ id: 'a', name: 'A', avatar: OWN, avatarStill: OWN_STILL, value: 3 }] });
  assert.equal(lb.rows[0].avatarStill, OWN_STILL);
  const list = boardRows('points', lb.rows);
  assert.equal(list.querySelector('img').src, OWN_STILL, 'lists show the still frame');
  const board = normalizeBoard([{ id: 'a', name: 'A', level: 2, avatar_url: OWN, avatar_still: OWN_STILL }], 'levels');
  assert.equal(board[0].avatarStill, OWN_STILL);
  assert.equal(boardPeople(board, []).get('a').avatarStill, OWN_STILL);
  assert.equal('avatarStill' in normalizeBoard([{ id: 'b', name: 'B', level: 2 }], 'levels')[0], false);
  const inbox = readInbox({ items: [{ id: 'n1', kind: 'clan_invite', title: 'Invite', created: 1, person: { id: 'p1', avatar: OWN, avatarStill: OWN_STILL } }, { id: 'n2', kind: 'badge', title: 'Badge', created: 1 }] });
  assert.deepEqual(inbox.items[0].person, { id: 'p1', avatar: OWN, still: OWN_STILL });
  assert.equal('person' in inbox.items[1], false);
});

test('the new avatar files have no comments, inline styles or unsafe DOM, and the CSS is plain ASCII', () => {
  for (const f of ['../web/js/avatar-rules.js', '../web/js/avatar-heal.js', '../web/js/pages/avatar-editor.js', '../worker/avatars.js', '../worker/avatar-store.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.equal(/(^|[^:'"`\\])\/\/\s/m.test(src.replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, '')), false, `${f} has a line comment`);
    assert.equal(/\/\*/.test(src.replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, '')), false, `${f} has a block comment`);
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|\.style\s*=|setAttribute\(\s*'style'/.test(src), false, `${f} touches unsafe DOM`);
  }
  const css = readFileSync(new URL('../web/css/profile.css', import.meta.url), 'utf8');
  assert.equal(/[^\x00-\x7f]/.test(css), false);
  assert.match(css, /\.av-crop-ring \{[^}]*border-radius: 50%/);
});
