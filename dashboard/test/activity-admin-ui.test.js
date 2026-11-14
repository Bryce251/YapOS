import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, FakeEvent } from './dom-shim.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const activity = path.join(here, '..', 'web', 'activity');

const OWNER = '2c416a35-eac2-4e0e-a310-8648b5ecd7af';
const ADMIN = '11111111-1111-4111-8111-111111111111';
const GUEST = '22222222-2222-4222-8222-222222222222';
const WATCHER = '33333333-3333-4333-8333-333333333333';

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

function byClass(root, cls) {
  return all(root).filter((el) => el.classList && el.classList.contains(cls));
}

function person(id, slot, name, extra = {}) {
  return { id, slot, name, username: name.toLowerCase(), initials: name.slice(0, 2).toUpperCase(), hue: 120, avatar: null, present: true, joined: true, ready: false, isHost: false, isMe: false, game: 0, total: 0, wins: 0, isAdmin: false, isOwner: false, ...extra };
}

function fakeEngine({ me, phase = 'lobby', admins = [OWNER, ADMIN], locked = false, banned = [], clock }) {
  const handlers = {};
  const calls = { run: [], fx: [], end: 0 };
  const players = [
    person(OWNER, 0, 'Jolli', { isHost: true, isOwner: true, isAdmin: true, game: 40 }),
    person(ADMIN, 1, 'Juno', { isAdmin: true, game: 10 }),
    person(GUEST, 2, 'Pip', { game: 5 }),
    person(WATCHER, null, 'Wren', { joined: false }),
  ].map((p) => ({ ...p, isMe: p.id === me, isAdmin: admins.includes(p.id), isHost: p.id === OWNER }));
  const amAdmin = admins.includes(me);
  let snap = null;
  function build(patch = {}) {
    const base = snap || {
      ready: true,
      me,
      meSlot: (players.find((p) => p.id === me) || {}).slot ?? null,
      joining: null,
      autoStart: null,
      host: OWNER,
      hostName: 'Jolli',
      isHost: me === OWNER,
      room: { phase, game: phase === 'lobby' ? null : 'nope', pick: 'wyr', round: 1 },
      scores: { g: {}, t: {}, w: {} },
      players,
      game: phase === 'lobby' ? null : { id: 'nope', name: 'Mystery', emoji: '❓' },
      pick: { id: 'wyr' },
      settings: {},
      state: {},
      admin: { me: amAdmin, owner: OWNER, locked, banned },
      announce: null,
    };
    const next = { ...base, ...patch };
    next.meJoined = Boolean((next.players.find((p) => p.isMe) || {}).joined);
    next.now = clock.now();
    return next;
  }
  snap = build();
  function emit(ev, x) {
    for (const fn of (handlers[ev] || []).slice()) fn(x);
  }
  const engine = {
    games: [{ id: 'wyr', name: 'Would You Rather', emoji: '🤔', blurb: 'Pick a side.', settings: [] }],
    now: () => clock.now(),
    on(ev, fn) {
      (handlers[ev] = handlers[ev] || []).push(fn);
      return () => {
        handlers[ev] = handlers[ev].filter((f) => f !== fn);
      };
    },
    snapshot: () => snap,
    lobby: { start: () => ({ ok: true }), end: () => { calls.end += 1; }, pick() {}, reset() {}, setting: () => true, toLobby() {} },
    join() {},
    leave() {},
    admin: {
      me: () => snap.admin.me,
      owner: () => snap.admin.owner,
      run(action) {
        calls.run.push(action);
        return snap.admin.me;
      },
      fx(name, opts = {}) {
        calls.fx.push({ name, ...opts });
        if (!snap.admin.me) return false;
        emit('fx', { fx: name, target: opts.target ?? null, ms: opts.ms, extra: opts.extra, by: me });
        return true;
      },
    },
  };
  return {
    engine,
    calls,
    emit,
    set(patch) {
      snap = build(patch);
      emit('change', snap);
    },
    player(id, patch) {
      const list = snap.players.map((p) => (p.id === id ? { ...p, ...patch } : p));
      snap = build({ players: list });
      emit('change', snap);
    },
  };
}

function makeClock() {
  let t = 1_700_000_000_000;
  let seq = 0;
  let queue = [];
  return {
    now: () => t,
    setTimeout(fn, ms) {
      const id = ++seq;
      queue.push({ id, at: t + Math.max(0, ms || 0), fn });
      return id;
    },
    clearTimeout(id) {
      queue = queue.filter((x) => x.id !== id);
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        queue.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = queue[0];
        if (!next || next.at > end) break;
        queue.shift();
        t = Math.max(t, next.at);
        next.fn();
      }
      t = end;
    },
  };
}

async function setup({ me = OWNER, phase = 'lobby', quiet = false, admins, banned } = {}) {
  const { window } = installDom({ url: 'https://yapos.dev/activity/' });
  const clock = makeClock();
  const fake = fakeEngine({ me, phase, admins, banned, clock });
  const root = document.createElement('div');
  document.body.append(root);
  const win = Object.assign(window, {
    document,
    parent: {},
    innerWidth: 360,
    innerHeight: 640,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    matchMedia: () => ({ matches: quiet, addEventListener() {}, removeEventListener() {} }),
  });
  const { mountApp } = await import('../web/activity/js/ui/app.js');
  const app = mountApp({ root, engine: fake.engine, bridge: { close() {} }, win });
  const shell = byClass(root, 'shell')[0];
  return { ...fake, root, app, clock, shell, win };
}

function adminBtn(root) {
  return byKey(root, 'admin');
}

function key(down, opts = {}) {
  const e = new FakeEvent('keydown', { bubbles: true, key: down });
  e.shiftKey = Boolean(opts.shift);
  return e;
}

test('the ADMIN button shows only for admins and always sits next to End game', async () => {
  for (const phase of ['lobby', 'game', 'results']) {
    const owner = await setup({ me: OWNER, phase });
    const btn = adminBtn(owner.root);
    assert.ok(btn, `owner sees ADMIN in ${phase}`);
    assert.match(text(btn), /ADMIN/);
    assert.match(btn.className, /btn-admin/);
    const actions = btn.parentNode;
    assert.match(actions.className, /top-actions/);
    if (phase === 'game') {
      const kids = actions.children;
      assert.equal(kids[kids.indexOf(btn) + 1].dataset.key, 'end');
    }
    owner.app.destroy();

    const admin = await setup({ me: ADMIN, phase });
    assert.ok(adminBtn(admin.root), `extra admin sees ADMIN in ${phase}`);
    admin.app.destroy();

    const guest = await setup({ me: GUEST, phase });
    assert.equal(adminBtn(guest.root), null, `guest never sees ADMIN in ${phase}`);
    assert.equal(guest.app.panel.open(), false);
    guest.app.destroy();
  }
});

test('the panel opens, traps focus, closes on Escape and gives focus back', async () => {
  const s = await setup({ me: OWNER });
  const sheet = s.app.panel.el;
  assert.equal(sheet.hasAttribute('hidden'), true);
  adminBtn(s.root).click();
  assert.equal(s.app.panel.isOpen, true);
  assert.equal(sheet.hasAttribute('hidden'), false);
  assert.equal(adminBtn(s.root).getAttribute('aria-expanded'), 'true');
  assert.ok(sheet.contains(document.activeElement));
  const focusable = all(sheet).filter((el) => ['button', 'input'].includes(el.localName) && !el.disabled);
  focusable[focusable.length - 1].focus();
  const tab = key('Tab');
  sheet.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, true);
  assert.equal(document.activeElement, focusable[0]);
  const back = key('Tab', { shift: true });
  sheet.dispatchEvent(back);
  assert.equal(document.activeElement, focusable[focusable.length - 1]);
  sheet.dispatchEvent(key('Escape'));
  assert.equal(s.app.panel.isOpen, false);
  assert.equal(sheet.hasAttribute('hidden'), true);
  assert.equal(document.activeElement, adminBtn(s.root));
  assert.equal(adminBtn(s.root).getAttribute('aria-expanded'), 'false');
  adminBtn(s.root).click();
  byKey(sheet, 'admin-close').click();
  assert.equal(s.app.panel.isOpen, false);
  s.app.destroy();
});

test('the Game tab sends start, end, skip, time, lock and announce', async () => {
  const lobby = await setup({ me: ADMIN });
  adminBtn(lobby.root).click();
  const sheet = lobby.app.panel.el;
  assert.equal(byKey(sheet, 'adm-skip').disabled, true);
  assert.equal(byKey(sheet, 'adm-end').disabled, true);
  byKey(sheet, 'adm-start').click();
  assert.deepEqual(lobby.calls.run.at(-1), { type: 'start' });
  assert.match(text(lobby.root), /Starting the game now/);
  lobby.app.destroy();

  const s = await setup({ me: ADMIN, phase: 'game' });
  adminBtn(s.root).click();
  const p = s.app.panel.el;
  assert.equal(byKey(p, 'adm-start').disabled, true);
  byKey(p, 'adm-end').click();
  byKey(p, 'adm-skip').click();
  byKey(p, 'adm-time-15000').click();
  byKey(p, 'adm-time-30000').click();
  byKey(p, 'adm-time--10000').click();
  byKey(p, 'adm-lock').click();
  assert.deepEqual(s.calls.run, [{ type: 'end' }, { type: 'skip' }, { type: 'time', ms: 15000 }, { type: 'time', ms: 30000 }, { type: 'time', ms: -10000 }, { type: 'lock', on: true }]);
  s.set({ admin: { ...s.engine.snapshot().admin, locked: true } });
  assert.equal(byKey(p, 'adm-lock').getAttribute('aria-pressed'), 'true');
  byKey(p, 'adm-lock').click();
  assert.deepEqual(s.calls.run.at(-1), { type: 'lock', on: false });
  byKey(p, 'adm-announce-send').click();
  assert.match(text(s.root), /Type a message first/);
  const input = byKey(p, 'adm-announce');
  input.value = `  Pizza   is here! ${'x'.repeat(200)}`;
  input.dispatchEvent(new FakeEvent('input', { bubbles: true }));
  byKey(p, 'adm-announce-send').click();
  const sent = s.calls.run.at(-1);
  assert.equal(sent.type, 'announce');
  assert.ok(sent.text.startsWith('Pizza is here!'));
  assert.ok(sent.text.length <= 140);
  byKey(p, 'adm-announce-clear').click();
  assert.deepEqual(s.calls.run.at(-1), { type: 'announce', text: '' });
  s.app.destroy();
});

test('the Players tab lists everyone with badges and sends per-person actions', async () => {
  const s = await setup({ me: ADMIN, phase: 'game', banned: [WATCHER] });
  adminBtn(s.root).click();
  byKey(s.app.panel.el, 'admin-tab-players').click();
  const p = s.app.panel.el;
  const t = text(p);
  for (const bit of ['Jolli', 'Juno', 'Pip', 'Wren', '@pip', 'Owner', 'Admin', 'Playing', 'Banned']) assert.match(t, new RegExp(bit));
  assert.equal(byKey(p, `pts-up-${OWNER}`), null, 'owner row has no actions for another admin');
  assert.match(t, /The owner can't be changed by other admins/);
  byKey(p, `pts-up-${GUEST}`).click();
  byKey(p, `pts-down-${GUEST}`).click();
  const custom = byKey(p, `pts-in-${GUEST}`);
  custom.value = '2500';
  custom.dispatchEvent(new FakeEvent('input', { bubbles: true }));
  byKey(p, `pts-go-${GUEST}`).click();
  byKey(p, `kick-${GUEST}`).click();
  byKey(p, `ban-${GUEST}`).click();
  byKey(p, `pts-up-${ADMIN}`).click();
  assert.deepEqual(s.calls.run, [
    { type: 'points', slot: 2, n: 100 },
    { type: 'points', slot: 2, n: -100 },
    { type: 'points', slot: 2, n: 2500 },
    { type: 'kick', slot: 2 },
    { type: 'ban', slot: 2 },
    { type: 'points', slot: 1, n: 100 },
  ]);
  const bad = byKey(p, `pts-in-${GUEST}`);
  bad.value = '999999';
  bad.dispatchEvent(new FakeEvent('input', { bubbles: true }));
  byKey(p, `pts-go-${GUEST}`).click();
  assert.equal(s.calls.run.length, 6);
  assert.match(text(s.root), /whole number/);
  assert.equal(byKey(p, `kick-${WATCHER}`).disabled, true);
  assert.equal(byKey(p, `unban-${WATCHER}`).disabled, true);
  s.app.destroy();

  const o = await setup({ me: OWNER, phase: 'game' });
  adminBtn(o.root).click();
  byKey(o.app.panel.el, 'admin-tab-players').click();
  byKey(o.app.panel.el, `kick-${ADMIN}`).click();
  byKey(o.app.panel.el, `pts-down-${OWNER}`).click();
  assert.deepEqual(o.calls.run, [{ type: 'kick', slot: 1 }, { type: 'points', slot: 0, n: -100 }]);
  o.app.destroy();
});

test('the Fun and Troll tabs send effects and guard the owner', async () => {
  const s = await setup({ me: ADMIN });
  adminBtn(s.root).click();
  const p = s.app.panel.el;
  byKey(p, 'admin-tab-fun').click();
  byKey(p, 'fx-confetti').click();
  byKey(p, 'fx-hype').click();
  byKey(p, 'rain-3').click();
  byKey(p, 'fx-emoji-rain').click();
  assert.equal(byKey(p, 'fx-spotlight').disabled, true);
  assert.equal(byKey(p, `spot-${OWNER}`).disabled, true);
  byKey(p, `spot-${GUEST}`).click();
  byKey(p, 'fx-spotlight').click();
  assert.deepEqual(
    s.calls.fx.map((c) => [c.name, c.target, c.extra ? c.extra.emoji : null]),
    [['confetti', null, null], ['hype', null, null], ['emoji-rain', null, '💖'], ['spotlight', GUEST, null]],
  );
  byKey(p, 'admin-tab-troll').click();
  assert.equal(byKey(p, `troll-target-${OWNER}`).disabled, true);
  assert.equal(byKey(p, 'troll-target-all').getAttribute('aria-pressed'), 'true');
  assert.equal(byKey(p, 'troll-clown').disabled, true);
  assert.equal(byKey(p, 'troll-fake-win').disabled, true);
  assert.equal(byKey(p, 'troll-flip').disabled, false);
  byKey(p, `troll-target-${GUEST}`).click();
  byKey(p, 'troll-ms-20000').click();
  const names = ['flip', 'mirror', 'shake', 'spin', 'tiny', 'comic', 'blur', 'crash', 'clown', 'fake-win'];
  for (const n of names) assert.ok(byKey(p, `troll-${n}`), n);
  assert.equal(byKey(p, 'troll-clown').disabled, false);
  assert.equal(byKey(p, 'troll-fake-win').disabled, false);
  byKey(p, 'troll-flip').click();
  assert.deepEqual(s.calls.fx.at(-1), { name: 'flip', target: GUEST, ms: 20000 });
  assert.match(text(s.root), /Flip sent to Pip/);
  s.app.destroy();

  const o = await setup({ me: OWNER });
  adminBtn(o.root).click();
  byKey(o.app.panel.el, 'admin-tab-troll').click();
  assert.equal(byKey(o.app.panel.el, `troll-target-${OWNER}`).disabled, false);
  o.app.destroy();
});

test('every effect adds its class and removes it on time', async () => {
  const s = await setup({ me: GUEST });
  const shellHas = (n) => s.shell.classList.contains(`troll-${n}`);
  const all10 = ['flip', 'mirror', 'shake', 'spin', 'tiny', 'comic', 'blur', 'crash', 'clown', 'fake-win', 'confetti', 'emoji-rain', 'hype'];
  for (const n of all10) {
    const target = n === 'clown' || n === 'fake-win' ? GUEST : null;
    assert.equal(s.app.trolls.apply({ fx: n, target, ms: 5000, extra: { emoji: '🦆' }, by: OWNER }), true, n);
    assert.equal(shellHas(n), true, n);
    s.clock.advance(4900);
    assert.equal(shellHas(n), true, `${n} still on`);
    s.clock.advance(200);
    assert.equal(shellHas(n), false, `${n} ended`);
    assert.equal(byClass(s.root, 'troll-overlay').length, 0, `${n} overlay gone`);
  }
  s.app.trolls.apply({ fx: 'spotlight', target: ADMIN, ms: 3000, by: OWNER });
  assert.match(text(s.root), /All eyes on Juno/);
  assert.ok(byClass(s.root, 'is-spotlit').length > 0);
  s.clock.advance(3100);
  assert.equal(byClass(s.root, 'is-spotlit').length, 0);
  assert.equal(s.app.trolls.apply({ fx: 'spotlight', target: null, ms: 3000 }), false);
  assert.equal(s.app.trolls.apply({ fx: 'nope', target: null, ms: 3000 }), false);
  assert.equal(s.app.trolls.apply({ fx: 'clown', target: null, ms: 3000 }), false);
  assert.equal(s.app.trolls.apply({ fx: 'fake-win', target: null, ms: 3000 }), false);
  s.app.trolls.apply({ fx: 'shake', target: null, ms: 999999 });
  s.clock.advance(30001);
  assert.equal(shellHas('shake'), false, 'capped at 30 seconds');
  s.app.destroy();
});

test('transform trolls replace each other while overlays stack', async () => {
  const s = await setup({ me: GUEST });
  s.app.trolls.apply({ fx: 'flip', target: null, ms: 10000 });
  s.app.trolls.apply({ fx: 'spin', target: null, ms: 10000 });
  assert.equal(s.shell.classList.contains('troll-flip'), false);
  assert.equal(s.shell.classList.contains('troll-spin'), true);
  s.app.trolls.apply({ fx: 'crash', target: null, ms: 10000 });
  s.app.trolls.apply({ fx: 'hype', target: null, ms: 10000 });
  s.app.trolls.apply({ fx: 'blur', target: null, ms: 10000 });
  assert.equal(byClass(s.root, 'troll-overlay').length, 2);
  assert.equal(s.shell.classList.contains('troll-blur'), true);
  assert.equal(s.shell.classList.contains('troll-spin'), true);
  s.clock.advance(7600);
  assert.equal(byClass(s.root, 'troll-crash-layer')[0].classList.contains('is-reveal'), true);
  assert.match(text(s.root), /jk/);
  s.clock.advance(3000);
  assert.equal(s.app.trolls.active.length, 0);
  s.app.destroy();
});

test('targeted effects only show to their target, and the clown shows to everyone', async () => {
  const pip = await setup({ me: GUEST });
  const juno = await setup({ me: ADMIN });
  for (const s of [pip, juno]) s.app.trolls.apply({ fx: 'fake-win', target: GUEST, ms: 5000, by: OWNER });
  assert.equal(byClass(pip.root, 'troll-win-layer').length, 1);
  assert.equal(byClass(juno.root, 'troll-win-layer').length, 0);
  assert.match(text(pip.root), /You won 1,000,000 Shards!/);
  assert.equal(juno.app.trolls.apply({ fx: 'flip', target: GUEST, ms: 5000 }), false);
  pip.clock.advance(5100);
  juno.clock.advance(5100);
  juno.app.trolls.apply({ fx: 'clown', target: GUEST, ms: 5000, by: OWNER });
  juno.set({});
  const marked = byClass(juno.root, 'is-clown');
  assert.ok(marked.length >= 2, 'board name and avatar get the clown');
  assert.ok(marked.every((el) => el.getAttribute('data-uid') === GUEST));
  juno.clock.advance(5100);
  assert.equal(byClass(juno.root, 'is-clown').length, 0);
  pip.app.destroy();
  juno.app.destroy();
});

test('reduced motion swaps in still versions', async () => {
  const s = await setup({ me: GUEST, quiet: true });
  s.app.trolls.apply({ fx: 'shake', target: null, ms: 5000 });
  assert.equal(s.shell.classList.contains('fx-quiet'), true);
  s.app.trolls.apply({ fx: 'confetti', target: null, ms: 4000 });
  assert.equal(byClass(s.root, 'troll-burst-layer').length, 1);
  s.app.trolls.apply({ fx: 'emoji-rain', target: null, ms: 4000, extra: { emoji: '🍕' } });
  assert.equal(byClass(s.root, 'troll-rain-layer')[0].classList.contains('is-still'), true);
  s.clock.advance(5100);
  assert.equal(s.shell.classList.contains('fx-quiet'), false);
  assert.equal(byClass(s.root, 'troll-overlay').length, 0);
  const css = readFileSync(path.join(activity, 'css', 'admin.css'), 'utf8');
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\.fx-quiet\.troll-shake/);
  s.app.destroy();
});

test('the announce banner counts down and goes away', async () => {
  const s = await setup({ me: GUEST, phase: 'game' });
  s.set({ announce: { text: 'Snacks in the kitchen!', until: s.clock.now() + 10000 } });
  const banner = byClass(s.root, 'announce')[0];
  assert.ok(banner);
  assert.match(text(banner), /Snacks in the kitchen!/);
  assert.match(text(banner), /10s/);
  s.clock.advance(10001);
  s.set({});
  assert.equal(byClass(s.root, 'announce').length, 0);
  s.app.destroy();
});

test('being kicked or banned by an admin explains what happened', async () => {
  const s = await setup({ me: GUEST, phase: 'game' });
  s.player(GUEST, { joined: false });
  assert.match(text(s.root), /An admin moved you to watching\./);
  s.player(GUEST, { joined: true });
  s.set({ admin: { ...s.engine.snapshot().admin, banned: [GUEST] } });
  s.player(GUEST, { joined: false });
  assert.match(text(s.root), /can't rejoin/);
  s.app.destroy();

  const self = await setup({ me: GUEST, phase: 'lobby' });
  byKey(self.root, 'leave-game').click();
  self.player(GUEST, { joined: false });
  assert.doesNotMatch(text(self.root), /An admin moved you/);
  self.app.destroy();
});

test('nothing in the admin UI uses inline style attributes', async () => {
  const s = await setup({ me: OWNER, phase: 'game' });
  adminBtn(s.root).click();
  for (const t of ['game', 'players', 'fun', 'troll']) {
    byKey(s.app.panel.el, `admin-tab-${t}`).click();
    for (const el of all(s.root)) assert.equal(el.hasAttribute('style'), false, el.className);
  }
  for (const n of ['crash', 'fake-win', 'emoji-rain', 'hype', 'confetti']) s.app.trolls.apply({ fx: n, target: n === 'fake-win' ? OWNER : null, ms: 5000 });
  s.app.trolls.apply({ fx: 'spotlight', target: GUEST, ms: 5000 });
  for (const el of all(document.body)) assert.equal(el.hasAttribute('style'), false, el.className);
  for (const f of ['js/ui/admin-panel.js', 'js/ui/trolls.js', 'js/ui/app.js', 'css/admin.css']) {
    const src = readFileSync(path.join(activity, f), 'utf8');
    assert.equal(/innerHTML|style\s*=|\.style\.(?!setProperty)[a-zA-Z]+\s*=/.test(src), false, f);
  }
  const html = readFileSync(path.join(activity, 'index.html'), 'utf8');
  assert.match(html, /href="\/activity\/css\/admin\.css"/);
  s.app.destroy();
});
