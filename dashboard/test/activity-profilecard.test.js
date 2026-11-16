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
  assert.match(all, /900 points/);
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
