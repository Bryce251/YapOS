import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { room, person, seeded } from './activity-kit.test.js';
import { installDom, FakeEvent } from './dom-shim.js';
import {
  configureAdmins,
  resetAdmins,
  refreshAdmins,
  isBanned,
  bannedIds,
  sendReport,
  reportBody,
  reportInk,
  wasReported,
  REPORTS_ENDPOINT,
  REPORT_STROKES,
  REPORT_INK_CHARS,
} from '../web/activity/js/admin.js';
import { cleanAdminAction, flagNeed, flagInfo, validDrawing } from '../web/activity/js/engine.js';
import draw, { drawingId, inkStrings, mask } from '../web/activity/js/games/draw.js';
import odd, { KEY as ODD, fitStroke as oddStroke, authors, splitLines, rawInk } from '../web/activity/js/games/odd.js';
import telephone, { KEY as TEL, inkKey as telInk, entryKey, chainAt, drawingId as telId, validInk } from '../web/activity/js/games/telephone.js';
import { fitInk, inkKey, encodeStroke, encodeParts, decodeStroke, GRID_W, GRID_H } from '../web/activity/js/games/ink.js';
import { flagLabel, flagModel } from '../web/activity/js/views/draw.js';
import { VIEWS } from '../web/activity/js/views/index.js';
import { createAdminPanel, adminModel } from '../web/activity/js/ui/admin-panel.js';
import { spectateModel, partyBanned, PARTY_BANNED_TEXT } from '../web/activity/js/ui/app.js';
import { jsonBytes, MAX_VALUE_BYTES } from '../web/activity/js/limits.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const activity = path.join(here, '..', 'web', 'activity');
const OWNER = person(2).id;

function fakeFetch(log, opts = {}) {
  return async (url, init = {}) => {
    log.push({ url, init });
    if (opts.fail) throw new Error('offline');
    if (String(url).startsWith(REPORTS_ENDPOINT)) return { ok: true, status: 201, json: async () => ({ ok: true }) };
    const ids = new URL(url, 'https://yapos.dev').searchParams.get('ids').split(',');
    const banned = typeof opts.banned === 'function' ? opts.banned() : opts.banned || [];
    return {
      ok: true,
      status: 200,
      json: async () => ({ admins: ids.filter((id) => id === OWNER), owner: ids.includes(OWNER) ? OWNER : null, banned: ids.filter((id) => banned.includes(id)) }),
    };
  };
}

function setAdmins(log, opts) {
  resetAdmins();
  configureAdmins({ fetch: fakeFetch(log, opts), refreshMs: 0, win: null });
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

function line(random, n = 40, x0 = 120, y0 = 120) {
  const pts = [];
  let x = x0;
  let y = y0;
  for (let i = 0; i < n; i += 1) {
    x = Math.min(GRID_W, Math.max(0, x + (random() - 0.5) * 30));
    y = Math.min(GRID_H, Math.max(0, y + (random() - 0.5) * 30));
    pts.push([Math.round(x), Math.round(y)]);
  }
  return pts;
}

async function startDraw(n = 4) {
  const log = [];
  setAdmins(log);
  const r = room(n);
  await r.clock.advance(500);
  await refreshAdmins(r.engines.map((e) => e.snapshot().me));
  await settle(r.clock);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('draw'), true);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  let st = hostState(r, 'draw');
  bySlot(r, st.drawer).act({ type: 'pick', i: 0, n: st.n });
  await r.clock.advance(400);
  st = hostState(r, 'draw');
  assert.equal(st.phase, 'draw');
  const drawer = bySlot(r, st.drawer);
  const fit = fitInk([{ c: 3, z: 1, pts: line(seeded(3)) }, { c: 5, z: 2, pts: line(seeded(4), 30, 300, 200) }], st.nonce);
  for (const ch of fit.chunks) assert.equal(drawer.direct(inkKey(ch.i), ch), true);
  await r.clock.advance(1200);
  const guessers = r.engines.filter((e) => e !== drawer).sort((a, b) => (a.snapshot().me === OWNER ? 1 : 0) - (b.snapshot().me === OWNER ? 1 : 0));
  return { r, log, st: hostState(r, 'draw'), drawer, guessers };
}

function inkKeys(r) {
  return Object.keys(r.hub.state).filter((k) => k.startsWith('ink.'));
}

test('flag helpers: one flag in a group of 2 or 3, two flags once there are 4 or more players', () => {
  assert.equal(flagNeed(0), 1);
  assert.equal(flagNeed(1), 1);
  assert.equal(flagNeed(2), 1);
  assert.equal(flagNeed(3), 2);
  assert.equal(flagNeed(4), 2);
  assert.equal(flagNeed(9), 2);
  assert.equal(validDrawing('draw.12.3'), true);
  assert.equal(validDrawing('bad id'), false);
  assert.equal(validDrawing('x'.repeat(49)), false);
  assert.deepEqual(cleanAdminAction({ type: 'clearDrawing' }), { type: 'clearDrawing' });
  assert.deepEqual(cleanAdminAction({ type: 'clearDrawing', d: 'odd.4.1' }), { type: 'clearDrawing', d: 'odd.4.1' });
  assert.deepEqual(cleanAdminAction({ type: 'clearDrawing', d: '<b>' }), { type: 'clearDrawing' });
  assert.equal(flagLabel({ count: 0, need: 2, mine: false }), 'Flag');
  assert.equal(flagLabel({ count: 1, need: 3, mine: false }), 'Flag (1 of 3)');
  assert.equal(flagLabel({ count: 2, need: 3, mine: true }), 'Flagged (2 of 3)');
});

test('Draw & Guess: half the guessers flag it, the ink is wiped, the turn ends and the drawer scores nothing', async () => {
  const { r, st, drawer, guessers } = await startDraw(4);
  const d = drawingId(st);
  assert.ok(inkKeys(r).length > 0);
  const word = draw.drawingOf(guessers[2].snapshot()).word;
  guessers[2].act({ type: 'guess', text: word });
  await r.clock.advance(400);
  const drawerSlot = st.drawer;
  const before = r.engines[0].snapshot().scores.g[drawerSlot] || 0;
  assert.ok(before > 0, 'the drawer earned points from the right guess');
  const winner = guessers[2].snapshot().meSlot;
  const winnerPts = r.engines[0].snapshot().scores.g[winner];
  assert.ok(winnerPts > 0);

  assert.equal(drawer.flag(d), true);
  await r.clock.advance(400);
  assert.ok(!hostState(r, 'room').flags, 'the drawer cannot flag their own drawing');

  assert.equal(guessers[0].flag(d), true);
  await r.clock.advance(400);
  assert.equal(hostState(r, 'room').flags[d].length, 1);
  const info = flagInfo(guessers[1].snapshot(), d, drawerSlot);
  assert.deepEqual(info, { count: 1, need: 2, mine: false });
  assert.equal(flagInfo(guessers[0].snapshot(), d, drawerSlot).mine, true);
  guessers[0].flag(d);
  await r.clock.advance(400);
  assert.equal(hostState(r, 'room').flags[d].length, 1, 'one flag per person');
  assert.equal(hostState(r, 'draw').phase, 'draw');

  guessers[1].flag(d);
  await r.clock.advance(400);
  const after = hostState(r, 'draw');
  assert.equal(after.phase, 'reveal');
  assert.equal(after.note, 'hidden');
  assert.equal(after.hid, 1);
  assert.equal(inkKeys(r).length, 0, 'the ink is gone for everyone');
  assert.equal(r.engines[0].snapshot().scores.g[drawerSlot] || 0, 0);
  assert.equal(after.gained[drawerSlot], 0);
  assert.equal(r.engines[0].snapshot().scores.g[winner], winnerPts, 'guessers keep their points');
  const m = draw.model(guessers[0].snapshot());
  assert.equal(m.hidden, true);
  assert.equal(m.drawerGain, 0);
  assert.equal(draw.drawingOf(guessers[0].snapshot()), null);
  const fit = fitInk([{ c: 3, z: 1, pts: line(seeded(9)) }], st.nonce);
  assert.equal(drawer.direct(inkKey(0), fit.chunks[0]), false, 'the drawer cannot put the ink back');
});

test('a player leaving can push the flags over the line', async () => {
  const { r, st, guessers } = await startDraw(4);
  const d = drawingId(st);
  guessers[0].flag(d);
  await r.clock.advance(400);
  assert.equal(hostState(r, 'draw').phase, 'draw');
  const host = r.engines[0];
  const leaver = guessers.find((e) => e !== host && e !== guessers[0]);
  r.hub.leave(leaver.snapshot().me);
  await r.clock.advance(600);
  assert.equal(hostState(r, 'draw').note, 'hidden');
});

test('admins can clear the drawing right away, other players cannot', async () => {
  const { r, st, drawer } = await startDraw(3);
  const owner = r.engines.find((e) => e.snapshot().me === OWNER);
  const plain = r.engines.find((e) => e.snapshot().me !== OWNER && e !== r.engines[0]);
  assert.equal(plain.admin.run({ type: 'clearDrawing' }), false);
  plain.broadcast({ t: 'adm', a: { type: 'clearDrawing' } });
  await settle(r.clock);
  assert.equal(hostState(r, 'draw').phase, 'draw');
  assert.equal(owner.admin.run({ type: 'clearDrawing', d: drawingId(st) }), true);
  await settle(r.clock);
  const after = hostState(r, 'draw');
  assert.equal(after.phase, 'reveal');
  assert.equal(after.note, 'hidden');
  assert.equal(inkKeys(r).length, 0);
  assert.ok(drawer);
});

test('Odd One Out: flagging the latest line hides every line by that player and skips their turns', async () => {
  const log = [];
  setAdmins(log);
  const r = room(4, { games: [odd], seed: 5 });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('odd'), true);
  assert.equal(host.lobby.setting('laps', 3), true);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  const random = seeded(21);
  const st0 = () => hostState(r, ODD);
  await r.clock.advance(8000);
  for (let i = 0; i < 5; i += 1) {
    const s = st0();
    assert.equal(s.phase, 'draw');
    const parts = oddStroke(line(random, 30, 60 + i * 40, 80 + i * 30), 1, 1, s.cap);
    bySlot(r, s.turn).act({ type: 'stroke', n: s.n, s: parts });
    await r.clock.advance(400);
  }
  let s = st0();
  assert.equal(s.lens.length, s.marks.length);
  const list = authors(s);
  const target = list[list.length - 1];
  const viewer = r.engines.find((e) => e.snapshot().meSlot !== target);
  const item = odd.drawingOf(viewer.snapshot());
  assert.equal(item.drawer, target);
  const raw = rawInk(r.hub.state, s.k);
  const split = splitLines(raw, s, target);
  assert.ok(split.mine.length > 0);
  assert.deepEqual(item.ink, split.mine);
  const others = r.engines.filter((e) => e.snapshot().meSlot !== target);
  others[0].flag(item.d);
  await r.clock.advance(400);
  assert.deepEqual(st0().hid, []);
  others[1].flag(item.d);
  await r.clock.advance(400);
  s = st0();
  assert.deepEqual(s.hid, [target]);
  assert.equal(s.marks.includes(target), false);
  assert.deepEqual(rawInk(r.hub.state, s.k), split.rest);
  const seat = odd.model(viewer.snapshot()).seats.find((x) => x.slot === target);
  assert.equal(seat.hidden, true);
  assert.equal(seat.lines, 0);
  let guard = 0;
  while (st0().phase === 'draw' && guard < 30) {
    const now = st0();
    assert.notEqual(now.turn, target, 'the flagged player sits out');
    const parts = oddStroke(line(random, 20), 1, 1, now.cap);
    bySlot(r, now.turn).act({ type: 'stroke', n: now.n, s: parts });
    await r.clock.advance(400);
    guard += 1;
  }
  assert.equal(st0().phase, 'vote');
  for (const [k, v] of Object.entries(r.hub.state)) assert.ok(jsonBytes(v) <= MAX_VALUE_BYTES, k);
});

async function startTel(count = 3) {
  const log = [];
  setAdmins(log);
  const r = room(count, { games: [telephone] });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('telephone'), true);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(400);
  const st = () => hostState(r, TEL);
  const write = async (texts) => {
    const s = st();
    s.seats.forEach((slot, seat) => bySlot(r, slot).act({ type: 'text', step: s.step, text: texts[seat] }));
    await r.clock.advance(500);
  };
  await write(['A whale juggling pancakes', 'A robot baking bread', 'A cat on a skateboard', 'A dog flying a kite'].slice(0, count));
  let s = st();
  assert.equal(s.phase, 'draw');
  s.seats.forEach((slot, seat) => {
    const parts = encodeParts({ c: 3, z: 1, pts: line(seeded(seat + 2)) });
    assert.equal(bySlot(r, slot).direct(telInk(seat), { k: s.k, s: parts }), true);
  });
  await r.clock.advance(400);
  s.seats.forEach((slot) => bySlot(r, slot).act({ type: 'done', step: s.step }));
  await r.clock.advance(3000);
  s = st();
  assert.equal(s.phase, 'text');
  return { r, st, write, log };
}

test('Draw Telephone: a flagged drawing turns into a Hidden page for the describer and the reveal', async () => {
  const { r, st, write } = await startTel();
  let s = st();
  const n = s.seats.length;
  const viewer = bySlot(r, s.seats[1]);
  const item = telephone.drawingOf(viewer.snapshot());
  assert.equal(item.drawer, s.seats[0]);
  assert.equal(item.d, telId(s.run, chainAt(0, 1, n), 1));
  assert.ok(item.ink.length > 0);
  assert.equal(telephone.model(viewer.snapshot()).src.hidden, false);
  assert.equal(viewer.flag(item.d), true);
  await r.clock.advance(400);
  s = st();
  assert.deepEqual(s.hid, [item.d]);
  assert.equal(r.hub.state[telInk(0)], undefined, 'the drawing is gone from state');
  const src = telephone.model(viewer.snapshot()).src;
  assert.equal(src.hidden, true);
  assert.equal(src.blank, true);
  assert.equal(telephone.drawingOf(viewer.snapshot()), null);
  assert.ok(validInk(r.hub.state[telInk(1)], s.dk), 'the other drawings stay');
  await write(['Fish flipping waffles', 'A toaster with arms', 'Mystery blob']);
  let found = null;
  for (let guard = 0; guard < 20 && !found; guard += 1) {
    s = st();
    if (s.phase !== 'reveal') break;
    for (const [k, v] of Object.entries(r.hub.state)) if (k.startsWith('tel.e.') && v.c === chainAt(0, 1, n) && v.i === 1) found = v;
    if (!found) await r.clock.advance(13000);
  }
  assert.ok(found, 'the reveal reached the hidden drawing');
  assert.equal(found.hid, 1);
  assert.deepEqual(found.s, []);
  const entry = telephone.model(viewer.snapshot()).reveal.entries.find((e) => e.i === 1);
  assert.equal(entry.hidden, true);
});

test('a player who steps out cannot flag, and stepping out re-checks the line', async () => {
  const { r, st, guessers } = await startDraw(4);
  const d = drawingId(st);
  const host = r.engines[0];
  const others = guessers.filter((e) => e !== host);
  others[0].flag(d);
  await r.clock.advance(400);
  assert.equal(hostState(r, 'room').flags[d].length, 1);
  others[1].leave();
  await r.clock.advance(400);
  assert.equal(others[1].flag(d), false);
  others[1].broadcast({ t: 'flag', g: 'draw', d });
  await r.clock.advance(400);
  assert.equal(hostState(r, 'draw').note, 'hidden', 'two guessers left, so one flag is enough');
  assert.deepEqual(hostState(r, 'room').flags[d], [others[0].snapshot().meSlot]);
});

test('Draw Telephone: while describing, only the one person who sees a drawing can flag it, and that is enough', async () => {
  const { r, st } = await startTel(4);
  let s = st();
  const n = s.seats.length;
  assert.equal(n, 4);
  const viewer = bySlot(r, s.seats[1]);
  const item = telephone.drawingOf(viewer.snapshot());
  assert.deepEqual(item.viewers, [s.seats[1]]);
  const outsider = bySlot(r, s.seats[3]);
  outsider.broadcast({ t: 'flag', g: 'telephone', d: item.d });
  await r.clock.advance(400);
  assert.ok(!(hostState(r, 'room').flags || {})[item.d], 'someone who cannot see it cannot flag it');
  assert.deepEqual(flagInfo(viewer.snapshot(), item.d, item.drawer, item.viewers), { count: 0, need: 1, mine: false });
  assert.equal(viewer.flag(item.d), true);
  await r.clock.advance(400);
  s = st();
  assert.deepEqual(s.hid, [item.d]);
  assert.equal(telephone.model(viewer.snapshot()).src.hidden, true);
});

test('Draw Telephone: admins can clear a drawing during the reveal', async () => {
  const { r, st, write } = await startTel();
  await refreshAdmins(r.engines.map((e) => e.snapshot().me));
  await settle(r.clock);
  await write(['Fish flipping waffles', 'A toaster with arms', 'Mystery blob']);
  let s = st();
  assert.equal(s.phase, 'reveal');
  await r.clock.advance(9500);
  s = st();
  assert.equal(s.rv.at, 1);
  const owner = r.engines.find((e) => e.snapshot().me === OWNER);
  const item = telephone.drawingOf(owner.snapshot());
  assert.ok(item);
  assert.equal(owner.admin.run({ type: 'clearDrawing', d: item.d }), true);
  await settle(r.clock);
  const e = r.hub.state[entryKey(1)];
  assert.equal(e.hid, 1);
  assert.deepEqual(e.s, []);
  assert.equal(telephone.drawingOf(owner.snapshot()), null);
});

test('party bans come from the admins endpoint and a failed check means not banned', async () => {
  const log = [];
  const banned = person(3).id;
  setAdmins(log, { banned: [banned] });
  await refreshAdmins([person(1).id, banned]);
  assert.equal(isBanned(banned), true);
  assert.equal(isBanned(person(1).id), false);
  assert.deepEqual(bannedIds(), [banned]);
  setAdmins(log, { fail: true });
  await refreshAdmins([banned]);
  assert.equal(isBanned(banned), false);
});

test('a Party-banned player cannot join, sees why, and can still watch', async () => {
  const log = [];
  const bad = person(3).id;
  let list = [bad];
  setAdmins(log, { banned: () => list });
  const r = room(3, { join: false });
  await r.clock.advance(500);
  await refreshAdmins(r.engines.map((e) => e.snapshot().me));
  await settle(r.clock);
  const [host, two, three] = r.engines;
  assert.equal(three.snapshot().admin.partyBanned, true);
  assert.equal(two.snapshot().admin.partyBanned, false);
  assert.equal(three.join(), false);
  three.broadcast({ t: 'in' });
  host.join();
  two.join();
  await r.clock.advance(800);
  assert.equal(three.snapshot().meJoined, false);
  assert.equal(two.snapshot().meJoined, true);
  assert.equal(partyBanned(three.snapshot()), true);
  assert.equal(PARTY_BANNED_TEXT, "You can't join YapOS Party games right now.");
  assert.equal(host.lobby.pick('wyr'), true);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(400);
  assert.deepEqual(spectateModel(three.snapshot()), { meJoined: false, joining: null, banned: true });
  list = [bad, two.snapshot().me];
  await refreshAdmins([two.snapshot().me], { force: true });
  await settle(r.clock);
  assert.equal(two.snapshot().meJoined, false, 'a new ban moves a playing person to watching');
});

test('reports carry the drawing, the drawer and the reporter, cleaned and capped, once per drawing', async () => {
  const log = [];
  setAdmins(log);
  const s = encodeStroke({ c: 3, z: 1, pts: line(seeded(2), 30) });
  const ink = Array.from({ length: REPORT_STROKES + 30 }, () => s);
  const body = reportBody({ game: 'draw', drawer: { id: person(1).id, name: '  Kid\u0000 ', username: '@kid' }, reporter: { id: person(2).id, name: 'Rep' }, ink: ink.concat(['<bad>']), word: 'cat', at: 5 });
  assert.equal(body.drawer.name, 'Kid');
  assert.equal(body.drawer.username, 'kid');
  assert.ok(body.ink.length <= REPORT_STROKES);
  assert.ok(body.ink.join('').length <= REPORT_INK_CHARS);
  assert.equal(reportInk(['<bad>', s]).length, 1);
  const busy = [];
  for (let i = 0; i < 150; i += 1) busy.push(encodeStroke({ c: 1 + (i % 9), z: 1, pts: line(seeded(i + 40), 120) }));
  assert.ok(busy.join('').length > REPORT_INK_CHARS);
  const fitted = reportInk(busy);
  assert.equal(fitted.length, busy.length, 'a big page is simplified to fit the report, not chopped off');
  assert.ok(fitted.join('').length <= REPORT_INK_CHARS);
  assert.deepEqual(decodeStroke(fitted[fitted.length - 1]).pts.at(-1), decodeStroke(busy[busy.length - 1]).pts.at(-1));
  assert.equal(reportBody({ game: 'chain', drawer: { id: person(1).id }, reporter: { id: person(2).id } }), null);
  assert.equal(reportBody({ game: 'draw', drawer: { id: 'nope nope' }, reporter: { id: person(2).id } }), null);
  assert.equal(reportBody({ game: 'draw', drawer: { id: person(2).id }, reporter: { id: person(2).id } }), null);
  assert.equal(await sendReport('draw.1.1', { game: 'draw', drawer: { id: person(1).id, name: 'Kid', username: null }, reporter: { id: person(2).id, name: 'Rep' }, ink: [s], word: null, at: 9 }), true);
  assert.equal(wasReported('draw.1.1'), true);
  assert.equal(await sendReport('draw.1.1', { game: 'draw', drawer: { id: person(1).id, name: 'Kid' }, reporter: { id: person(2).id, name: 'Rep' }, ink: [s] }), false);
  assert.equal(log.length, 1);
  assert.equal(log[0].url, REPORTS_ENDPOINT);
  assert.equal(log[0].init.method, 'POST');
  const sent = JSON.parse(log[0].init.body);
  assert.deepEqual(sent, { game: 'draw', drawer: { id: person(1).id, name: 'Kid', username: null }, reporter: { id: person(2).id, name: 'Rep' }, ink: [s], word: null, at: 9 });
  assert.ok(jsonBytes(sent) < 20000);
});

function all(node, out = []) {
  for (const c of node.childNodes || []) {
    if (c.localName) out.push(c);
    all(c, out);
  }
  return out;
}

function text(node) {
  if (node.data !== undefined && !node.localName) return node.data;
  return (node.childNodes || []).map(text).join(' ');
}

function byKey(root, key) {
  return all(root).find((el) => el.dataset && el.dataset.key === key) || null;
}

function noInlineStyle(root) {
  for (const el of all(root)) assert.equal(el.getAttribute('style'), null, `${el.localName} has a style attribute`);
}

function canvasDom() {
  installDom({ url: 'https://yapos.dev/activity/' });
  const make = document.createElement.bind(document);
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => ({ data: new Uint8ClampedArray(4) })), set: (t, k, v) => ((t[k] = v), true) });
  document.createElement = (tag) => {
    const el = make(tag);
    if (tag === 'canvas') el.getContext = () => ctx;
    return el;
  };
}

test('the draw view shows a Flag button to guessers, sends one report and shows progress', async () => {
  canvasDom();
  const { r, log, st, drawer, guessers } = await startDraw(4);
  const win = { setTimeout: r.clock.setTimeout, clearTimeout: r.clock.clearTimeout, setInterval: () => 0, clearInterval() {} };
  const toasts = [];
  const guestView = VIEWS.draw({ engine: guessers[0], fx: { confetti() {} }, toast: (t) => toasts.push(t), win });
  const drawerView = VIEWS.draw({ engine: drawer, fx: { confetti() {} }, toast() {}, win });
  guestView.update(guessers[0].snapshot());
  drawerView.update(drawer.snapshot());
  assert.equal(byKey(drawerView.el, 'flag'), null, 'the drawer has no flag button');
  const btn = byKey(guestView.el, 'flag');
  assert.ok(btn);
  assert.match(text(btn), /Flag/);
  btn.dispatchEvent(new FakeEvent('click', { bubbles: true }));
  await r.clock.advance(400);
  await new Promise((res) => setImmediate(res));
  guestView.update(guessers[0].snapshot());
  const reports = log.filter((x) => x.url === REPORTS_ENDPOINT);
  assert.equal(reports.length, 1);
  const body = JSON.parse(reports[0].init.body);
  assert.equal(body.game, 'draw');
  assert.equal(body.drawer.id, drawer.snapshot().me);
  assert.equal(body.reporter.id, guessers[0].snapshot().me);
  assert.deepEqual(body.ink, inkStrings(r.hub.state, st.nonce));
  assert.ok(body.ink.length > 0);
  const after = byKey(guestView.el, 'flag');
  assert.match(text(after), /Flagged \(1 of 2\)/);
  assert.equal(after.disabled, true);
  assert.ok(toasts.some((t) => /flagging/i.test(t)));
  const other = VIEWS.draw({ engine: guessers[1], fx: { confetti() {} }, toast() {}, win });
  other.update(guessers[1].snapshot());
  assert.match(text(byKey(other.el, 'flag')), /Flag \(1 of 2\)/);
  byKey(other.el, 'flag').dispatchEvent(new FakeEvent('click', { bubbles: true }));
  await r.clock.advance(400);
  guestView.update(guessers[0].snapshot());
  drawerView.update(drawer.snapshot());
  assert.equal(byKey(guestView.el, 'flag'), null);
  assert.match(text(guestView.el), /Hidden after a report/);
  noInlineStyle(guestView.el);
  noInlineStyle(drawerView.el);
  guestView.destroy();
  drawerView.destroy();
  other.destroy();
});

test('the odd and telephone views show the Flag button under the drawing', async () => {
  canvasDom();
  const { r, st } = await startTel();
  const s = st();
  const viewer = bySlot(r, s.seats[1]);
  const win = { setTimeout: r.clock.setTimeout, clearTimeout: r.clock.clearTimeout, setInterval: () => 0, clearInterval() {}, addEventListener() {}, removeEventListener() {} };
  const v = VIEWS.telephone({ engine: viewer, fx: { confetti() {} }, toast() {}, win });
  v.update(viewer.snapshot());
  const btn = byKey(v.el, 'flag');
  assert.ok(btn);
  btn.dispatchEvent(new FakeEvent('click', { bubbles: true }));
  await r.clock.advance(400);
  v.update(viewer.snapshot());
  assert.equal(byKey(v.el, 'flag'), null);
  assert.match(text(v.el), /Hidden after a report/);
  noInlineStyle(v.el);
  v.destroy();
  const f = flagModel({ meJoined: true, meSlot: 1, room: { flags: { 'odd.3.2': [1] } }, players: [0, 1, 2, 3].map((slot) => ({ slot, joined: true, present: true })) }, { d: 'odd.3.2', drawer: 2 }, new Set());
  assert.deepEqual(f, { d: 'odd.3.2', count: 1, need: 2, mine: true, capped: false });
});

test('the admin panel Game tab has a Clear drawing button that targets what is on screen', async () => {
  canvasDom();
  const { r, st } = await startDraw(3);
  const owner = r.engines.find((e) => e.snapshot().me === OWNER);
  const toasts = [];
  const panel = createAdminPanel({ engine: owner, toast: (t) => toasts.push(t), win: { document, addEventListener() {}, removeEventListener() {} }, sfx: { play() {} } });
  assert.equal(panel.open(), true);
  const m = adminModel(owner.snapshot(), {});
  assert.equal(m.drawing, drawingId(st));
  const btn = byKey(panel.el, 'adm-clear-drawing');
  assert.ok(btn);
  assert.equal(btn.disabled, false);
  btn.dispatchEvent(new FakeEvent('click', { bubbles: true }));
  await settle(r.clock);
  assert.equal(hostState(r, 'draw').note, 'hidden');
  assert.ok(toasts.includes('Drawing cleared for everyone.'));
  panel.update(owner.snapshot());
  assert.equal(byKey(panel.el, 'adm-clear-drawing').disabled, true);
  noInlineStyle(panel.el);
  panel.destroy();
});

test('the moderation code has no comments, inline styles or outside links', () => {
  const files = ['js/engine.js', 'js/admin.js', 'js/games/draw.js', 'js/games/odd.js', 'js/games/telephone.js', 'js/views/draw.js', 'js/views/odd.js', 'js/views/telephone.js', 'js/ui/admin-panel.js', 'js/ui/app.js', 'css/games.css', 'css/odd.css', 'css/telephone.css'];
  for (const f of files) {
    const src = readFileSync(path.join(activity, f), 'utf8');
    assert.equal(/\/\*[\s\S]*?\*\//.test(src), false, `${f} has a block comment`);
    if (f.endsWith('.js')) {
      assert.equal(/^\s*\/\//m.test(src), false, `${f} has a line comment`);
      assert.equal(/style=/.test(src), false, `${f} sets an inline style`);
    }
    assert.equal(/https?:\/\/(?!www\.yapin\.gg|files\.yapper\.website|yapin\.gg|www\.yapper\.website|yapper\.website)/.test(src), false, `${f} links outside`);
    assert.equal(/\b(claude|anthropic)\b/i.test(src), false, f);
  }
  assert.ok(mask(1, 2) >= 0);
  assert.equal(typeof odd.drawings, 'function');
  assert.equal(typeof telephone.drawings, 'function');
  assert.equal(typeof draw.drawings, 'function');
});
