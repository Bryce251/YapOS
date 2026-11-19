import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, flush, FakeEvent } from './dom-shim.js';

const { document } = installDom({ url: 'https://dash.example.test/u/jolli' });
document.documentElement = document.createElement('html');
if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const { renderProfile, profileCard, clanTag } = await import('../web/js/pages/profile.js');
const { clanSheetBody, apiTransport } = await import('../web/js/pages/clan-sheet.js');
const { normalizeProfile } = await import('../web/js/community-data.js');
const { ApiError } = await import('../web/js/api.js');

function walk(node, out = []) {
  for (const c of node.childNodes || []) {
    out.push(c);
    walk(c, out);
  }
  return out;
}

const click = (el) => el.dispatchEvent(new FakeEvent('click', { bubbles: true }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PROFILE = {
  profile: {
    username: 'jolli',
    name: 'Jolli',
    level: 40,
    badges: ['founder', 'einstein', 'first-game'],
    achievements: [],
    clan: { name: "Yapin'", tag: 'YAP', colour: '#7c5cff' },
    custom: { v: 1, pins: ['founder', 'einstein'], status: 'Developing YapOS!', statusEmoji: '\u{1F6E0}', pronouns: 'he/him', density: 'compact', banner: 'aurora' },
  },
};

const CLAN = { tag: 'YAP', name: "Yapin'", colour: '#7c5cff', banner: 'We yap a lot', members: 12, join: 'open', leader: { name: 'Jolli', username: 'jolli' }, top: [{ name: 'Jolli', username: 'jolli', level: 40, leader: true }] };
const viewer = (status, extra = {}) => ({ signedIn: status !== 'signed_out', status, clan: null, request: null, ...extra });

function mount({ get, post, user = null } = {}) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const ctrl = new AbortController();
  const calls = [];
  const ctx = {
    params: { name: 'jolli' },
    signal: ctrl.signal,
    api: {
      get: async (path, opts) => {
        calls.push({ method: 'GET', path, opts });
        if (path.startsWith('/api/likes/')) return { count: 0, liked: false, own: false, signedIn: false, canLike: false };
        return path.startsWith('/api/u/') ? PROFILE : get(path, opts);
      },
      post: async (path, body, opts) => {
        calls.push({ method: 'POST', path, body, opts });
        return post(path, body, opts);
      },
    },
    title: '',
    setTitle(t) { ctx.title = t; },
    getUser: async () => user,
    abort: () => ctrl.abort(),
  };
  renderProfile(root, ctx);
  return { root, ctx, calls };
}

test('the hero puts the status, clan and pinned badges in a full width band under the name', async () => {
  const { root, ctx } = mount({ get: async () => ({}) });
  await flush();
  const hero = root.querySelector('.profile-hero');
  const top = hero.querySelector('.profile-hero-top');
  const band = hero.querySelector('.profile-band');
  assert.ok(top && band);
  assert.equal(band.parentNode, hero, 'the band is a sibling of the avatar row, so it spans the card');
  assert.equal(top.querySelector('.profile-band'), null);
  assert.ok(band.classList.contains('has-status') && band.classList.contains('has-chips'));
  assert.match(band.querySelector('.profile-status').textContent, /Developing YapOS!/);
  const chips = band.querySelector('.profile-pins');
  assert.equal(chips.getAttribute('aria-label'), 'Clan and pinned badges');
  const items = [...chips.children];
  assert.equal(items[0].className, 'profile-pins-clan');
  assert.deepEqual(items.slice(1).map((li) => li.querySelector('.profile-pin-label').textContent), ['Founder', 'Einstein']);
  assert.match(top.querySelector('.profile-sub').textContent, /@jollihe\/him/);
  assert.ok(root.querySelector('.profile-card').classList.contains('look-compact'));
  ctx.abort();
});

test('the clan pill is a button that opens the clan sheet, and Join shows pending then joined', async () => {
  const gets = [
    { clan: CLAN, viewer: viewer('can_join') },
    { clan: { ...CLAN, members: 13 }, viewer: viewer('member', { request: { status: 'joined', code: 'joined', message: 'Joined.' } }) },
  ];
  const { root, ctx, calls } = mount({
    get: async () => gets.shift(),
    post: async () => ({ request: { status: 'pending' }, viewer: viewer('pending', { request: { status: 'pending', message: 'Waiting for YapOS to add you.' } }) }),
  });
  await flush();
  const pill = root.querySelector('.clan-tag');
  assert.equal(pill.localName, 'button');
  assert.equal(pill.className, 'clan-tag');
  assert.equal(pill.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(pill.getAttribute('aria-label'), "Clan [YAP] Yapin'. Open clan");
  assert.equal(pill.style.props['--clan'], '#7c5cff');
  click(pill);
  await flush();
  await flush();
  const sheet = () => document.body.querySelector('.clan-drawer .clan-sheet');
  assert.ok(sheet(), 'the clan sheet opens in a dialog');
  assert.equal(document.body.querySelector('.clan-drawer [role="dialog"]').getAttribute('aria-modal'), 'true');
  const get = calls.find((c) => c.path === '/api/clans/YAP');
  assert.equal(get.opts.allow401, true);
  const t = sheet().textContent;
  assert.match(t, /We yap a lot/);
  assert.match(t, /Members12/);
  assert.match(t, /LeaderJolli/);
  assert.match(t, /JoiningOpen/);
  assert.match(t, /Open to everyone/);
  assert.equal(sheet().style.props['--clan'], '#7c5cff');
  const join = sheet().querySelector('.clan-sheet-join');
  assert.match(join.textContent, /Join \[YAP\]/);
  click(join);
  await flush();
  await flush();
  assert.ok(calls.find((c) => c.method === 'POST' && c.path === '/api/clans/YAP/join'));
  assert.match(sheet().querySelector('.clan-sheet-status').textContent, /Waiting for YapOS/);
  assert.equal(sheet().querySelector('.clan-sheet-join').disabled, true);
  await wait(3100);
  await flush();
  assert.match(sheet().querySelector('.clan-sheet-status').textContent, /You joined \[YAP\] Yapin'!/);
  assert.match(sheet().textContent, /Members13/);
  ctx.abort();
});

test('the sheet body covers every state without a join button where joining cannot work', () => {
  const st = (v, clan = CLAN) => ({ phase: 'ready', clan: { ...clan, leader: clan.leader, top: clan.top }, viewer: v, busy: false, note: null });
  const read = (s) => clanSheetBody(s, { onJoin: () => {}, onRetry: () => {} });
  const signedOut = read(st({ ...viewer('signed_out'), pendingTag: null }));
  const link = walk(signedOut).find((n) => n.localName === 'a' && String(n.className).includes('clan-sheet-join'));
  const people = walk(signedOut).filter((n) => n.localName === 'a' && String(n.className).includes('clan-sheet-member-btn'));
  assert.ok(people.length >= 1);
  assert.match(String(people[0].getAttribute('href') || people[0].href), /^\/u\//);
  assert.match(String(link.getAttribute('href') || link.href), /\/auth\/login\?next=/);
  assert.match(link.textContent, /Sign in to join/);
  for (const [v, re] of [
    [viewer('invite_only'), /invite only/],
    [{ ...viewer('other'), clan: { code: '[OWL]', name: 'Night Owls', full: '[OWL] Night Owls' } }, /Leave it first with \/clan leave/],
    [viewer('member'), /in this clan/],
    [{ ...viewer('pending_other'), pendingTag: 'OWL' }, /\[OWL\]/],
  ]) {
    const body = read(st(v));
    assert.match(body.querySelector('.clan-sheet-status').textContent, re);
    assert.equal(body.querySelector('.clan-sheet-join'), null, v.status);
  }
  const invite = read(st(viewer('invite_only'), { ...CLAN, join: 'invite' }));
  assert.ok(invite.classList.contains('is-invite'));
  assert.match(invite.textContent, /Invite only/);
  assert.equal(read({ phase: 'loading' }).getAttribute('aria-busy'), 'true');
  assert.match(read({ phase: 'error' }).querySelector('.clan-sheet-join').textContent, /Try again/);
  assert.match(read({ phase: 'missing' }).textContent, /couldn't find this clan/);
});

test('the transport turns api errors into status and data for the join flow', async () => {
  const api = {
    get: async () => { throw new ApiError('nope', { status: 409, code: 'http_409', data: { error: 'in_other_clan', viewer: viewer('other') } }); },
    post: async () => ({ request: { status: 'pending' } }),
  };
  const send = apiTransport(api, null);
  assert.deepEqual(await send('GET', '/api/clans/YAP'), { status: 409, data: { error: 'in_other_clan', viewer: viewer('other') } });
  assert.deepEqual(await send('POST', '/api/clans/YAP/join'), { status: 200, data: { request: { status: 'pending' } } });
});

test('previews and bad tags show a plain pill, never a button', () => {
  const p = normalizeProfile({ profile: { name: 'Juno', username: 'juno', clan: { name: 'Night Owls', tag: 'OWL' } } });
  assert.equal(walk(profileCard(p, { editing: true, onClan: () => {} })).find((n) => n.className === 'clan-tag').localName, 'span');
  assert.equal(clanTag({ name: 'X', tag: '<b>' }, () => {}).localName, 'span');
  let opened = null;
  const btn = clanTag({ name: 'Night Owls', tag: 'owl' }, (t) => { opened = t; });
  click(btn);
  assert.equal(opened, 'owl');
});

test('the hero CSS gives the band the full card width at every density and size', () => {
  const features = readFileSync(new URL('../web/css/features.css', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../web/css/profile.css', import.meta.url), 'utf8');
  assert.match(features, /\.profile-hero \{[^}]*flex-direction: column;/);
  assert.match(features, /\.profile-hero-top \{[^}]*display: flex;/);
  assert.match(css, /\.profile-band \{[^}]*width: 100%;/);
  assert.match(css, /\.profile-band > \.profile-pins \{[^}]*width: 100%;/);
  assert.match(css, /\.profile-pins \{[^}]*flex-wrap: wrap;/);
  assert.match(css, /\.profile-card\.look-compact \.profile-band/);
  assert.match(css, /\.profile-card\.look-roomy \.profile-band/);
  assert.match(css, /\.profile-card\.has-banner \.profile-hero-top \{[^}]*align-items: flex-start;/);
  assert.doesNotMatch(css, /\.profile-card\.has-banner \.profile-hero \{/, 'the column hero is never squeezed to its content width');
  const container = css.slice(css.indexOf('@container pcard (max-width: 520px)'));
  assert.match(container, /\.profile-hero-top \{[^}]*flex-wrap: wrap;/);
  assert.match(css, /button\.clan-tag:focus-visible \{[^}]*outline: 2px solid/);
  assert.match(css, /\.clan-sheet \{/);
  assert.equal(/[^\x00-\x7f]/.test(css), false);
});
