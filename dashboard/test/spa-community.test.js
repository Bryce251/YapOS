import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, flush, type, fire } from './dom-shim.js';

const { document, window } = installDom({ url: 'https://dash.example.test/u/bea' });
document.documentElement = document.createElement('html');
const { matchRoute, profilePath } = await import('../web/js/router.js');
const { ApiError } = await import('../web/js/api.js');
const { renderProfile, levelRing, placingText } = await import('../web/js/pages/profile.js');
const { renderSeasons } = await import('../web/js/pages/seasons.js');
const { renderPacksBrowse, browseUrl, reportReason } = await import('../web/js/pages/packs-browse.js');
const { renderAccount, readVisibility, VISIBILITY_API } = await import('../web/js/pages/account.js');
const { normalizeProfile, normalizeSeasons, normalizeBrowse, levelProgress, badgeInfo, gameInfo } = await import('../web/js/community-data.js');
const { readReports, PACK_REPORTS_PATH } = await import('../web/js/pages/party-reports.js');
const { createShell } = await import('../web/js/shell.js');
const { state } = await import('../web/js/state.js');

const SID = '33333333-3333-4333-8333-333333333333';
const EVIL = '<img src=x onerror=alert(1)>';

function walk(node, out = []) {
  for (const c of node.childNodes || []) {
    out.push(c);
    walk(c, out);
  }
  return out;
}

const tags = (root) => walk(root).map((n) => n.localName).filter(Boolean);

function mountPublic(render, { get, post, params = {}, user = null } = {}) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const ctrl = new AbortController();
  const ctx = {
    params,
    signal: ctrl.signal,
    api: { get: get || (async () => ({})), post: post || (async () => ({})) },
    title: '',
    setTitle(t) { ctx.title = t; },
    getUser: async () => user,
    abort: () => ctrl.abort(),
  };
  render(root, ctx);
  return { root, ctx };
}

const PROFILE = {
  profile: {
    username: 'bea',
    name: 'Bea',
    avatar: null,
    level: 3,
    xp: 400,
    shards: null,
    badges: ['first-game', 'wins-10', 'brand-new'],
    achievements: ['messages-10k', { id: 'custom-one', label: 'Custom one', emoji: '🧪' }],
    season: [{ month: '2026-09', rank: 4, kind: 'xp' }, { month: '2026-10', rank: 1, kind: 'shards' }],
    clan: { name: 'Night Owls', tag: 'OWL', colour: '#7c5cff' },
    party: { games: 42, wins: 11, favourites: [{ game: 'draw', played: 20, won: 6 }, { game: 'hive', played: 8, won: 0 }] },
    updatedAt: Date.now() - 60000,
  },
  partyBadges: [{ id: 'wins-10', label: 'Winner', emoji: '🥇' }],
};

test('the new pages are registered with the right privacy', () => {
  const cases = [
    ['/u/Bea', 'profile', false, { name: 'Bea' }],
    ['/u/bea.smith_1', 'profile', false, { name: 'bea.smith_1' }],
    ['/seasons', 'seasons', false, {}],
    ['/packs/browse', 'packs-browse', false, {}],
    ['/account', 'account', true, {}],
    [`/servers/${SID}/stats`, 'stats', true, { sid: SID }],
  ];
  for (const [path, name, priv, params] of cases) {
    const r = matchRoute(path);
    assert.equal(r.name, name, path);
    assert.equal(r.private, priv, path);
    assert.deepEqual(r.params, params, path);
  }
  assert.equal(matchRoute('/u/a/b').name, 'not-found');
  assert.equal(matchRoute('/u/a%3Cb').name, 'not-found');
  assert.equal(matchRoute('/packs').name, 'packs');
  assert.equal(profilePath('@bea'), '/u/bea');
});

test('the shell links to the account page and every server gets a Stats tab', () => {
  const shell = createShell({ onLogout: () => {} });
  shell.update({ variant: 'server', section: 'stats', server: { id: SID, name: 'Test Town' }, user: { id: 'u1', username: 'bea' }, crumbs: [] });
  const account = shell.root.querySelectorAll('a').find((a) => a.href === '/account');
  assert.ok(account);
  const stats = shell.root.querySelectorAll('a.nav-item').find((a) => a.href === `/servers/${SID}/stats`);
  assert.ok(stats);
  assert.equal(stats.getAttribute('aria-current'), 'page');
});

test('profile data is read kindly, with badge names from the worker catalog', () => {
  const p = normalizeProfile(PROFILE);
  assert.equal(p.name, 'Bea');
  assert.equal(p.games, 42);
  assert.equal(p.wins, 11);
  assert.equal(p.shards, null);
  assert.deepEqual(p.badges.map((b) => b.label), ['First game', 'Winner', 'Brand new']);
  assert.deepEqual(p.achievements.map((a) => a.label), ['Sent 10k messages', 'Custom one']);
  assert.deepEqual(p.season.map((s) => s.month), ['2026-10', '2026-09']);
  assert.equal(p.clan.colour, '#7c5cff');
  assert.deepEqual(p.favourites.map((f) => [f.name, f.plays, f.won]), [['Draw & Guess', 20, 6], ['Letter Hive', 8, 0]]);
  assert.equal(normalizeProfile(null), null);
  assert.equal(normalizeProfile({ profile: { clan: { name: 'X', colour: 'red; background: url(x)' } } }).clan.colour, '');
  assert.equal(badgeInfo({ id: 'x', emoji: '💥💥💥💥💥💥' }).emoji, '🏅');
  assert.equal(gameInfo('sketchduel').name, 'Sketch Duel');
  assert.equal(gameInfo('zzz-new').name, 'Zzz new');
});

test('the level ring shows progress to the next level', () => {
  assert.deepEqual(levelProgress(0, 50), { level: 0, into: 50, need: 100, frac: 0.5, known: true });
  assert.equal(levelProgress(3, null).known, false);
  const ring = levelRing(1, 100 + 77);
  assert.match(ring.getAttribute('aria-label'), /Level 1, 77 of 155 XP/);
  const fill = walk(ring).find((n) => n.getAttribute?.('class') === 'level-ring-fill');
  assert.equal(fill.style.props['--p'], '50');
});

test('a public profile renders the card with badges, favourites, placings and clan', async () => {
  const seen = [];
  const { root, ctx } = mountPublic(renderProfile, { params: { name: 'bea' }, get: async (path) => { seen.push(path); return PROFILE; } });
  await flush();
  assert.deepEqual(seen, ['/api/u/bea']);
  assert.equal(ctx.title, 'Bea');
  const text = root.textContent;
  assert.match(text, /@bea/);
  assert.match(text, /\[OWL\]/);
  assert.match(text, /Night Owls/);
  assert.equal(root.querySelectorAll('.badge-tile').length, 5);
  assert.match(text, /🥇/);
  assert.match(text, /Draw & Guess/);
  assert.match(text, /20 games · 6 wins/);
  assert.match(text, /#1 for Most 💎 Shards earned in October 2026/);
  assert.doesNotMatch(text, /💎 Shards\d/);
  assert.equal(root.querySelectorAll('.profile-stat').length, 2);
  assert.equal(root.querySelector('.clan-tag').style.props['--clan'], '#7c5cff');
  assert.equal(placingText({ rank: 4, kind: 'xp', label: 'September 2026' }), '#4 for Most XP in September 2026');
  ctx.abort();
});

test('a profile shows Shards only when the worker sends them', async () => {
  const data = { profile: { ...PROFILE.profile, shards: 1234 } };
  const { root, ctx } = mountPublic(renderProfile, { params: { name: 'bea' }, get: async () => data });
  await flush();
  assert.equal(root.querySelectorAll('.profile-stat').length, 3);
  assert.match(root.textContent, /1,234/);
  ctx.abort();
});

test('profile text from players is shown as text, never as markup', async () => {
  const data = { profile: { username: 'bea', name: EVIL, level: 1, badges: [{ id: 'x', label: EVIL, emoji: '🙂' }], clan: { name: EVIL, tag: '<b>' }, party: { favourites: [{ game: 'zzz', name: EVIL, played: 1 }] } } };
  const { root, ctx } = mountPublic(renderProfile, { params: { name: 'bea' }, get: async () => data });
  await flush();
  assert.ok(root.textContent.includes(EVIL));
  const card = root.querySelector('.profile-card');
  assert.equal(tags(card).includes('img'), false);
  assert.equal(tags(card).includes('b'), false);
  assert.ok(root.querySelector('.clan-tag-code').textContent.includes('<b>'));
  ctx.abort();
});

test('a hidden or unknown profile says it is not available, without saying which', async () => {
  const { root, ctx } = mountPublic(renderProfile, { params: { name: 'ghost' }, get: async () => { throw new ApiError('nope', { status: 404, code: 'not_found' }); } });
  await flush();
  assert.match(root.textContent, /isn't available/);
  assert.match(root.textContent, /private/);
  assert.equal(ctx.title, 'Profile not found');
  ctx.abort();
});

test('your own profile links to the privacy settings', async () => {
  const { root, ctx } = mountPublic(renderProfile, { params: { name: 'bea' }, get: async () => PROFILE, user: { id: 'u1', username: 'Bea' } });
  await flush();
  assert.ok(root.querySelectorAll('a').some((a) => a.href === '/account'));
  ctx.abort();
});

const SEASONS = {
  seasons: [
    { month: '2026-09', boards: { xp: [{ rank: 1, name: 'Al', username: 'al', value: 900, profile: true }], shards: [] } },
    { month: '2026-10', boards: { xp: [{ rank: 2, name: 'Cy', username: 'cy', value: 10, profile: false }, { rank: 1, name: EVIL, username: 'bea', value: 3000, profile: true }], shards: [{ rank: 1, name: 'Bea', username: null, value: 5000 }] } },
    { month: 'bad', boards: {} },
  ],
};

test('season history lists the newest season first and links only open profiles', async () => {
  const s = normalizeSeasons(SEASONS);
  assert.deepEqual(s.map((x) => x.month), ['2026-10', '2026-09']);
  assert.deepEqual(s[0].xp.map((r) => r.rank), [1, 2]);
  const { root, ctx } = mountPublic(renderSeasons, { get: async (path) => (path === '/api/seasons' ? SEASONS : null) });
  await flush();
  assert.equal(ctx.title, 'Past seasons');
  const cards = root.querySelectorAll('.season-card');
  assert.equal(cards.length, 2);
  assert.match(cards[0].textContent, /October 2026/);
  assert.match(cards[0].textContent, /💎 5,000/);
  const links = root.querySelectorAll('a.season-name').map((a) => a.href);
  assert.deepEqual(links, ['/u/bea', '/u/al']);
  assert.ok(root.textContent.includes(EVIL));
  assert.equal(tags(root.querySelector('.season-list')).includes('img'), false);
  ctx.abort();
});

test('season history has a friendly empty state', async () => {
  const { root, ctx } = mountPublic(renderSeasons, { get: async () => ({ seasons: [] }) });
  await flush();
  assert.match(root.textContent, /No finished seasons yet/);
  ctx.abort();
});

const BROWSE = {
  packs: [
    { code: 'MOVIE123', name: 'Movie night', wordCount: 40, triviaCount: 2, likes: 7, by: 'bea', published: Date.now() - 3600000 },
    { code: 'EVIL0001', name: EVIL, wordCount: 1, triviaCount: 0, likes: 0, by: EVIL },
  ],
  sort: 'top',
  page: 1,
  more: true,
  liked: ['MOVIE123'],
};

test('pack browser helpers build urls and read the worker reply', () => {
  assert.equal(browseUrl({}), '/api/packs/browse?sort=top');
  assert.equal(browseUrl({ sort: 'new', q: '  space  ', page: 2 }), '/api/packs/browse?sort=new&q=space&page=2');
  const v = normalizeBrowse(BROWSE);
  assert.equal(v.packs[0].liked, true);
  assert.equal(v.packs[1].liked, false);
  assert.equal(v.packs[0].author, 'bea');
  assert.equal(v.next, 2);
  assert.equal(normalizeBrowse({ packs: [], more: false }).next, null);
  assert.equal(reportReason('spam', '  lots   of   junk '), 'Spam or junk: lots of junk');
  assert.equal(reportReason('nope', ''), 'Something else');
});

test('the pack browser lists packs, sorts, searches and escapes names', async () => {
  window.history.replaceState(null, '', '/packs/browse');
  const seen = [];
  const { root, ctx } = mountPublic(renderPacksBrowse, { get: async (path) => { seen.push(path); return BROWSE; } });
  await flush();
  assert.equal(seen[0], '/api/packs/browse?sort=top');
  assert.equal(root.querySelectorAll('.browse-item').length, 2);
  assert.ok(root.textContent.includes(EVIL));
  assert.equal(tags(root.querySelector('.browse-list')).includes('img'), false);
  assert.match(root.textContent, /40 words · 2 questions · by bea/);
  const like = root.querySelector('.like-btn');
  assert.equal(like.getAttribute('aria-pressed'), 'true');
  root.querySelectorAll('button').find((b) => /Newest/.test(b.textContent)).click();
  await flush();
  assert.equal(seen[1], '/api/packs/browse?sort=new');
  assert.match(window.location.search, /sort=new/);
  type(root.querySelector('input[type=search]'), 'movie');
  await new Promise((r) => setTimeout(r, 400));
  await flush();
  assert.equal(seen[2], '/api/packs/browse?sort=new&q=movie');
  root.querySelectorAll('button').find((b) => /Show more/.test(b.textContent)).click();
  await flush();
  assert.equal(seen[3], '/api/packs/browse?sort=new&q=movie&page=2');
  assert.equal(root.querySelectorAll('.browse-item').length, 2);
  ctx.abort();
});

test('signed-in players can like a pack and the count follows the worker', async () => {
  window.history.replaceState(null, '', '/packs/browse');
  const posts = [];
  const { root, ctx } = mountPublic(renderPacksBrowse, {
    get: async () => BROWSE,
    post: async (path, body) => { posts.push([path, body]); return { ok: true, liked: true, likes: 9 }; },
    user: { id: 'u1', username: 'bea' },
  });
  await flush();
  const like = root.querySelectorAll('.like-btn')[1];
  like.click();
  await flush();
  assert.deepEqual(posts, [['/api/packs/EVIL0001/like', {}]]);
  assert.equal(like.getAttribute('aria-pressed'), 'true');
  assert.equal(like.querySelector('.like-count').textContent, '9');
  ctx.abort();
});

test('a failed like puts the old count back', async () => {
  window.history.replaceState(null, '', '/packs/browse');
  const { root, ctx } = mountPublic(renderPacksBrowse, {
    get: async () => BROWSE,
    post: async () => { throw new ApiError('Too fast', { status: 429, code: 'rate_limited' }); },
    user: { id: 'u1', username: 'bea' },
  });
  await flush();
  const like = root.querySelectorAll('.like-btn')[0];
  like.click();
  await flush();
  assert.equal(like.getAttribute('aria-pressed'), 'true');
  assert.equal(like.querySelector('.like-count').textContent, '7');
  ctx.abort();
});

test('reporting a pack sends only a reason the worker accepts', async () => {
  window.history.replaceState(null, '', '/packs/browse');
  const posts = [];
  const { root, ctx } = mountPublic(renderPacksBrowse, {
    get: async () => BROWSE,
    post: async (path, body) => { posts.push([path, body]); return { ok: true, reported: true }; },
    user: { id: 'u1', username: 'bea' },
  });
  await flush();
  root.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Report Movie night').click();
  await flush();
  const dialog = document.body.querySelector('.dialog-panel');
  assert.ok(dialog);
  const radios = dialog.querySelectorAll('input[type=radio]');
  radios[1].checked = true;
  fire(radios[1], 'change');
  dialog.querySelectorAll('button').find((b) => /Send report/.test(b.textContent)).click();
  await flush();
  assert.equal(posts.length, 1);
  assert.equal(posts[0][0], '/api/packs/MOVIE123/report');
  assert.deepEqual(Object.keys(posts[0][1]), ['reason']);
  assert.equal(typeof posts[0][1].reason, 'string');
  ctx.abort();
});

test('the browse page offers a login link to signed-out visitors', async () => {
  window.history.replaceState(null, '', '/packs/browse');
  const { root, ctx } = mountPublic(renderPacksBrowse, { get: async () => BROWSE });
  await flush();
  const login = root.querySelectorAll('a').find((a) => String(a.href).startsWith('/auth/login'));
  assert.ok(login);
  assert.match(login.href, /next=%2Fpacks%2Fbrowse/);
  ctx.abort();
});

function makeShellCtx(api) {
  const main = document.createElement('main');
  document.body.replaceChildren(main);
  const ctrl = new AbortController();
  return { api, main, signal: ctrl.signal, params: {}, setChrome: () => {}, setLeaveGuard: () => {}, abort: () => ctrl.abort() };
}

test('the account page toggles profile visibility and Shards through the worker', async () => {
  state.user = { id: 'u1', username: 'bea', display_name: 'Bea' };
  const posts = [];
  const ctx = makeShellCtx({
    get: async (path) => (path === VISIBILITY_API ? { hidden: false, showShards: false, pending: false, username: 'bea' } : null),
    post: async (path, body) => { posts.push([path, body]); return { ok: true, ...body, pending: true }; },
  });
  renderAccount(ctx);
  await flush();
  assert.ok(ctx.main.querySelectorAll('a').some((a) => a.href === '/u/bea'));
  const switches = ctx.main.querySelectorAll('button.switch');
  assert.equal(switches.length, 2);
  assert.equal(switches[0].getAttribute('aria-checked'), 'true');
  assert.equal(switches[1].getAttribute('aria-checked'), 'false');
  switches[1].click();
  await flush();
  assert.deepEqual(posts[0], [VISIBILITY_API, { hidden: false, showShards: true }]);
  assert.equal(switches[1].getAttribute('aria-checked'), 'true');
  switches[0].click();
  await flush();
  assert.deepEqual(posts[1], [VISIBILITY_API, { hidden: true, showShards: true }]);
  assert.equal(switches[0].getAttribute('aria-checked'), 'false');
  assert.equal(switches[1].disabled, true);
  assert.match(ctx.main.textContent, /within a minute or two/);
  ctx.abort();
});

test('a failed visibility save puts the switch back', async () => {
  state.user = { id: 'u1', username: 'bea' };
  const ctx = makeShellCtx({
    get: async () => ({ hidden: false, showShards: false }),
    post: async () => { throw new ApiError('Nope', { status: 500, code: 'http_500' }); },
  });
  renderAccount(ctx);
  await flush();
  const sw = ctx.main.querySelectorAll('button.switch')[0];
  sw.click();
  await flush();
  assert.equal(sw.getAttribute('aria-checked'), 'true');
  assert.deepEqual(readVisibility({ hidden: true }), { hidden: true, showShards: false, pending: false });
  ctx.abort();
});

test('pack reports come from their own list and keep the reason as text', () => {
  assert.equal(PACK_REPORTS_PATH, '/api/party/pack-reports');
  const v = readReports({
    reports: [
      { id: 'r1', code: 'MOVIE123', reason: EVIL, created: 1, status: 'open', reporter: { id: 'u2', name: 'Cy' }, pack: { code: 'MOVIE123', name: 'Movie night', owner: { id: 'u1', username: 'bea' }, words: ['popcorn'], public: true, blocked: false } },
      { id: 'r2', code: 'GONE0001', reason: null, created: 2, status: 'dismissed', reporter: { id: 'u2' }, pack: null },
    ],
    open: 1,
    role: 'owner',
  }, 'pack');
  assert.equal(v.reports.length, 2);
  assert.equal(v.reports[0].kind, 'pack');
  assert.equal(v.reports[0].text, EVIL);
  assert.equal(v.reports[0].drawer.id, 'u1');
  assert.equal(v.reports[0].pack.public, true);
  assert.equal(v.reports[1].pack.gone, true);
  assert.equal(v.reports[1].status, 'dismissed');
});
