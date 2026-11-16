import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, FakeEvent, flush } from './dom-shim.js';

const TOKEN = 'Q'.repeat(43);

function text(node) {
  if (node.data !== undefined && !node.localName) return node.data;
  return (node.childNodes || []).map(text).join(' ');
}

function memoryStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

function tap(el) {
  el.dispatchEvent(new FakeEvent('pointerdown', { bubbles: true }));
  el.dispatchEvent(new FakeEvent('click', { bubbles: true }));
}

function headerOf(req) {
  const h = req && req.headers;
  if (!h) return null;
  if (typeof h.get === 'function') return h.get('Authorization');
  return h.Authorization || h.authorization || null;
}

async function boot({ token = null } = {}) {
  const { window } = installDom({ url: 'https://yapos.dev/activity/' });
  const { room } = await import('./activity-kit.test.js');
  const { saveToken } = await import('../web/activity/js/account.js');
  const { mountApp } = await import('../web/activity/js/ui/app.js');
  const r = room(2, { join: false });
  await r.clock.advance(500);
  const guest = r.engines[1];
  const meId = String(guest.snapshot().me);
  const hostId = String(r.engines[0].snapshot().me);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), auth: headerOf(init) });
    if (url === '/api/activity/me') {
      if (token && headerOf(init) === `Bearer ${token}`) return new Response(JSON.stringify({ user: { id: meId, username: 'guest', display_name: 'Guest' }, via: 'code' }), { status: 200 });
      return new Response('{"error":"signed_out"}', { status: 401 });
    }
    if (url === '/api/activity/link/start') return new Response(JSON.stringify({ code: 'K7QM-2XPA', token: 'P'.repeat(43), expires: Date.now() + 600000, ttl: 600000, interval: 2500 }), { status: 201 });
    if (String(url).startsWith('/api/activity/profile/')) return new Response(JSON.stringify({ profile: { hidden: false, name: 'Host', username: 'host', avatar: null, level: 2, xp: 120, progress: { into: 20, need: 155 }, badges: [], badgeCount: 0, achievements: [], clan: null, party: { games: 3, wins: 1, bestStreak: 1, favourites: [] }, rank: null, page: false } }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const store = memoryStore();
  const root = document.createElement('div');
  document.body.append(root);
  const win = Object.assign(window, { document, parent: {}, innerWidth: 400, innerHeight: 700, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, fetch: fetchImpl, localStorage: store });
  if (token) saveToken(win, meId, token);
  const bridge = { close() {}, dev: false };
  const app = mountApp({ root, engine: guest, bridge, win, juice: false, signin: { dev: false } });
  app.render(guest.snapshot());
  await flush(30);
  app.render(guest.snapshot());
  await flush(10);
  return { r, app, root, calls, meId, hostId, guest };
}

test('in a call, a signed out player sees the sign-in prompt and cannot join until they sign in', async () => {
  const { app, root, calls, guest } = await boot();
  const layer = root.querySelector('.signin-layer');
  assert.ok(layer, 'the gate is mounted');
  assert.equal(layer.hidden, false, 'the gate shows on its own');
  assert.equal(app.signin.isOpen, true);
  assert.equal(app.signin.state().status, 'out');
  assert.match(text(layer), /K7QM/);
  assert.ok(calls.some((c) => c.url === '/api/activity/link/start'));
  assert.equal(app.signin.require('join'), false);
  assert.equal(Boolean(guest.snapshot().meJoined), false);
  app.destroy();
});

test('a saved token whose /api/activity/me user matches the call id hides the gate, and tapping a face opens that profile', async () => {
  const { r, app, root, calls, hostId } = await boot({ token: TOKEN });
  const meCall = calls.find((c) => c.url === '/api/activity/me');
  assert.ok(meCall, 'the account was checked');
  assert.equal(meCall.auth, `Bearer ${TOKEN}`, 'the token goes in the bearer header');
  assert.equal(app.signin.state().status, 'in');
  assert.equal(root.querySelector('.signin-layer').hidden, true);
  assert.equal(app.signin.isOpen, false);
  assert.equal(app.signin.require('join'), true);
  const face = root.querySelectorAll(`[data-profile-id="${hostId}"]`).find((n) => n.getAttribute('data-pc') === 'on');
  assert.ok(face, 'the host face is clickable');
  const before = r.hub.ops.length;
  tap(face);
  await flush(20);
  assert.equal(app.profileCard.isOpen, true);
  assert.equal(app.profileCard.openId, hostId);
  assert.ok(calls.some((c) => c.url === `/api/activity/profile/${hostId}`));
  assert.equal(r.hub.ops.length, before, 'opening a profile sends nothing to the call');
  app.profileCard.close();
  assert.equal(app.profileCard.isOpen, false);
  app.destroy();
});
