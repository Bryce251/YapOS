import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, FakeEvent, flush } from './dom-shim.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const activity = path.join(here, '..', 'web', 'activity');
const ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'a'.repeat(43);

const cj = await import('../web/activity/js/clanjoin.js');

function text(node) {
  if (node.data !== undefined && !node.localName) return node.data;
  return (node.childNodes || []).map(text).join(' ');
}

const CLAN = { tag: 'YAP', name: "Yapin'", colour: '#7C5CFF', banner: 'We yap a lot', members: 12, join: 'open', leader: { name: 'Jolli', username: 'jolli' }, top: [{ name: 'Jolli', username: 'jolli', level: 40, leader: true }, { name: 'Bea', username: null, level: 9, leader: false }] };

function viewer(status, extra = {}) {
  return { signedIn: status !== 'signed_out', status, clan: null, request: null, ...extra };
}

test('clan names show as [TAG] Name, or just [TAG] when they match', () => {
  assert.deepEqual(cj.clanParts({ name: "Yapin'", tag: 'YAP' }), { code: '[YAP]', name: "Yapin'", full: "[YAP] Yapin'" });
  assert.deepEqual(cj.clanParts({ name: 'ado', tag: 'ADO' }), { code: '[ADO]', name: '', full: '[ADO]' });
  assert.deepEqual(cj.clanParts({ name: 'Solo' }), { code: '', name: 'Solo', full: 'Solo' });
  assert.equal(cj.clanParts(null), null);
  assert.equal(cj.clanTagOk('GG42'), true);
  assert.equal(cj.clanTagOk('<b>'), false);
  assert.equal(cj.clanTagOk('TOOLONG'), false);
  assert.equal(cj.clanPath('yap'), '/api/clans/YAP');
  assert.equal(cj.clanPath('yap', true), '/api/clans/YAP/join');
});

test('the clan reader keeps only safe fields and defaults to open', () => {
  const c = cj.readClan({ ...CLAN, colour: 'red; x', join: 'weird', top: [...CLAN.top, {}, null] });
  assert.equal(c.colour, null);
  assert.equal(c.join, 'open');
  assert.equal(c.top.length, 2);
  assert.equal(c.leader.name, 'Jolli');
  assert.equal(cj.readClan({ tag: 'YAP' }), null);
  assert.equal(cj.readClan(CLAN).colour, '#7c5cff');
  assert.equal(cj.readViewer(null).status, 'signed_out');
  assert.equal(cj.readViewer({ status: 'other', clan: { tag: 'OWL', name: 'Night Owls' } }).clan.full, '[OWL] Night Owls');
});

test('every viewer state says what to do next', () => {
  const ready = (v, clan = CLAN) => cj.joinState({ phase: 'ready', clan: cj.readClan(clan), viewer: cj.readViewer(v), note: null, busy: false });
  assert.deepEqual(ready(viewer('can_join')), { tone: 'info', text: 'Anyone can join this clan.', action: 'join', label: 'Join [YAP]', busy: false });
  assert.equal(ready(viewer('signed_out')).action, 'signin');
  assert.equal(ready(viewer('signed_out'), { ...CLAN, join: 'invite' }).action, null);
  assert.match(ready(viewer('signed_out'), { ...CLAN, join: 'invite' }).text, /invite only/);
  assert.match(ready(viewer('invite_only')).text, /Ask the leader/);
  assert.equal(ready(viewer('member')).text, "You're in this clan.");
  assert.equal(ready(viewer('member', { request: { status: 'joined' } })).text, "You joined [YAP] Yapin'!");
  const pending = ready(viewer('pending', { request: { status: 'pending', message: 'Waiting for YapOS to add you.' } }));
  assert.equal(pending.busy, true);
  assert.equal(pending.label, 'Requested');
  assert.match(ready(viewer('pending', { request: { status: 'pending', waiting: true, message: "YapOS is offline right now. Your request will go through when it's back." } })).text, /offline/);
  assert.match(ready(viewer('pending_other', { pendingTag: 'OWL' })).text, /\[OWL\]/);
  assert.match(ready(viewer('other', { clan: { tag: 'OWL', name: 'Night Owls' } })).text, /\[OWL\] Night Owls\. Leave it first with \/clan leave/);
  assert.match(ready(viewer('can_join', { request: { status: 'refused', code: 'invite_only', message: 'Nope, invite only now.' } })).text, /Nope/);
  assert.equal(cj.joinState({ phase: 'loading' }).text, 'Loading clan…');
  assert.equal(cj.joinState({ phase: 'missing' }).action, null);
  assert.equal(cj.joinState({ phase: 'error' }).action, 'retry');
});

function fakeServer(script) {
  const calls = [];
  const request = async (method, url) => {
    calls.push({ method, url });
    const next = script.shift();
    if (!next) throw new Error('no more answers');
    return next;
  };
  return { calls, request };
}

function timers() {
  const queue = [];
  return {
    queue,
    setTimer: (fn, ms) => {
      const t = { fn, ms, done: false };
      queue.push(t);
      return t;
    },
    clearTimer: (t) => {
      t.done = true;
    },
    async run() {
      const t = queue.find((x) => !x.done);
      if (!t) return false;
      t.done = true;
      t.fn();
      await flush();
      return true;
    },
  };
}

test('joining an open clan goes pending, polls, then shows joined', async () => {
  const srv = fakeServer([
    { status: 200, data: { clan: CLAN, viewer: viewer('can_join') } },
    { status: 202, data: { request: { status: 'pending' }, viewer: viewer('pending', { request: { status: 'pending', message: 'Waiting for YapOS to add you.' } }) } },
    { status: 200, data: { clan: CLAN, viewer: viewer('pending', { request: { status: 'pending' } }) } },
    { status: 200, data: { clan: { ...CLAN, members: 13 }, viewer: viewer('member', { request: { status: 'joined', code: 'joined', message: 'You joined.' } }) } },
  ]);
  const t = timers();
  const seen = [];
  const ctl = cj.createClanJoin({ tag: 'yap', request: srv.request, onChange: (st) => seen.push(cj.joinState(st).text), setTimer: t.setTimer, clearTimer: t.clearTimer, pollMs: 5 });
  await ctl.load();
  assert.equal(ctl.state.phase, 'ready');
  assert.equal(cj.joinState(ctl.state).label, 'Join [YAP]');
  await ctl.join();
  assert.deepEqual(srv.calls.map((c) => `${c.method} ${c.url}`), ['GET /api/clans/YAP', 'POST /api/clans/YAP/join']);
  assert.equal(ctl.state.viewer.status, 'pending');
  assert.equal(ctl.polling, true);
  assert.equal(await ctl.join().then(() => srv.calls.length), 2, 'a second tap while pending sends nothing');
  await t.run();
  assert.equal(ctl.state.viewer.status, 'pending');
  await t.run();
  assert.equal(ctl.state.viewer.status, 'member');
  assert.equal(ctl.state.clan.members, 13);
  assert.equal(ctl.polling, false);
  assert.ok(seen.includes("You joined [YAP] Yapin'!"));
});

test('join refusals keep the server reason and the right state', async () => {
  const cases = [
    [{ status: 409, data: { error: 'in_other_clan', message: "You're in [OWL] Night Owls. Leave it first with /clan leave.", viewer: viewer('other', { clan: { tag: 'OWL', name: 'Night Owls' } }) } }, 'other', /Leave it first/],
    [{ status: 403, data: { error: 'invite_only', message: 'Invite only.', viewer: viewer('invite_only') } }, 'invite_only', /invite only/],
    [{ status: 409, data: { error: 'already_member', message: 'Already in.', viewer: viewer('member') } }, 'member', /in this clan/],
    [{ status: 401, data: { error: 'signed_out', message: 'Sign in to join a clan.' } }, 'signed_out', /Sign in to join a clan/],
    [{ status: 429, data: { error: 'rate_limited', message: 'That is a lot of join requests. Wait a minute and try again.' } }, 'can_join', /a lot of join requests/],
    [{ status: 0, data: null }, 'can_join', /didn't go through/],
  ];
  for (const [answer, status, re] of cases) {
    const srv = fakeServer([{ status: 200, data: { clan: CLAN, viewer: viewer('can_join') } }, answer]);
    const ctl = cj.createClanJoin({ tag: 'YAP', request: srv.request });
    await ctl.load();
    await ctl.join();
    assert.equal(ctl.state.viewer.status, status, JSON.stringify(answer));
    assert.match(cj.joinState(ctl.state).text, re);
    assert.equal(ctl.state.busy, false);
  }
  const gone = cj.createClanJoin({ tag: 'YAP', request: fakeServer([{ status: 200, data: { clan: CLAN, viewer: viewer('can_join') } }, { status: 404, data: { error: 'not_found' } }]).request });
  await gone.load();
  await gone.join();
  assert.equal(gone.state.phase, 'missing');
  const invite = cj.createClanJoin({ tag: 'YAP', request: fakeServer([{ status: 200, data: { clan: CLAN, viewer: viewer('can_join') } }, { status: 403, data: { error: 'invite_only', message: 'x', viewer: viewer('invite_only') } }]).request });
  await invite.load();
  await invite.join();
  assert.equal(invite.state.clan.join, 'invite', 'the sheet flips to invite only when the server says so');
});

test('a bad tag never calls the server, and stop clears the poll', async () => {
  const srv = fakeServer([]);
  const bad = cj.createClanJoin({ tag: '<b>', request: srv.request });
  await bad.load();
  assert.equal(bad.state.phase, 'missing');
  assert.equal(srv.calls.length, 0);
  const t = timers();
  const ctl = cj.createClanJoin({ tag: 'YAP', request: fakeServer([{ status: 200, data: { clan: CLAN, viewer: viewer('pending', { request: { status: 'pending' } }) } }]).request, setTimer: t.setTimer, clearTimer: t.clearTimer });
  await ctl.load();
  assert.equal(ctl.polling, true, 'an open request is followed until it finishes');
  ctl.stop();
  assert.equal(ctl.polling, false);
  assert.equal(t.queue.every((x) => x.done), true);
});

function partyCard() {
  return {
    hidden: false,
    name: 'Jolli',
    username: 'jolli',
    avatar: null,
    level: 11,
    progress: { into: 50, need: 200 },
    shards: null,
    badges: [{ id: 'founder', label: 'Founder', emoji: '🏛️', rare: 'special' }, { id: 'first-game', label: 'First game', emoji: '🎈' }],
    badgeCount: 2,
    achievements: [],
    clan: { name: "Yapin'", tag: 'YAP', colour: '#7C5CFF' },
    party: { games: 3, wins: 1, bestStreak: 0, favourites: [] },
    rank: null,
    page: true,
    look: { pins: ['founder'], pronouns: 'he/him', status: 'Developing YapOS!', statusEmoji: null },
  };
}

async function setup({ signedIn = true, card = partyCard(), answers = [] } = {}) {
  const { document } = installDom({ url: 'https://yapos.dev/activity/' });
  const calls = [];
  const opened = [];
  const win = {
    document,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.startsWith('/api/activity/profile/')) return new Response(JSON.stringify({ profile: card }), { status: 200 });
      const next = answers.shift();
      if (!next) return new Response('{}', { status: 500 });
      return new Response(JSON.stringify(next.data), { status: next.status });
    },
  };
  const gate = { state: () => (signedIn ? { status: 'in', token: TOKEN } : { status: 'out', token: null }), open: (why) => opened.push(why) };
  const { avatar, h } = await import('../web/activity/js/ui/dom.js');
  const { createProfileCard } = await import('../web/activity/js/ui/profilecard.js');
  const root = h('div', { class: 'app' });
  document.body.append(root);
  const face = avatar({ id: ID, name: 'Jolli', initials: 'J', hue: 30, avatar: null }, 'md');
  root.append(face);
  const pc = createProfileCard({ win, engine: { snapshot: () => ({ me: 'x', players: [{ id: ID, name: 'Jolli', present: true, joined: true }], room: { phase: 'lobby' } }) }, signin: () => gate, clanPollMs: 5 });
  pc.bind(root);
  pc.open(ID);
  await flush();
  await flush();
  return { document, pc, calls, opened, answers };
}

function click(el) {
  el.dispatchEvent(new FakeEvent('click', { bubbles: true }));
}

async function settle(ms = 20) {
  await new Promise((r) => setTimeout(r, ms));
  await flush();
  await flush();
}

test('the Party card shows the clan as a coloured pill next to the handle, with pins, status and pronouns as pills', async () => {
  const { pc } = await setup();
  const sub = pc.el.querySelector('.pcard-sub');
  const clan = sub.querySelector('.pcard-clan');
  assert.equal(clan.localName, 'button');
  assert.equal(clan.style.props['--pc-clan'], '#7c5cff');
  assert.equal(clan.getAttribute('aria-label'), "Clan [YAP] Yapin'. Open clan");
  assert.equal(text(clan).replace(/\s+/g, ' ').trim(), "[YAP] Yapin'");
  assert.equal(sub.querySelectorAll('.pcard-pin').length, 1);
  assert.match(text(sub.querySelector('.pcard-pin')), /Founder/);
  assert.match(text(sub.querySelector('.pcard-status')), /Developing YapOS!/);
  assert.match(text(sub.querySelector('.pcard-pronouns')), /he\/him/);
  assert.equal(pc.el.querySelector('.pcard-facts'), null);
  pc.close();
});

test('a clan whose tag and name match shows [TAG] once, and a bad tag is plain text', async () => {
  const one = await setup({ card: { ...partyCard(), clan: { name: 'ADO', tag: 'ADO' } } });
  assert.equal(text(one.pc.el.querySelector('.pcard-clan')).trim(), '[ADO]');
  one.pc.close();
  const bad = await setup({ card: { ...partyCard(), clan: { name: 'Weird', tag: '<b>' } } });
  assert.equal(bad.pc.el.querySelector('.pcard-clan').localName, 'span');
  assert.equal(bad.pc.el.querySelector('.pcard-clan.is-live'), null);
  bad.pc.close();
});

test('tapping the clan pill opens the clan inside the card, Join goes pending then joined, Esc goes back to the pill', async () => {
  const answers = [
    { status: 200, data: { clan: CLAN, viewer: viewer('can_join') } },
    { status: 202, data: { request: { status: 'pending' }, viewer: viewer('pending', { request: { status: 'pending', message: 'Waiting for YapOS to add you.' } }) } },
    { status: 200, data: { clan: { ...CLAN, members: 13 }, viewer: viewer('member', { request: { status: 'joined' } }) } },
  ];
  const { document, pc, calls } = await setup({ answers });
  click(pc.el.querySelector('.pcard-clan'));
  const view = () => pc.el.querySelector('.pcard-view.is-clan');
  assert.ok(view(), 'the clan opens as a second view inside the card');
  assert.equal(pc.el.querySelector('.pcard').getAttribute('aria-labelledby'), 'pcard-clan-title');
  assert.equal(document.activeElement, pc.el.querySelector('.pcard-back'));
  await settle();
  const get = calls.find((c) => c.url === '/api/clans/YAP');
  assert.equal(get.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(get.init.credentials, 'omit');
  const all = text(view());
  assert.match(all, /Yapin'/);
  assert.match(all, /We yap a lot/);
  assert.match(all, /Members\s+12/);
  assert.match(all, /Leader\s+Jolli/);
  assert.match(all, /Joining\s+Open/);
  assert.equal(view().style.props['--pc-clan'], '#7c5cff');
  const join = pc.el.querySelector('.pcard-clan-join');
  assert.match(text(join), /Join \[YAP\]/);
  join.focus();
  click(join);
  await settle();
  const post = calls.find((c) => c.url === '/api/clans/YAP/join');
  assert.equal(post.init.method, 'POST');
  assert.equal(post.init.headers.Authorization, `Bearer ${TOKEN}`);
  await settle(40);
  assert.match(text(view()), /You joined \[YAP\] Yapin'!/);
  assert.match(text(view()), /Members\s+13/);
  const back = new FakeEvent('keydown', { bubbles: true, key: 'Escape' });
  pc.el.querySelector('.pcard-back').dispatchEvent(back);
  assert.equal(view(), null);
  assert.equal(pc.isOpen, true, 'Esc steps back first, it does not close the card');
  assert.equal(document.activeElement, pc.el.querySelector('.pcard-clan'));
  pc.close();
});

test('signed out, the clan sheet asks to sign in and opens the existing sign-in prompt', async () => {
  const { pc, calls, opened } = await setup({ signedIn: false, answers: [{ status: 200, data: { clan: CLAN, viewer: viewer('signed_out') } }] });
  click(pc.el.querySelector('.pcard-clan'));
  await settle();
  assert.equal(calls.find((c) => c.url === '/api/clans/YAP').init.headers.Authorization, undefined);
  const btn = pc.el.querySelector('.pcard-clan-join');
  assert.match(text(btn), /Sign in to join/);
  click(btn);
  assert.deepEqual(opened, ['clan']);
  assert.equal(pc.isOpen, false, 'the card steps aside for the sign-in prompt');
});

test('in another clan or an invite only clan, the card says why and shows no Join button', async () => {
  const other = await setup({ answers: [{ status: 200, data: { clan: CLAN, viewer: viewer('other', { clan: { tag: 'OWL', name: 'Night Owls' } }) } }] });
  click(other.pc.el.querySelector('.pcard-clan'));
  await settle();
  assert.match(text(other.pc.el), /\[OWL\] Night Owls\. Leave it first with \/clan leave/);
  assert.equal(other.pc.el.querySelector('.pcard-clan-join'), null);
  other.pc.close();
  const invite = await setup({ answers: [{ status: 200, data: { clan: { ...CLAN, join: 'invite' }, viewer: viewer('invite_only') } }] });
  click(invite.pc.el.querySelector('.pcard-clan'));
  await settle();
  assert.match(text(invite.pc.el), /Joining\s+Invite only/);
  assert.match(text(invite.pc.el), /Ask the leader for an invite/);
  assert.equal(invite.pc.el.querySelector('.pcard-clan-join'), null);
  invite.pc.close();
});

test('closing the card mid-request stops polling the clan', async () => {
  const { pc, calls } = await setup({ answers: [{ status: 200, data: { clan: CLAN, viewer: viewer('pending', { request: { status: 'pending' } }) } }] });
  click(pc.el.querySelector('.pcard-clan'));
  await settle();
  pc.close();
  const before = calls.length;
  await settle(40);
  assert.equal(calls.length, before);
});

test('the clan pill and sheet styles live in the lazy card sheet, ASCII only', () => {
  const look = readFileSync(path.join(activity, 'css', 'profilecard-look.css'), 'utf8');
  for (const sel of ['.pcard-pill {', '.pcard-clan {', '.pcard-clan.is-live:focus-visible', '.pcard-view.is-clan {', '.pcard-clan-facts {', '.pcard-clan-join {']) assert.ok(look.includes(sel), sel);
  assert.equal(/[^\x00-\x7f]/.test(look), false);
  const main = readFileSync(path.join(activity, 'css', 'profilecard.css'), 'utf8');
  assert.equal(main.includes('.pcard-clan'), false, 'nothing new in the first-load sheet');
});
