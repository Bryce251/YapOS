import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, flush, type, fire, FakeEvent } from './dom-shim.js';

const { document } = installDom({ url: 'https://dash.example.test/u/bea' });
document.documentElement = document.createElement('html');
if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const { renderProfile, profileCard, allBadges, groupBadges, badgeKind } = await import('../web/js/pages/profile.js');
const { LOOK_API, BANNER_API, cropRect, startView } = await import('../web/js/pages/profile-editor.js');
const { normalizeProfile } = await import('../web/js/community-data.js');
const { readLook, SECTION_IDS } = await import('../web/js/profile-look.js');

const EVIL = '<img src=x onerror=alert(1)>';

function walk(node, out = []) {
  for (const c of node.childNodes || []) {
    out.push(c);
    walk(c, out);
  }
  return out;
}

const tags = (root) => walk(root).map((n) => n.localName).filter(Boolean);
const buttons = (root, re) => walk(root).filter((n) => n.localName === 'button' && re.test(n.textContent || n.getAttribute('aria-label') || ''));
const byLabel = (root, label) => walk(root).find((n) => n.localName === 'button' && n.getAttribute('aria-label') === label);
const choice = (root, id) => walk(root).find((n) => n.getAttribute?.('data-choice') === id);
const click = (el) => el.dispatchEvent(new FakeEvent('click', { bubbles: true }));
const sectionsOf = (root) => walk(root.querySelector('.profile-sections')).filter((n) => n.parentNode?.classList?.contains('profile-sections')).map((n) => n.dataset.section);

const CUSTOM = {
  v: 1,
  pins: ['ach:messages-10k', 'wins-10', 'not-mine'],
  order: ['badges', 'about', 'stats', 'favourites', 'achievements', 'placings'],
  hidden: ['placings'],
  nameColour: '#e0a100',
  nameGradient: null,
  nameFont: 'serif',
  accent: '#7c5cff',
  banner: 'aurora',
  bannerImage: null,
  bio: `Hi ${EVIL}`,
  pronouns: 'they/them',
  status: 'Playing trivia',
  statusEmoji: '\u{1F3AE}',
  ring: 'rainbow',
  density: 'compact',
  featured: 'wins',
};

function data(custom = CUSTOM) {
  return {
    profile: {
      username: 'bea',
      name: 'Bea',
      level: 3,
      xp: 400,
      shards: null,
      badges: ['first-game', 'wins-10', 'vip', 'c-abcdefgh', 'season-party-1-2026-09'],
      achievements: ['messages-10k'],
      season: [{ month: '2026-09', rank: 4, kind: 'xp' }],
      party: { games: 40, wins: 10, favourites: [{ game: 'draw', played: 20, won: 6 }] },
      custom,
    },
    partyBadges: [{ id: 'first-game', label: 'First game', emoji: '🎈', hint: 'Finish your first YapOS Party game.' }, { id: 'wins-10', label: 'Winner', emoji: '🥇', hint: 'Win 10 YapOS Party games.' }],
    catalog: { badges: [{ id: 'c-abcdefgh', label: 'Galaxy brain', emoji: '🌌', note: 'Made by Jolli' }], achievements: [] },
  };
}

function mount({ get, post, request, user = null, custom } = {}) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const ctrl = new AbortController();
  const calls = [];
  let guard = null;
  const ctx = {
    params: { name: 'bea' },
    signal: ctrl.signal,
    api: {
      get: get || (async () => data(custom)),
      post: post || (async (path, body) => { calls.push({ path, body }); return { ok: true, look: { ...body, bannerImage: null } }; }),
      request: request || (async (method, path) => { calls.push({ method, path }); return { ok: true }; }),
    },
    title: '',
    setTitle(t) { ctx.title = t; },
    getUser: async () => user,
    setLeaveGuard(g) { guard = g; },
    abort: () => ctrl.abort(),
  };
  renderProfile(root, ctx);
  return { root, ctx, calls, guard: () => guard };
}

test('a customised profile shows its colours, banner, pins, status and section order, all as text', async () => {
  const { root, ctx } = mount();
  await flush();
  const card = root.querySelector('.profile-card');
  assert.ok(card.classList.contains('look-compact'));
  assert.ok(card.classList.contains('has-banner'));
  assert.ok(card.classList.contains('has-accent'));
  assert.equal(card.style.props['--ac-base'], '#7c5cff');
  assert.ok(root.querySelector('.profile-banner').classList.contains('banner-aurora'));
  const name = root.querySelector('.profile-name');
  assert.ok(name.classList.contains('has-name-colour'));
  assert.ok(name.classList.contains('name-font-serif'));
  assert.equal(name.style.props['--nc-light'], '#976d00', 'the light mode colour is darkened to stay readable');
  assert.equal(name.style.props['--nc-dark'], '#e0a100');
  assert.ok(root.querySelector('.profile-avatar-wrap').classList.contains('ring-rainbow'));
  const pins = root.querySelectorAll('.profile-pin');
  assert.deepEqual(pins.map((p) => p.textContent), ['📣Town crier', '🥇Winner'], 'pins keep their order and a badge they lost is dropped');
  assert.match(root.querySelector('.profile-status').textContent, /Playing trivia/);
  assert.equal(root.querySelector('.profile-pronouns').textContent, 'they/them');
  assert.deepEqual(sectionsOf(root), ['badges', 'about', 'stats', 'favourites', 'achievements']);
  assert.equal(root.querySelector('.profile-bio').textContent, `Hi ${EVIL}`);
  assert.equal(tags(card).includes('img'), false, 'the bio is never turned into markup');
  assert.equal(root.querySelector('.profile-feature').dataset.featured, 'wins');
  assert.equal(root.querySelector('.profile-feature-num').textContent, '10');
  assert.equal(root.querySelectorAll('.badge-tile.is-pinned').length, 2);
  assert.equal(root.querySelector('.profile-customize'), null, "visitors don't get the customize button");
  ctx.abort();
});

test('a gradient name and an uploaded banner picture render without inline markup', () => {
  const p = normalizeProfile(data().profile);
  const { look, bannerImage } = readLook({ ...CUSTOM, nameGradient: 'ocean', banner: 'image', bannerImage: '/banner-img/b-abcdefghij-0123456789abcdef.webp' });
  const card = profileCard(p, { look, bannerImage });
  assert.ok(card.querySelector('.profile-name').classList.contains('name-grad-ocean'));
  assert.equal(card.querySelector('.profile-name').classList.contains('has-name-colour'), false);
  assert.equal(card.querySelector('.profile-banner-img').src, '/banner-img/b-abcdefghij-0123456789abcdef.webp');
  const bad = readLook({ banner: 'image', bannerImage: 'https://evil.example/x.png' });
  assert.equal(bad.look.banner, 'none');
  assert.equal(bad.bannerImage, null);
  const plain = profileCard(p);
  assert.equal(plain.querySelector('.profile-banner'), null);
  assert.deepEqual(sectionsOf({ querySelector: (s) => plain.querySelector(s) }), ['stats', 'badges', 'achievements', 'favourites', 'placings']);
});

test('View all badges lists every badge grouped by type with a description', async () => {
  const { root, ctx } = mount();
  await flush();
  click(buttons(root, /View all badges \(6\)/)[0]);
  await flush();
  const sheet = document.querySelector('.allbadges');
  assert.ok(sheet);
  const groups = sheet.querySelectorAll('.allbadges-group').map((g) => g.dataset.group);
  assert.deepEqual(groups, ['custom', 'special', 'party', 'season', 'achievement']);
  assert.match(sheet.textContent, /Win 10 YapOS Party games\./);
  assert.match(sheet.textContent, /Made by Jolli/);
  assert.equal(sheet.querySelectorAll('.allbadges-row.is-pinned').length, 2);
  assert.equal(badgeKind('c-abcdefgh'), 'custom');
  assert.equal(badgeKind('season-xp-1-2026-01'), 'season');
  assert.equal(groupBadges(allBadges(normalizeProfile(data().profile), { 'first-game': 'x' })).length, 5);
  sheet.remove();
  ctx.abort();
});

async function openEditor(opts = {}) {
  const m = mount({ user: { id: 'u1', username: 'bea' }, ...opts });
  await flush();
  const btn = m.root.querySelector('.profile-customize');
  assert.ok(btn, 'your own profile has a Customize profile button');
  click(btn);
  await flush();
  return m;
}

test('the editor pins badges, reorders them with buttons or drag and drop, and saves', async () => {
  const { root, ctx, calls, guard } = await openEditor();
  assert.ok(root.querySelector('.pe-layout'));
  assert.ok(root.querySelector('.pe-preview .profile-card.is-preview'));
  assert.equal(guard().isDirty(), false);
  const save = root.querySelector('.pe-save');
  assert.equal(save.disabled, true);
  const pinRows = () => root.querySelectorAll('.pe-pins .pe-sort-row').map((r) => r.getAttribute('data-key'));
  assert.deepEqual(pinRows(), ['ach:messages-10k', 'wins-10']);
  const picks = root.querySelectorAll('.pe-pick-btn');
  assert.deepEqual(picks.map((b) => b.getAttribute('data-key')), ['c-abcdefgh', 'vip', 'first-game', 'wins-10', 'season-party-1-2026-09', 'ach:messages-10k'], 'one-of-a-kind and special badges lead the pin picker');
  assert.deepEqual(picks.map((b) => b.classList.contains('is-special')), [true, true, false, false, false, false]);
  click(root.querySelector('.pe-pick-btn[data-key="first-game"]'));
  click(root.querySelector('.pe-pick-btn[data-key="vip"]'));
  click(root.querySelector('.pe-pick-btn[data-key="c-abcdefgh"]'));
  assert.equal(pinRows().length, 5);
  click(root.querySelector('.pe-pick-btn[data-key="season-party-1-2026-09"]'));
  assert.equal(pinRows().length, 5, 'a sixth pin is refused');
  assert.match(root.querySelector('.pe-status').textContent, /up to 5/);
  click(byLabel(root, 'Move Winner up'));
  assert.deepEqual(pinRows().slice(0, 2), ['wins-10', 'ach:messages-10k']);
  click(byLabel(root, 'Unpin Galaxy brain'));
  const rows = root.querySelectorAll('.pe-pins .pe-sort-row');
  fire(rows[0], 'dragstart');
  fire(rows[3], 'dragover');
  fire(rows[3], 'drop');
  assert.deepEqual(pinRows(), ['ach:messages-10k', 'first-game', 'vip', 'wins-10']);
  assert.equal(guard().isDirty(), true);
  assert.deepEqual(root.querySelectorAll('.pe-preview .profile-pin-label').map((p) => p.textContent), ['Town crier', 'First game', 'VIP', 'Winner']);
  click(root.querySelector('.pe-save'));
  await flush();
  assert.equal(calls[0].path, LOOK_API);
  assert.deepEqual(calls[0].body.pins, ['ach:messages-10k', 'first-game', 'vip', 'wins-10']);
  assert.equal(root.querySelector('.pe-layout'), null, 'saving goes back to the profile');
  assert.equal(root.querySelectorAll('.profile-pin').length, 4);
  ctx.abort();
});

test('opening the editor keeps an uploaded banner picture in the preview and in what is saved', async () => {
  const pic = '/banner-img/b-abcdefghij-0123456789abcdef.webp';
  const { root, ctx, calls, guard } = await openEditor({ custom: { ...CUSTOM, banner: 'image', bannerImage: pic } });
  assert.equal(guard().isDirty(), false);
  assert.equal(root.querySelector('.pe-preview .profile-banner-img')?.src, pic);
  click(root.querySelector('#pe-tab-card'));
  assert.equal(root.querySelector('.pe-banners .pe-choice[data-choice="image"]')?.getAttribute('aria-checked'), 'true');
  click(root.querySelector('#pe-tab-about'));
  const bio = root.querySelector('.pe-bio');
  type(bio, 'New bio');
  click(root.querySelector('.pe-save'));
  await flush();
  assert.equal(calls[0].body.banner, 'image');
  ctx.abort();
});

test('sections can be reordered and hidden from the Layout tab and the order is saved', async () => {
  const { root, ctx, calls } = await openEditor();
  click(root.querySelector('#pe-tab-layout'));
  const order = () => root.querySelectorAll('.pe-sections .pe-sort-row').map((r) => r.getAttribute('data-key'));
  assert.deepEqual(order(), CUSTOM.order);
  click(byLabel(root, 'Move About me up'));
  assert.deepEqual(order().slice(0, 2), ['about', 'badges']);
  click(byLabel(root, 'Move Level and stats down'));
  assert.deepEqual(order(), ['about', 'badges', 'favourites', 'stats', 'achievements', 'placings']);
  const show = walk(root).find((n) => n.getAttribute?.('aria-label') === 'Show Favorite games');
  click(show);
  assert.deepEqual(sectionsOf(root.querySelector('.pe-preview')), ['about', 'badges', 'stats', 'achievements']);
  click(root.querySelector('.pe-save'));
  await flush();
  assert.deepEqual(calls[0].body.order, ['about', 'badges', 'favourites', 'stats', 'achievements', 'placings']);
  assert.deepEqual(calls[0].body.hidden, ['favourites', 'placings']);
  ctx.abort();
});

test('name colours, custom hex, gradients and fonts update the live preview', async () => {
  const { root, ctx, calls } = await openEditor();
  click(root.querySelector('#pe-tab-name'));
  const preview = () => root.querySelector('.pe-preview .profile-name');
  click(choice(root, 'g:candy'));
  assert.ok(preview().classList.contains('name-grad-candy'));
  const hex = root.querySelector('.pe-hex');
  hex.value = 'nope';
  fire(hex, 'change');
  assert.match(root.textContent, /Use a color like/);
  hex.value = 'FFF';
  fire(hex, 'change');
  assert.equal(preview().style.props['--nc-dark'], '#ffffff');
  assert.notEqual(preview().style.props['--nc-light'], '#ffffff');
  assert.match(root.querySelector('.pe-contrast-note').textContent, /tweaked/);
  click(choice(root, 'mono'));
  assert.ok(preview().classList.contains('name-font-mono'));
  click(root.querySelector('.pe-save'));
  await flush();
  assert.equal(calls[0].body.nameColour, '#ffffff');
  assert.equal(calls[0].body.nameGradient, null);
  assert.equal(calls[0].body.nameFont, 'mono');
  ctx.abort();
});

test('about me, pronouns and status have counters and server errors are shown kindly', async () => {
  const post = async () => {
    const { ApiError } = await import('../web/js/api.js');
    throw new ApiError("Some words in your about me aren't allowed on YapOS.", { status: 400, code: 'http_400', data: { error: 'blocked_words', fields: ['bio'] } });
  };
  const { root, ctx } = await openEditor({ post });
  click(root.querySelector('#pe-tab-about'));
  const bio = root.querySelector('.pe-bio');
  type(bio, 'Something rude');
  assert.equal(root.querySelector('.pe-preview .profile-bio').textContent, 'Something rude');
  assert.match(root.textContent, /14\/190/);
  click(root.querySelector('.pe-idea'));
  assert.equal(root.querySelector('.pe-preview .profile-pronouns').textContent, 'she/her');
  click(root.querySelector('.pe-save'));
  await flush();
  const err = root.querySelector('.pe-error');
  assert.equal(err.hidden, false);
  assert.match(err.textContent, /aren't allowed/);
  assert.ok(root.querySelector('.pe-layout'), 'the editor stays open so you can fix it');
  assert.equal(document.activeElement, bio);
  for (const r of document.querySelectorAll('.toast')) r.remove();
  ctx.abort();
});

test('cancel asks before throwing changes away, and reset goes back to the default look', async () => {
  const { root, ctx, calls } = await openEditor();
  click(root.querySelector('#pe-tab-card'));
  click(choice(root, 'stripes'));
  assert.ok(root.querySelector('.pe-preview .profile-banner').classList.contains('banner-stripes'));
  click(root.querySelector('.pe-cancel'));
  await flush();
  const dlg = document.querySelector('.dialog-root');
  assert.ok(dlg, 'unsaved changes are guarded');
  click(buttons(dlg, /^Cancel$/)[0]);
  await flush();
  assert.ok(root.querySelector('.pe-layout'));
  click(root.querySelector('.pe-reset'));
  const card = root.querySelector('.pe-preview .profile-card');
  assert.equal(card.classList.contains('has-banner'), false);
  assert.equal(card.classList.contains('look-cozy'), true);
  click(root.querySelector('.pe-save'));
  await flush();
  assert.deepEqual(calls[0].body.order, SECTION_IDS);
  assert.deepEqual(calls[0].body.pins, []);
  assert.equal(calls[0].body.banner, 'none');
  for (const r of document.querySelectorAll('.toast')) r.remove();
  ctx.abort();
});

test('the Shards big number is only offered when Shards are shown, and banner crops stay centred', async () => {
  const { root, ctx } = await openEditor();
  click(root.querySelector('#pe-tab-card'));
  assert.equal(choice(root, 'shards').disabled, true);
  assert.deepEqual(cropRect(2000, 300, startView(2000, 300)), { sx: 550, sy: 0, sw: 900, sh: 300 });
  assert.deepEqual(cropRect(1200, 1200, startView(1200, 1200)), { sx: 0, sy: 400, sw: 1200, sh: 400 });
  assert.deepEqual(cropRect(1500, 500, startView(1500, 500)), { sx: 0, sy: 0, sw: 1500, sh: 500 });
  assert.equal(BANNER_API, '/api/me/profile-banner');
  ctx.abort();
});

test('the new profile files have no comments, inline styles or non-ASCII CSS', () => {
  for (const f of ['../web/js/pages/profile-editor.js', '../web/js/profile-look.js', '../web/css/profile.css', '../worker/profile-custom.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.equal(/style\s*=\s*["']/.test(src), false, f);
    assert.equal(/setAttribute\(['"]style/.test(src), false, f);
    if (f.endsWith('.css')) assert.equal(/[^\x00-\x7f]/.test(src), false, f);
  }
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /\/css\/profile\.css/);
});

test('owner removals read as plain sentences in the Party mod log', async () => {
  const { modLogSentence, actionLabel } = await import('../web/js/pages/party-modlog.js');
  const e = (action) => ({ action, actor: { name: 'Jolli' }, target: { name: 'Sam' }, detail: {} });
  assert.equal(modLogSentence(e('owner_banner_remove')), "Jolli removed Sam's profile banner picture");
  assert.equal(modLogSentence(e('owner_profile_text_clear')), "Jolli cleared Sam's about me and status");
  assert.match(actionLabel('owner_banner_remove'), /banners removed/);
});
