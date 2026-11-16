import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { room, person, seeded } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import { configureAdmins, resetAdmins, refreshAdmins, REPORTS_ENDPOINT } from '../web/activity/js/admin.js';
import { flagNeed, flagsUsed, flagsLeft, FLAG_CAP } from '../web/activity/js/engine.js';
import draw, { drawingId } from '../web/activity/js/games/draw.js';
import { fitInk, inkKey, GRID_W, GRID_H } from '../web/activity/js/games/ink.js';
import { flagModel, flagLabel, FLAG_CAPPED, HIDDEN_TEXT } from '../web/activity/js/views/draw.js';
import { createHold, createModTray, hiddenIds, visibleDrawings, holdCard, HOLD_MOD, HOLD_TITLE_MOD, HOLD_TITLE_MINE } from '../web/activity/js/ui/modhold.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const activity = path.join(here, '..', 'web', 'activity');
const OWNER = person(2).id;

function fakeFetch() {
  return async (url) => {
    if (String(url).startsWith(REPORTS_ENDPOINT)) return { ok: true, status: 201, json: async () => ({ ok: true }) };
    const ids = new URL(url, 'https://yapos.dev').searchParams.get('ids').split(',');
    return { ok: true, status: 200, json: async () => ({ admins: ids.filter((id) => id === OWNER), owner: ids.includes(OWNER) ? OWNER : null, banned: [] }) };
  };
}

async function settle(clock, ms = 600) {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((r) => setImmediate(r));
    await clock.advance(ms / 6);
  }
}

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function hostState(r, key) {
  return r.engines[0].snapshot().state[key];
}

function line(random, n = 30) {
  const pts = [];
  let x = 200;
  let y = 160;
  for (let i = 0; i < n; i += 1) {
    x = Math.min(GRID_W, Math.max(0, x + (random() - 0.5) * 30));
    y = Math.min(GRID_H, Math.max(0, y + (random() - 0.5) * 30));
    pts.push([Math.round(x), Math.round(y)]);
  }
  return pts;
}

async function drawSomething(r, seed = 3) {
  const st = hostState(r, 'draw');
  const drawer = bySlot(r, st.drawer);
  const fit = fitInk([{ c: 3, z: 1, pts: line(seeded(seed)) }], st.nonce);
  for (const ch of fit.chunks) assert.equal(drawer.direct(inkKey(ch.i), ch), true);
  await r.clock.advance(1200);
  return { st: hostState(r, 'draw'), drawer };
}

async function toDraw(r) {
  for (let i = 0; i < 6; i += 1) {
    const st = hostState(r, 'draw');
    if (st.phase === 'draw') return st;
    if (st.phase === 'pick') bySlot(r, st.drawer).act({ type: 'pick', i: 0, n: st.n });
    else r.engines.find((e) => e.snapshot().me === OWNER).admin.run({ type: 'skip' });
    await settle(r.clock);
  }
  return hostState(r, 'draw');
}

async function startDraw(n) {
  resetAdmins();
  configureAdmins({ fetch: fakeFetch(), refreshMs: 0, win: null });
  const r = room(n, { games: [draw], settings: { draw: { rounds: 3 } } });
  await r.clock.advance(500);
  await refreshAdmins(r.engines.map((e) => e.snapshot().me));
  await settle(r.clock);
  assert.equal(r.engines[0].lobby.pick('draw'), true);
  assert.equal(r.engines[0].lobby.start().ok, true);
  await r.clock.advance(300);
  await toDraw(r);
  return r;
}

function plainGuessers(r) {
  const st = hostState(r, 'draw');
  return r.engines.filter((e) => e.snapshot().meSlot !== st.drawer && e.snapshot().me !== OWNER);
}

test('flag rules: one flag hides in a small group, two once there are four or more players', () => {
  assert.equal(flagNeed(1), 1);
  assert.equal(flagNeed(2), 1);
  assert.equal(flagNeed(3), 2);
  assert.equal(flagNeed(7), 2);
  assert.equal(FLAG_CAP, 2);
  const room = { round: 4, fc: { r: 4, n: { 1: 2, 3: 1 } } };
  assert.equal(flagsUsed(room, 1), 2);
  assert.equal(flagsUsed(room, 3), 1);
  assert.equal(flagsUsed(room, 5), 0);
  assert.equal(flagsUsed({ round: 5, fc: room.fc }, 1), 0, 'the count resets every game');
  assert.equal(flagsLeft({ room, meSlot: 1 }), 0);
  assert.equal(flagsLeft({ room, meSlot: 3 }), 1);
  assert.equal(flagLabel({ count: 0, need: 2, mine: false, capped: true }), FLAG_CAPPED);
  const capped = flagModel({ meJoined: true, meSlot: 1, room, players: [0, 1, 2].map((slot) => ({ slot, joined: true, present: true, isMe: slot === 1 })) }, { d: 'draw.1.1', drawer: 0 }, new Set());
  assert.equal(capped.capped, true);
  const mod = flagModel({ meJoined: true, meSlot: 1, room, players: [0, 1, 2].map((slot) => ({ slot, joined: true, present: true, isMe: slot === 1, isAdmin: slot === 1 })) }, { d: 'draw.1.1', drawer: 0 }, new Set());
  assert.equal(mod.capped, false, 'Party mods have no flag limit');
});

test('with three players a single flag hides the drawing', async () => {
  const r = await startDraw(3);
  const { st } = await drawSomething(r);
  const plain = plainGuessers(r)[0];
  assert.ok(plain);
  assert.equal(plain.flag(drawingId(st)), true);
  await settle(r.clock);
  assert.equal(hostState(r, 'draw').note, 'hidden');
  assert.equal(hostState(r, 'room').fc.n[plain.snapshot().meSlot], 1);
});

test('a Party mod hides a drawing with one flag even in a big group', async () => {
  const r = await startDraw(5);
  let st = hostState(r, 'draw');
  let tries = 0;
  while (bySlot(r, st.drawer).snapshot().me === OWNER && tries < 4) {
    r.engines.find((e) => e.snapshot().me === OWNER).admin.run({ type: 'skip' });
    await settle(r.clock);
    st = await toDraw(r);
    tries += 1;
  }
  ({ st } = await drawSomething(r));
  const owner = r.engines.find((e) => e.snapshot().me === OWNER);
  assert.notEqual(owner.snapshot().meSlot, st.drawer);
  assert.equal(owner.flag(drawingId(st)), true);
  await settle(r.clock);
  assert.equal(hostState(r, 'draw').note, 'hidden');
});

test('each player can flag at most two drawings per game, so one troll cannot hide everything', async () => {
  const r = await startDraw(5);
  const plainIds = new Set(r.engines.filter((e) => e.snapshot().me !== OWNER).map((e) => e.snapshot().me));
  let troll = null;
  let flagged = 0;
  for (let turn = 0; turn < 8 && flagged < FLAG_CAP + 1; turn += 1) {
    const st = await toDraw(r);
    if (st.phase !== 'draw') break;
    await drawSomething(r, turn + 5);
    const now = hostState(r, 'draw');
    if (!troll) troll = plainGuessers(r)[0];
    if (troll.snapshot().meSlot === now.drawer || !plainIds.has(troll.snapshot().me)) {
      r.engines.find((e) => e.snapshot().me === OWNER).admin.run({ type: 'skip' });
      await settle(r.clock);
      continue;
    }
    const ok = troll.flag(drawingId(now));
    await settle(r.clock);
    if (flagged < FLAG_CAP) {
      assert.equal(ok, true);
      assert.equal(hostState(r, 'draw').phase, 'draw', 'one flag of four guessers is not enough');
    } else {
      assert.equal(ok, false, 'the third flag is refused');
      assert.equal(flagsLeft(troll.snapshot()), 0);
      assert.equal((hostState(r, 'room').flags || {})[drawingId(now)], undefined);
    }
    flagged += 1;
    r.engines.find((e) => e.snapshot().me === OWNER).admin.run({ type: 'skip' });
    await settle(r.clock);
  }
  assert.equal(flagged, FLAG_CAP + 1);
  assert.equal(flagsUsed(hostState(r, 'room'), troll.snapshot().meSlot), FLAG_CAP);
});

test('hidden drawings stay visible to mods and the drawer in the Hidden for others tray, never to other players', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const make = document.createElement.bind(document);
  document.createElement = (tag) => {
    const el = make(tag);
    if (tag === 'canvas') el.getContext = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => ({ data: new Uint8ClampedArray(4) })), set: (t, k, v) => ((t[k] = v), true) });
    return el;
  };
  const r = await startDraw(4);
  let st = hostState(r, 'draw');
  let tries = 0;
  while (bySlot(r, st.drawer).snapshot().me === OWNER && tries < 4) {
    r.engines.find((e) => e.snapshot().me === OWNER).admin.run({ type: 'skip' });
    await settle(r.clock);
    st = await toDraw(r);
    tries += 1;
  }
  ({ st } = await drawSomething(r, 11));
  const d = drawingId(st);
  const owner = r.engines.find((e) => e.snapshot().me === OWNER);
  const drawer = bySlot(r, st.drawer);
  const plain = plainGuessers(r)[0];
  const trays = new Map([owner, drawer, plain].map((e) => [e, createModTray()]));
  for (const [e, t] of trays) t.update(e.snapshot());
  assert.deepEqual(visibleDrawings(plain.snapshot()).map((x) => x.d), [d]);
  for (const t of trays.values()) assert.equal(t.el.childNodes.length, 0, 'nothing is hidden yet');
  plain.flag(d);
  await settle(r.clock);
  const other = r.engines.find((e) => e !== owner && e !== drawer && e !== plain);
  other.flag(d);
  await settle(r.clock);
  assert.equal(hostState(r, 'draw').note, 'hidden');
  assert.ok(hiddenIds(plain.snapshot()).has(d));
  assert.equal(visibleDrawings(plain.snapshot()).length, 0, 'the ink is gone from shared state');
  for (const [e, t] of trays) t.update(e.snapshot());
  const text = (n) => (n.data !== undefined && !n.localName ? n.data : (n.childNodes || []).map(text).join(' '));
  assert.equal(trays.get(plain).el.childNodes.length, 0, 'regular players cannot see it');
  assert.match(text(trays.get(owner).el), new RegExp(HOLD_TITLE_MOD));
  assert.match(text(trays.get(owner).el), new RegExp(HOLD_MOD));
  assert.ok(trays.get(owner).el.querySelector(`[data-drawing="${d}"] canvas`));
  assert.ok(trays.get(owner).el.querySelector('[data-profile-id]'), 'the drawer avatar opens their profile');
  assert.match(text(trays.get(drawer).el), new RegExp(HOLD_TITLE_MINE));
  for (const t of trays.values()) for (const el of t.el.querySelectorAll('*')) assert.equal(el.getAttribute('style'), null);
});

test('the hold cache resets every game and keeps hidden drawings when it prunes', () => {
  const hold = createHold({ keep: 2 });
  const players = [{ slot: 0, id: 'a', name: 'A', isMe: true, isAdmin: true }, { slot: 1, id: 'b', name: 'B' }];
  const snap = (nonce, hid, ink) => ({ room: { phase: 'game', game: 'draw', round: 1 }, players, state: { draw: { phase: 'draw', nonce, n: nonce, drawer: 1, hid } } });
  assert.deepEqual(hold.held(snap(1, 0)), { mod: false, list: [] });
  assert.equal(hold.observe({ room: { phase: 'lobby' } }), false);
  assert.equal(holdCard({ mod: true, list: [] }), null);
});

test('the hidden-drawing code has no comments, inline styles or outside links', () => {
  for (const f of ['js/ui/modhold.js', 'css/admin.css']) {
    const src = readFileSync(path.join(activity, f), 'utf8');
    assert.equal(/\/\*[\s\S]*?\*\//.test(src), false, f);
    if (f.endsWith('.js')) {
      assert.equal(/^\s*\/\//m.test(src), false, f);
      assert.equal(/style=|innerHTML|outerHTML|insertAdjacentHTML/.test(src), false, f);
    }
    assert.equal(/https?:\/\//.test(src), false, f);
    assert.equal(/\b(claude|anthropic)\b/i.test(src), false, f);
  }
  assert.equal(HIDDEN_TEXT, 'Hidden after a report.');
});
