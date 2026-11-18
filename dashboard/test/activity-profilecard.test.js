import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, FakeEvent, flush } from './dom-shim.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const activity = path.join(here, '..', 'web', 'activity');
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function text(node) {
  if (node.data !== undefined && !node.localName) return node.data;
  return (node.childNodes || []).map(text).join(' ');
}

function key(el, k, extra = {}) {
  const e = new FakeEvent('keydown', { bubbles: true, key: k });
  Object.assign(e, extra);
  el.dispatchEvent(e);
  return e;
}

function tap(el, at = null) {
  const root = el;
  const down = new FakeEvent('pointerdown', { bubbles: true });
  const click = new FakeEvent('click', { bubbles: true });
  if (at) {
    Object.assign(down, { clientX: at[0], clientY: at[1] });
    Object.assign(click, { clientX: at[2], clientY: at[3] });
  }
  root.dispatchEvent(down);
  root.dispatchEvent(click);
}

function card(profile) {
  return {
    hidden: false,
    name: 'Alice',
    username: 'alice',
    avatar: 'https://files.yapper.website/a.png',
    level: 3,
    xp: 500,
    progress: { into: 35, need: 205 },
    shards: 4200,
    badges: [{ id: 'first-game', label: 'First game', emoji: '🎈' }],
    badgeCount: 1,
    achievements: [],
    clan: { name: 'Night Owls', tag: 'OWL' },
    party: { games: 12, wins: 4, bestStreak: 3, favourites: [{ game: 'draw', played: 7 }] },
    rank: { rank: 2, points: 900 },
    page: true,
    ...profile,
  };
}

async function setup({ respond, alone = false, players = null } = {}) {
  const { document } = installDom({ url: 'https://yapos.dev/activity/' });
  const calls = [];
  const win = {
    document,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return respond ? respond(url) : new Response(JSON.stringify({ profile: card() }), { status: 200 });
    },
  };
  const { avatar, h } = await import('../web/activity/js/ui/dom.js');
  const { createProfileCard } = await import('../web/activity/js/ui/profilecard.js');
  const list = players || [
    { id: ID, name: 'Alice', initials: 'A', hue: 30, avatar: null, isMe: false, isHost: true, present: true, joined: true },
    { id: OTHER, name: 'Bob', initials: 'B', hue: 200, avatar: null, isMe: true, isHost: false, present: true, joined: true },
  ];
  const engine = { snapshot: () => ({ ready: true, me: OTHER, players: list, room: { phase: 'lobby' } }) };
  const root = h('div', { class: 'app' });
  document.body.append(root);
  const face = avatar(list[0], 'md');
  const nested = h('button', { type: 'button', class: 'choice' }, avatar(list[1], 'xs'));
  root.append(face, nested);
  const pc = createProfileCard({ win, engine, alone });
  pc.bind(root);
  return { document, root, face, nested, pc, calls, win };
}

test('avatars carry data-profile-id and become keyboard buttons, except inside other buttons', async () => {
  const { face, nested } = await setup();
  assert.equal(face.getAttribute('data-profile-id'), ID);
  assert.equal(face.getAttribute('role'), 'button');
  assert.equal(face.getAttribute('tabindex'), '0');
  assert.equal(face.getAttribute('aria-label'), "View Alice's profile");
  assert.equal(face.getAttribute('aria-hidden'), null);
  const inner = nested.querySelector('.avatar');
  assert.equal(inner.getAttribute('tabindex'), null);
  assert.equal(inner.getAttribute('aria-hidden'), 'true');
});

test('clicking an avatar opens the profile card, fills it from the server, Esc closes it and focus returns', async () => {
  const { document, face, pc, calls } = await setup();
  face.focus();
  tap(face);
  assert.equal(pc.isOpen, true);
  assert.equal(pc.el.hidden, false);
  const panel = pc.el.querySelector('.pcard');
  assert.equal(panel.getAttribute('role'), 'dialog');
  assert.equal(panel.getAttribute('aria-modal'), 'true');
  assert.ok(panel.classList.contains('is-loading'));
  assert.match(text(pc.el), /Alice/);
  assert.equal(document.activeElement, pc.el.querySelector('.pcard-close'));
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/api/activity/profile/${ID}`);
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(panel.classList.contains('is-loading'), false);
  const all = text(pc.el);
  assert.match(all, /@alice/);
  assert.match(all, /Level 3/);
  assert.match(all, /Host/);
  assert.match(all, /#2/);
  assert.match(all, /900 pts/);
  assert.match(all, /First game/);
  assert.match(all, /4,200 Shards/);
  assert.match(all, /Draw/);
  assert.match(all, /yapos\.dev\/u\/alice/);
  assert.equal(pc.el.querySelector('a'), null, 'no links inside a call frame');
  assert.equal(pc.el.querySelector('.pcard-xp-track').style.props['--p'], '17%');
  key(pc.el.querySelector('.pcard-close'), 'Escape');
  assert.equal(pc.isOpen, false);
  assert.equal(document.activeElement, face);
  tap(face);
  await flush();
  assert.equal(calls.length, 1, 'the card is cached');
});

test('Enter and Space open the card from a focused avatar, and the backdrop closes it', async () => {
  const { face, pc } = await setup();
  const e = key(face, 'Enter');
  assert.equal(e.defaultPrevented, true);
  assert.equal(pc.isOpen, true);
  pc.el.querySelector('.pcard-backdrop').click();
  assert.equal(pc.isOpen, false);
  key(face, ' ');
  assert.equal(pc.isOpen, true);
  pc.close();
});

test('Tab stays inside the card', async () => {
  const { document, face, pc } = await setup({ alone: true });
  tap(face);
  await flush();
  const close = pc.el.querySelector('.pcard-close');
  const link = pc.el.querySelector('a.pcard-link');
  assert.ok(link, 'a real link only when the Party is open in its own tab');
  assert.equal(link.getAttribute('href'), '/u/alice');
  link.focus();
  const e = key(link, 'Tab');
  assert.equal(e.defaultPrevented, true);
  assert.equal(document.activeElement, close);
  key(close, 'Tab', { shiftKey: true });
  assert.equal(document.activeElement, link);
  pc.close();
});

test('when the fetch fails the card still shows what the call knows, with a retry', async () => {
  let fail = true;
  const { face, pc, calls } = await setup({ respond: () => (fail ? new Response('{}', { status: 500 }) : new Response(JSON.stringify({ profile: card() }), { status: 200 })) });
  tap(face);
  await flush();
  const panel = pc.el.querySelector('.pcard');
  assert.ok(panel.classList.contains('is-error'));
  assert.match(text(pc.el), /Alice/);
  assert.match(text(pc.el), /couldn't load/);
  assert.equal(pc.el.querySelector('.pcard-initials').textContent, 'A');
  fail = false;
  pc.el.querySelector('.pcard-retry').click();
  await flush();
  assert.equal(calls.length, 2);
  assert.match(text(pc.el), /Level 3/);
  pc.close();
});

test('hidden and unknown players get a friendly line, offline works too', async () => {
  const { face, pc } = await setup({ respond: () => new Response(JSON.stringify({ profile: { hidden: true, name: 'Alice', avatar: null } }), { status: 200 }) });
  tap(face);
  await flush();
  assert.match(text(pc.el), /keeps their profile private/);
  assert.equal(pc.el.querySelector('.pcard-stats'), null);
  pc.close();
  const b = await setup({ respond: () => new Response('{}', { status: 404 }) });
  tap(b.face);
  await flush();
  assert.match(text(b.pc.el), /Stats aren't available/);
  b.pc.close();
  const c = await setup();
  delete c.win.fetch;
  tap(c.face);
  await flush();
  assert.ok(c.pc.el.querySelector('.pcard').classList.contains('is-error'));
  c.pc.close();
});

test('the hero avatar falls back to the initial when the picture fails', async () => {
  const { face, pc } = await setup();
  tap(face);
  await flush();
  const img = pc.el.querySelector('.pcard-face img');
  assert.ok(img);
  img.dispatchEvent(new FakeEvent('error'));
  assert.equal(pc.el.querySelector('.pcard-face img'), null);
  assert.equal(pc.el.querySelector('.pcard-initials').textContent, 'A');
  pc.close();
});

test('drags and taps on avatars inside other buttons do not open the card', async () => {
  const { face, nested, pc } = await setup();
  tap(face, [10, 10, 60, 10]);
  assert.equal(pc.isOpen, false);
  tap(nested.querySelector('.avatar'));
  assert.equal(pc.isOpen, false);
  tap(face, [10, 10, 12, 11]);
  assert.equal(pc.isOpen, true);
  pc.close();
});

test('the profile card makes no shared-state traffic and its files follow the rules', async () => {
  const js = readFileSync(path.join(activity, 'js', 'ui', 'profilecard.js'), 'utf8');
  const css = readFileSync(path.join(activity, 'css', 'profilecard.css'), 'utf8');
  assert.equal(/engine\.(set|send|share|lobby|join)\b/.test(js), false);
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|eval\(|window\.open|\.style\.(?!setProperty)/.test(js), false);
  assert.equal(/\/\*|\/\/ /.test(css), false);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /max-width: 420px/);
  const html = readFileSync(path.join(activity, 'index.html'), 'utf8');
  const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  const at = sheets.indexOf('/activity/css/profilecard.css');
  assert.ok(at > sheets.indexOf('/activity/css/tokens.css'));
  assert.ok(at < sheets.indexOf('/activity/css/juice.css'));
});

test('in the real app, tapping a player in the lobby opens their card over your own screen only', async () => {
  const { room } = await import('./activity-kit.test.js');
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(2, { join: false });
  await r.clock.advance(500);
  const [hostEngine, guestEngine] = r.engines;
  const { mountApp } = await import('../web/activity/js/ui/app.js');
  const mount = (engine) => {
    const root = document.createElement('div');
    document.body.append(root);
    const win = Object.assign(globalThis.window, { document, parent: globalThis.window, innerWidth: 400, innerHeight: 700, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id), setInterval: () => 0, clearInterval: () => {} });
    return { root, app: mountApp({ root, engine, bridge: { close() {} }, win, juice: false }) };
  };
  const host = mount(hostEngine);
  const guest = mount(guestEngine);
  await r.clock.advance(300);
  const hostId = hostEngine.snapshot().me;
  const face = guest.root.querySelectorAll(`[data-profile-id="${hostId}"]`).find((n) => n.getAttribute('data-pc') === 'on');
  assert.ok(face, 'the host avatar is clickable for the guest');
  const sentBefore = r.hub.ops.length;
  tap(face);
  assert.equal(guest.app.profileCard.isOpen, true);
  assert.equal(host.app.profileCard.isOpen, false);
  assert.match(text(guest.app.profileCard.el), /Host/);
  assert.equal(r.hub.ops.length, sentBefore, "opening a card sends nothing to the call");
  key(guest.app.profileCard.el.querySelector('.pcard-close'), 'Escape');
  assert.equal(guest.app.profileCard.isOpen, false);
  host.app.destroy();
  guest.app.destroy();
});

test('profile buttons that wrap an avatar open the card from the wrapper or the face inside it', async () => {
  const { root, pc } = await setup();
  const { profileButton } = await import('../web/activity/js/ui/dom.js');
  if (typeof profileButton !== 'function') return;
  const wrap = profileButton({ id: OTHER, name: 'Bob', initials: 'B', hue: 200, isMe: true }, 'sm');
  root.append(wrap);
  pc.scan();
  const inner = wrap.querySelector('.avatar');
  assert.equal(inner.getAttribute('tabindex'), null, 'only the wrapper takes focus');
  tap(inner);
  assert.equal(pc.openId, OTHER);
  assert.match(text(pc.el), /You/);
  pc.close();
  const e = key(wrap, 'Enter');
  assert.equal(e.defaultPrevented, true);
  assert.equal(pc.openId, OTHER);
  pc.close();
});

function richCard(extra = {}) {
  return card({
    name: 'bunny | Top #1 Kanna Glazer of the whole server',
    badges: [
      { id: 'first-game', label: 'First game', emoji: '🎈' },
      { id: 'party-regular', label: 'Party regular', emoji: '🎲', note: 'Played 10 games' },
      { id: 'yapos-tester', label: 'YapOS tester', emoji: '🧪' },
      { id: 'c-devstar1', label: 'Dev star', image: '/badge-img/c-devstar1-0123456789abcdef.png', note: 'Only from Jolli' },
      { id: 'wins-10', label: 'Winner', emoji: '🥇' },
      { id: 'night-owl', label: 'Night owl', emoji: '🦉' },
    ],
    badgeCount: 30,
    achievements: [{ id: 'messages-10k', label: 'Messages 10k', emoji: '💬' }],
    party: { games: 48, wins: 4, bestStreak: 5, favourites: [{ game: 'draw', played: 20 }, { game: 'wyr', played: 15 }, { game: 'odd', played: 9 }] },
    rank: { rank: 1, points: 466873 },
    shards: 25215,
    look: {
      pins: ['ach:messages-10k', 'c-devstar1', 'nope!'],
      nameColour: { light: '#ce4172', dark: '#e5487f' },
      nameFont: 'serif',
      accent: { base: '#e5487f', light: '#ce4172', dark: '#e5487f' },
      banner: 'image',
      bannerImage: '/banner-img/b-devbanner9-78b2e29c0e52fea5.png',
      ring: 'rainbow',
      pronouns: 'she/her',
      status: 'Hosting game night',
      statusEmoji: '🎮',
    },
    ...extra,
  });
}

test('the layout model keeps every row to one line and the card fits a 320x560 call without scrolling', async () => {
  const pc = await import('../web/activity/js/ui/profilecard.js');
  const m = pc.cardModel(pc.cleanCard(richCard()));
  assert.equal(m.favourites.length, 3);
  assert.ok(m.favourites.length <= pc.FAVS_SHOWN);
  assert.equal(m.row.length, pc.BADGES_SHOWN);
  assert.deepEqual(m.row.slice(0, 2).map((b) => b.id), ['messages-10k', 'c-devstar1'], 'pinned badges come first in pin order, achievements included');
  assert.ok(m.row[0].pinned && m.row[1].pinned && !m.row[2].pinned);
  assert.equal(m.all.length, 7);
  assert.equal(m.total, 31);
  assert.equal(m.unlisted, 24);
  assert.deepEqual(m.stats.map((s) => s.key), ['games', 'wins', 'rate', 'streak']);
  assert.equal(m.stats[2].value, '8%');
  assert.deepEqual(m.facts.map((f) => f.text), ['#1 · 467K pts', '25,215 Shards']);
  assert.equal(m.facts[0].top, 1);
  assert.match(m.facts[0].title, /466,873 points/);
  assert.equal(pc.short(99999), '99,999');
  assert.equal(pc.short(1250000), '1.3M');
  const fewer = pc.cardModel(pc.cleanCard(card({ party: { games: 0, wins: 0, bestStreak: 0, favourites: [] }, rank: null, shards: null })));
  assert.deepEqual(fewer.stats.map((s) => s.key), ['games', 'wins', 'rate']);
  assert.equal(fewer.stats[2].value, '–');
  assert.deepEqual(fewer.facts, []);
  const sheet = 560 - 24;
  const centred = 560 - 32;
  assert.ok(pc.cardHeight('ready') <= Math.min(sheet, centred), `card is ${pc.cardHeight('ready')}px`);
  assert.equal(pc.cardHeight('loading'), pc.cardHeight('ready'), 'the skeleton takes the same space as the loaded card');
  assert.ok(pc.cardHeight('hidden') < pc.cardHeight('ready'));
  const css = readFileSync(path.join(activity, 'css', 'profilecard.css'), 'utf8');
  const px = (re) => Number((css.match(re) || [])[1]);
  assert.equal(px(/--pc-banner: (\d+)px/), pc.LAYOUT.banner);
  assert.equal(px(/--pc-stat: (\d+)px/), pc.LAYOUT.stat);
  assert.equal(px(/--pc-fav: (\d+)px/), pc.LAYOUT.fav);
  assert.equal(px(/--pc-badge: (\d+)px/), pc.LAYOUT.badge);
  assert.equal(px(/\.pcard-top \{[^}]*height: (\d+)px/), pc.LAYOUT.top);
  assert.equal(px(/\.pcard-foot \{[^}]*height: (\d+)px/) + 12, pc.LAYOUT.foot);
  assert.equal(px(/\.pcard-sub \{[^}]*min-height: (\d+)px/), pc.LAYOUT.sub);
  assert.equal(px(/\.pcard-facts \{[^}]*height: (\d+)px/), pc.LAYOUT.facts);
  assert.equal(px(/\.pcard-sec \{[^}]*grid-template-rows: (\d+)px/) + 6, pc.LAYOUT.sectionHead);
  assert.match(css, /\.pcard-name,[\s\S]*?white-space: nowrap;/, 'the name stays on one line');
  assert.match(css, /\.pcard-row \{[^}]*repeat\(5, minmax\(0, 1fr\)\)/, 'pinned badges sit in one row of five');
  assert.match(css, /\.pcard-bar \{[^}]*position: sticky;/, 'the close button stays put when a tiny frame scrolls');
});

test('the card shows the person look: banner picture, ring, name colour and font, pronouns and status', async () => {
  const { face, pc } = await setup({ respond: () => new Response(JSON.stringify({ profile: richCard() }), { status: 200 }) });
  tap(face);
  await flush();
  const banner = pc.el.querySelector('.pcard-banner');
  assert.ok(banner.classList.contains('banner-accent'), 'the accent shows while the picture loads or if it fails');
  const img = banner.querySelector('img');
  assert.equal(img.src, '/banner-img/b-devbanner9-78b2e29c0e52fea5.png');
  img.dispatchEvent(new FakeEvent('error'));
  assert.equal(banner.querySelector('img'), null);
  assert.ok(pc.el.querySelector('.pcard-avatar').classList.contains('ring-rainbow'));
  const name = pc.el.querySelector('.pcard-name');
  assert.equal(name.getAttribute('title'), 'bunny | Top #1 Kanna Glazer of the whole server');
  assert.ok(name.classList.contains('font-serif'));
  assert.equal(name.style.props['--pc-name'], '#e5487f');
  assert.equal(pc.el.querySelector('.pcard-view').style.props['--pc-ac'], '#e5487f');
  assert.match(text(pc.el), /@alice · she\/her · \[OWL\] Night Owls/);
  assert.match(text(pc.el), /🎮 Hosting game night/);
  assert.match(text(pc.el), /467K pts/);
  assert.equal(pc.el.querySelectorAll('.pcard-fav').length, 3);
  assert.equal(pc.el.querySelectorAll('.pcard-badge').length, 5);
  pc.close();
  const { cleanLook } = await import('../web/activity/js/ui/profilecard.js');
  const bad = cleanLook({ banner: 'image', bannerImage: 'https://evil.example/x.png', ring: 'spin', nameFont: 'comic', accent: { base: 'red' } });
  assert.equal(bad, null, 'unknown looks are dropped');
  assert.equal(cleanLook({ banner: 'image', bannerImage: '//evil.example/b.png', status: 'hi' }).banner, null);
  assert.equal(cleanLook({ banner: 'ocean' }).banner, 'ocean');
});

test('while loading, the skeleton keeps the same rows so nothing jumps when data arrives', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { face, pc } = await setup({ respond: async () => { await gate; return new Response(JSON.stringify({ profile: richCard() }), { status: 200 }); } });
  tap(face);
  const rows = () => ['.pcard-banner', '.pcard-top', '.pcard-name', '.pcard-sub', '.pcard-xp', '.pcard-stats', '.pcard-facts', '.pcard-favs', '.pcard-row', '.pcard-foot'].map((s) => Boolean(pc.el.querySelector(s)));
  assert.deepEqual(rows(), rows().map(() => true));
  assert.equal(pc.el.querySelector('.pcard-row').querySelectorAll('.pcard-bone').length, 5);
  assert.match(text(pc.el), /Loading profile/);
  release();
  await flush();
  await flush();
  assert.deepEqual(rows(), rows().map(() => true));
  assert.equal(pc.el.querySelector('.pcard-bone'), null);
  pc.close();
});

test('badges show their full name on tap or focus, and View all lists every badge inside the card', async () => {
  const { document, face, pc } = await setup({ respond: () => new Response(JSON.stringify({ profile: richCard() }), { status: 200 }) });
  face.focus();
  tap(face);
  await flush();
  const badges = pc.el.querySelectorAll('.pcard-badge');
  assert.equal(badges[1].getAttribute('aria-label'), 'Dev star: Only from Jolli (pinned)');
  assert.match(text(badges[1].querySelector('.pcard-tip')), /Dev star/);
  assert.equal(badges[1].querySelector('.pcard-tip').getAttribute('aria-hidden'), 'true');
  assert.equal(pc.el.querySelector('.pcard-badge-label'), null, 'no cut-off names under the icons');
  badges[1].click();
  assert.ok(badges[1].classList.contains('is-tip'));
  badges[2].click();
  assert.equal(badges[1].classList.contains('is-tip'), false);
  assert.ok(badges[2].classList.contains('is-tip'));
  badges[2].click();
  assert.equal(badges[2].classList.contains('is-tip'), false);
  const more = pc.el.querySelector('.pcard-more');
  assert.equal(more.getAttribute('aria-label'), 'View all 31 badges');
  more.click();
  const panel = pc.el.querySelector('.pcard');
  assert.equal(panel.getAttribute('aria-labelledby'), 'pcard-all-title');
  assert.equal(document.activeElement, pc.el.querySelector('.pcard-back'));
  const items = pc.el.querySelectorAll('.pcard-all-item');
  assert.equal(items.length, 7);
  const all = text(pc.el.querySelector('.pcard-all'));
  for (const name of ['Messages 10k', 'Dev star', 'First game', 'Party regular', 'YapOS tester', 'Winner', 'Night owl']) assert.match(all, new RegExp(name));
  assert.match(all, /Only from Jolli/);
  assert.match(all, /Played 10 games/);
  assert.match(text(items[0]), /Pinned · Achievement/);
  assert.match(text(pc.el), /24 more on their full profile/);
  key(document.activeElement, 'Escape');
  assert.equal(pc.isOpen, true, 'Esc first goes back to the profile');
  assert.equal(panel.getAttribute('aria-labelledby'), 'pcard-name');
  assert.equal(document.activeElement, pc.el.querySelector('.pcard-more'));
  pc.el.querySelector('.pcard-more').click();
  pc.el.querySelector('.pcard-back').click();
  assert.ok(pc.el.querySelector('.pcard-stats'));
  key(document.activeElement, 'Escape');
  assert.equal(pc.isOpen, false);
  assert.equal(document.activeElement, face);
});

async function linkSetup(open, execOk) {
  const s = await setup();
  s.win.open = open;
  s.win.navigator = { clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } };
  const copied = [];
  s.document.execCommand = (cmd) => {
    const box = s.pc.el.querySelector('.signin-copy-box');
    if (cmd === 'copy' && box && execOk) copied.push(box.value);
    return cmd === 'copy' && Boolean(box) && execOk;
  };
  tap(s.face);
  await flush();
  return { ...s, copied, btn: s.pc.el.querySelector('button.pcard-link'), line: () => s.pc.el.querySelector('.pcard-status-line').textContent };
}

test('View full profile opens the page when it can and copies the link when the call frame blocks it', async () => {
  const opened = [];
  const tab = { opener: 'me' };
  const a = await linkSetup((url, target) => { opened.push([url, target]); return tab; }, true);
  assert.equal(a.btn.textContent, 'View full profile');
  assert.equal(a.line(), 'yapos.dev/u/alice');
  a.btn.click();
  await flush();
  assert.deepEqual(opened, [['https://yapos.dev/u/alice', '_blank']]);
  assert.equal(tab.opener, null, 'the new tab cannot reach back into the call');
  assert.equal(a.line(), 'Opened in a new tab');
  assert.deepEqual(a.copied, []);
  a.pc.close();

  const b = await linkSetup(() => null, true);
  b.btn.click();
  await flush();
  assert.deepEqual(b.copied, ['https://yapos.dev/u/alice']);
  assert.equal(b.btn.textContent, 'Link copied');
  assert.ok(b.btn.classList.contains('is-copied'));
  assert.equal(b.line(), 'Paste it in your browser');
  assert.equal(b.pc.el.querySelector('.signin-copy-box'), null);
  b.pc.close();

  const c = await linkSetup(() => { throw new Error('blocked'); }, false);
  c.btn.click();
  await flush();
  assert.equal(c.line(), 'Copy this link: yapos.dev/u/alice');
  assert.ok(c.pc.el.querySelector('.pcard-status-line').classList.contains('is-select'));
  c.pc.close();

  const d = await setup({ respond: () => new Response(JSON.stringify({ profile: card({ page: false }) }), { status: 200 }) });
  tap(d.face);
  await flush();
  assert.equal(d.pc.el.querySelector('.pcard-link'), null, 'no button without a public profile');
  assert.match(text(d.pc.el), /No public profile page yet/);
  d.pc.close();

  const { profileUrl } = await import('../web/activity/js/ui/profilecard.js');
  assert.equal(profileUrl('a b'), 'https://yapos.dev/u/a%20b');
  assert.equal(profileUrl('pip', { hostname: 'localhost', protocol: 'http:', origin: 'http://localhost:8795' }), 'http://localhost:8795/u/pip');
  assert.equal(profileUrl('pip', { hostname: 'evil.example', protocol: 'https:', origin: 'https://evil.example' }), 'https://yapos.dev/u/pip');
});
