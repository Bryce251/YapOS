import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS, uuid, settle } from '../harness.js';
import { checkName, roomNameFor } from '../../apps/voice.js';

const S = IDS.server;
const G = IDS.channels.general;
const LOUNGE = IDS.channels.voice;
const LOG = IDS.channels.modlog;
const dmOf = (uid) => `d${uid.slice(1)}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function addVoiceApi(h) {
  const base = h.bot.api;
  const fx = { moveError: null, disconnectError: null, categoryError: null, categories: [] };
  const fail = (status, message) => { const e = new Error(message); e.status = status; return e; };
  const voiceSets = () => h.fake.state.voice;
  const dropEverywhere = (uid) => { for (const set of Object.values(voiceSets())) set.delete(uid); };
  h.bot.api = async (method, fullPath, body) => {
    const p = fullPath.split('?')[0];
    if (method === 'POST' && /^\/servers\/[^/]+\/voice\/move$/.test(p)) {
      h.fake.calls.push({ method, path: fullPath, body: structuredClone(body) });
      if (fx.moveError) throw fail(fx.moveError.status, fx.moveError.message);
      if (!Object.values(voiceSets()).some((set) => set.has(body.user_id))) throw fail(400, "They aren't in voice");
      dropEverywhere(body.user_id);
      (voiceSets()[body.channel_id] ||= new Set()).add(body.user_id);
      return { ok: true };
    }
    if (method === 'POST' && /^\/servers\/[^/]+\/voice\/disconnect$/.test(p)) {
      h.fake.calls.push({ method, path: fullPath, body: structuredClone(body) });
      if (fx.disconnectError) throw fail(fx.disconnectError.status, fx.disconnectError.message);
      dropEverywhere(body.user_id);
      return { ok: true };
    }
    if (method === 'POST' && /^\/servers\/[^/]+\/categories$/.test(p)) {
      h.fake.calls.push({ method, path: fullPath, body: structuredClone(body) });
      if (fx.categoryError) throw fail(fx.categoryError.status, fx.categoryError.message);
      const category = { id: uuid(6), name: body.name };
      fx.categories.push(category);
      return { category };
    }
    if (method === 'DELETE' && /^\/channels\/[^/]+$/.test(p)) {
      const id = p.split('/')[2];
      delete voiceSets()[id];
    }
    return base(method, fullPath, body);
  };
  return fx;
}

async function make({ apps = ['voice'], store, features, logChannel = LOG, keepClock } = {}) {
  const h = await createHarness({ apps, fakeClock: true, store, features });
  if (keepClock) h.clock.t = keepClock;
  const fx = addVoiceApi(h);
  h.engine.config.voiceMoveWaits = [0, 0];
  if (logChannel) h.engine.settings.patchCore(S, { logChannel });
  return { h, fx };
}

const cfg = (h) => h.engine.settings.appConfig(S, 'voice');
const rooms = (h) => Object.values(h.engine.store.get('voice', S, { rooms: {} }).rooms || {});
const voiceChannels = (h) => h.fake.state.channels[S].filter((c) => c.type === 'voice');
const inVoice = (h, cid) => [...(h.fake.state.voice[cid] || [])];
const lastText = (h, ans) => h.textOf(ans[ans.length - 1]);

async function setUp(h) {
  const ans = await h.slash('voice', 'setup', { user: IDS.admin });
  return { ans, createId: cfg(h).createChannelId };
}

async function makeRoom(h, user = IDS.member) {
  const createId = cfg(h).createChannelId;
  await h.voiceJoin(user, { channel: createId });
  const room = rooms(h).find((r) => r.ownerId === user);
  return room;
}

function panelMessage(h, room) {
  const msgs = h.fake.messagesIn(room.panel.channelId);
  return msgs.find((m) => m.id === room.panel.messageId) || null;
}

async function pressOnPanel(h, room, label, user) {
  const msg = panelMessage(h, room);
  return h.clickButton(label, { user, in: [msg], channel: room.panel.channelId, server: room.panel.dm ? null : S });
}

test('one command, short description, member tile and help', async () => {
  const { h } = await make();
  const c = h.bot.commands.get('voice');
  assert.ok(c, '/voice exists');
  assert.ok(c.description.length > 0 && c.description.length <= 100);
  const app = h.engine.apps.get('voice');
  assert.equal(app.def.panelPerm, 'member');
  assert.ok(app.def.help.length >= 2);
  assert.equal(app.meta.category, 'Community');
  assert.equal(app.meta.icon, '🔊');
});

test('names: the default room name fits and the checks catch bad names', () => {
  assert.equal(roomNameFor({ display_name: 'Sam' }), "Sam's room");
  const long = roomNameFor({ display_name: 'A'.repeat(60) });
  assert.ok(Array.from(long).length <= 32);
  assert.match(long, /'s room$/);
  assert.equal(roomNameFor(null), "Someone's room");
  assert.equal(checkName(null, S, 'Movie night').name, 'Movie night');
  assert.equal(checkName(null, S, '  Movie\n  night ').name, 'Movie night');
  assert.equal(checkName(null, S, 'x'.repeat(33)).ok, false);
  assert.equal(checkName(null, S, 'x'.repeat(32)).ok, true);
  assert.equal(checkName(null, S, '@everyone party').ok, false);
  assert.equal(checkName(null, S, 'join yapin.gg/invite/abc').ok, false);
  assert.equal(checkName(null, S, 'https://x.y').ok, false);
  assert.equal(checkName(null, S, '<@123> room').ok, false);
  assert.equal(checkName(null, S, '!!!').ok, false);
  assert.equal(checkName(null, S, '🎮🎮').ok, false);
  assert.equal(checkName(null, S, '🎮 Games 2').ok, true);
});

test('setup makes a "➕ Create room" voice channel, and running it again reuses it', async () => {
  const { h } = await make();
  const { ans, createId } = await setUp(h);
  assert.ok(createId, 'saved the create channel');
  const ch = h.fake.channelById(createId);
  assert.equal(ch.name, '➕ Create room');
  assert.equal(ch.type, 'voice');
  assert.match(lastText(h, ans), /Voice rooms are ready/);
  assert.match(lastText(h, ans), /by DM/);
  await h.slash('voice', 'setup', { user: IDS.admin });
  assert.equal(cfg(h).createChannelId, createId, 'same channel');
  assert.equal(voiceChannels(h).filter((c) => c.name === '➕ Create room').length, 1, 'no second channel');
  const jobs = h.engine.scheduler.list({ kind: 'voice.sweep', serverId: S });
  assert.equal(jobs.length, 1, 'a sweep is scheduled');
  assert.equal(jobs[0].repeat.everyMs, 10 * 60_000);
});

test('setup can pick an existing voice channel, and with "category" makes a category', async () => {
  const { h, fx } = await make();
  const ans = await h.slash('voice', 'setup Lounge', { user: IDS.admin });
  assert.equal(cfg(h).createChannelId, LOUNGE);
  assert.match(lastText(h, ans), /Using/);
  const missing = await h.slash('voice', 'setup Nowhere Hall', { user: IDS.admin });
  assert.match(lastText(h, missing), /couldn't find that voice channel/);
  assert.equal(cfg(h).createChannelId, LOUNGE);

  const { h: h2, fx: fx2 } = await make();
  const cat = await h2.slash('voice', 'setup category', { user: IDS.admin });
  assert.equal(fx2.categories.length, 1);
  assert.equal(fx2.categories[0].name, 'Voice rooms');
  const made = h2.fake.channelById(cfg(h2).createChannelId);
  assert.equal(made.category_id, fx2.categories[0].id);
  assert.equal(cfg(h2).categoryId, fx2.categories[0].id);
  assert.match(lastText(h2, cat), /category/);
  assert.equal(fx.categories.length, 0);
});

test('setup when the category fails still makes the channel and says so', async () => {
  const { h, fx } = await make();
  fx.categoryError = { status: 403, message: 'Missing permission' };
  const ans = await h.slash('voice', 'setup category', { user: IDS.admin });
  assert.ok(cfg(h).createChannelId);
  assert.match(lastText(h, ans), /couldn't make a \*\*Voice rooms\*\* category/);
});

test('members and mods cannot run setup or change settings', async () => {
  const { h } = await make();
  for (const user of [IDS.member, IDS.mod]) {
    const ans = await h.slash('voice', 'setup', { user });
    assert.match(lastText(h, ans), /Needs Admin|Only admins/);
  }
  assert.equal(cfg(h).createChannelId, null);
  const limit = await h.slash('voice', 'limit 5', { user: IDS.member });
  assert.match(lastText(h, limit), /Only admins/);
  assert.equal(cfg(h).maxRooms, 20);
  const panels = await h.slash('voice', 'panels here', { user: IDS.mod });
  assert.match(lastText(h, panels), /Only admins/);
  assert.equal(cfg(h).panelChannel, null);
});

test('joining the create channel makes a room, moves the person in and DMs the panel', async () => {
  const { h } = await make();
  const { createId } = await setUp(h);
  const room = await makeRoom(h);
  assert.ok(room, 'room saved');
  const ch = h.fake.channelById(room.id);
  assert.equal(ch.name, "Sam's room");
  assert.equal(ch.type, 'voice');
  assert.deepEqual(inVoice(h, room.id), [IDS.member], 'moved in');
  assert.deepEqual(inVoice(h, createId), []);
  const move = h.fake.callsTo('POST', /voice\/move/)[0];
  assert.deepEqual(move.body, { user_id: IDS.member, channel_id: room.id });
  assert.ok(room.panel?.dm, 'panel went by DM');
  const panel = panelMessage(h, room);
  assert.ok(panel);
  assert.equal(panel.channel_id, dmOf(IDS.member));
  const text = h.textOf(panel);
  for (const label of ['Rename', 'Lock', 'Hide', 'Kick someone', 'Transfer', 'Close room']) assert.match(text, new RegExp(label));
  assert.match(text, /Test Town/);
  assert.ok(panel.components.length <= 5);
  for (const r of panel.components) assert.ok(r.components.length <= 5);
  for (const b of h.allButtons([panel])) assert.ok(Buffer.byteLength(b.custom_id) <= 100, b.custom_id);
});

test('room goes in the same category as the create channel', async () => {
  const { h } = await make();
  await h.slash('voice', 'setup category', { user: IDS.admin });
  const room = await makeRoom(h);
  assert.equal(h.fake.channelById(room.id).category_id, cfg(h).categoryId);
});

test('with a panel channel the panel is posted there, mentions the owner and is open to press', async () => {
  const { h } = await make();
  await setUp(h);
  await h.slash('voice', 'panels #general', { user: IDS.admin });
  assert.equal(cfg(h).panelChannel, G);
  const room = await makeRoom(h);
  assert.equal(room.panel.channelId, G);
  assert.equal(room.panel.dm, false);
  const panel = panelMessage(h, room);
  assert.match(panel.content, new RegExp(`<@${IDS.member}>`));
  assert.equal(h.engine.router.panelOwner(panel.id), null, 'not engine-locked; the app checks the owner itself');
});

test('one room per person: joining the create channel again moves you back', async () => {
  const { h } = await make();
  const { createId } = await setUp(h);
  const room = await makeRoom(h);
  await h.voiceLeave(IDS.member, { channel: room.id });
  assert.equal(rooms(h).length, 0, 'empty room was deleted');
  const again = await makeRoom(h);
  h.fake.state.voice[again.id].add(IDS.member2);
  h.fake.state.voice[again.id].delete(IDS.member);
  await h.voiceJoin(IDS.member, { channel: createId });
  assert.equal(rooms(h).length, 1, 'still one room');
  assert.ok(inVoice(h, again.id).includes(IDS.member), 'moved back to their own room');
});

test('per-server cap: no room past the limit, explained once in the log channel', async () => {
  const { h } = await make();
  const { createId } = await setUp(h);
  await h.slash('voice', 'limit 1', { user: IDS.admin });
  await makeRoom(h, IDS.member);
  await h.voiceJoin(IDS.member2, { channel: createId });
  await h.voiceJoin(IDS.mod, { channel: createId });
  assert.equal(rooms(h).length, 1);
  assert.ok(inVoice(h, createId).includes(IDS.member2), 'left in the create channel');
  const logs = h.sent(LOG).filter((m) => /full/i.test(h.textOf(m)));
  assert.equal(logs.length, 1, 'logged once');
  assert.match(h.textOf(logs[0]), /\/voice limit/);
  const bad = await h.slash('voice', 'limit 99', { user: IDS.admin });
  assert.match(lastText(h, bad), /1 to 50/);
});

test('if making the room fails it is explained once in the log channel', async () => {
  const { h } = await make();
  const { createId } = await setUp(h);
  h.fake.fail('POST', /\/servers\/[^/]+\/channels$/, { status: 403, error: 'Missing permission' });
  await h.voiceJoin(IDS.member, { channel: createId });
  await h.voiceJoin(IDS.member2, { channel: createId });
  assert.equal(rooms(h).length, 0);
  const logs = h.sent(LOG);
  assert.equal(logs.length, 1, 'one explanation, not one per join');
  const text = h.textOf(logs[0]);
  assert.match(text, /Manage Channels/);
  assert.doesNotMatch(text, /403/);
});

test('if the move fails the room stays, the owner is told to click it, and the reason is logged', async () => {
  const { h, fx } = await make();
  const { createId } = await setUp(h);
  fx.moveError = { status: 403, message: 'Missing permission' };
  const before = voiceChannels(h).length;
  await h.voiceJoin(IDS.member, { channel: createId });
  assert.equal(rooms(h).length, 1, 'room kept so they can join it by hand');
  assert.equal(voiceChannels(h).length, before + 1);
  const room = rooms(h)[0];
  assert.equal(room.waiting, true);
  const panel = h.textOf(h.lastSent(dmOf(IDS.member)));
  assert.match(panel, /click/i);
  assert.match(panel, new RegExp(room.id));
  const log = h.textOf(h.lastSent(LOG));
  assert.match(log, /Move Members/);
  assert.equal(h.fake.callsTo('POST', /voice\/move/).length, 1, 'no retries on a permission error');
});

test('a move that fails at first is tried again', async () => {
  const { h } = await make();
  const { createId } = await setUp(h);
  const realApi = h.bot.api;
  let tries = 0;
  h.bot.api = async (method, p, body) => {
    if (method === 'POST' && /voice\/move$/.test(p) && ++tries < 3) { const e = new Error('not connected yet'); e.status = 400; throw e; }
    return realApi(method, p, body);
  };
  await h.voiceJoin(IDS.member, { channel: createId });
  assert.equal(tries, 3);
  const room = rooms(h)[0];
  assert.ok(room && !room.waiting);
  assert.deepEqual(inVoice(h, room.id), [IDS.member]);
});

test('a room waiting for its owner is not closed by an early leave event', async () => {
  const { h, fx } = await make();
  const { createId } = await setUp(h);
  fx.moveError = { status: 403, message: 'Missing permission' };
  await h.voiceJoin(IDS.member, { channel: createId });
  const room = rooms(h)[0];
  await h.voiceJoin(IDS.member, { channel: room.id });
  await h.voiceLeave(IDS.member);
  await settle();
  assert.equal(rooms(h).length, 1, 'still open during the first minute');
});

test('someone who leaves the create channel before the move just loses the room quietly', async () => {
  const { h } = await make();
  const { createId } = await setUp(h);
  const realApi = h.bot.api;
  h.bot.api = async (method, p, body) => {
    if (method === 'POST' && /voice\/move$/.test(p)) h.fake.state.voice[createId]?.delete(body.user_id);
    return realApi(method, p, body);
  };
  const before = voiceChannels(h).length;
  await h.voiceJoin(IDS.member, { channel: createId });
  assert.equal(rooms(h).length, 0);
  assert.equal(voiceChannels(h).length, before);
  assert.equal(h.sent(LOG).length, 0, 'nothing to explain');
});

test('the last person leaving deletes the room, its role and its panel', async () => {
  const { h } = await make();
  await setUp(h);
  const room = await makeRoom(h);
  await h.voiceJoin(IDS.member2, { channel: room.id });
  await h.slash('voice', 'lock', { user: IDS.member });
  const roleId = rooms(h)[0].roleId;
  assert.ok(roleId);
  await h.voiceLeave(IDS.member2, { channel: room.id });
  assert.equal(rooms(h).length, 1, 'still someone inside');
  await h.voiceLeave(IDS.member, { channel: room.id });
  assert.equal(rooms(h).length, 0);
  assert.equal(h.fake.channelById(room.id), null, 'channel deleted');
  assert.ok(!h.fake.state.roles[S].some((r) => r.id === roleId), 'room role deleted');
  assert.equal(panelMessage(h, room), null, 'panel deleted');
});

test('the owner leaving passes the room to someone still inside', async () => {
  const { h } = await make();
  await setUp(h);
  await h.slash('voice', 'panels #general', { user: IDS.admin });
  const room = await makeRoom(h);
  await h.voiceJoin(IDS.member2, { channel: room.id });
  await h.voiceLeave(IDS.member, { channel: room.id });
  await settle();
  const now = rooms(h)[0];
  assert.equal(now.ownerId, IDS.member2);
  const panel = panelMessage(h, now);
  assert.match(h.textOf(panel), new RegExp(`Owner: <@${IDS.member2}>`));
  assert.match(h.textOf(panel), /left, so/);
});

test('a move out of the room works in either event order', async () => {
  for (const order of ['join-first', 'leave-first']) {
    const { h } = await make();
    await setUp(h);
    const room = await makeRoom(h);
    if (order === 'join-first') {
      h.fake.state.voice[room.id].delete(IDS.member);
      await h.voiceJoin(IDS.member, { channel: LOUNGE });
      await h.voiceLeave(IDS.member, { channel: room.id });
    } else {
      await h.voiceLeave(IDS.member, { channel: room.id });
      await h.voiceJoin(IDS.member, { channel: LOUNGE });
    }
    assert.equal(rooms(h).length, 0, order);
    assert.equal(h.fake.channelById(room.id), null, order);
  }
});

test('a leave event that arrives while the voice list is behind still deletes the room', async () => {
  const { h } = await make();
  await setUp(h);
  const room = await makeRoom(h);
  await h.bot.handle({ id: 99999, type: 'voice_leave', data: { user_id: IDS.member, channel_id: room.id, server_id: S }, created_at: new Date().toISOString() });
  await settle();
  assert.equal(rooms(h).length, 0);
});

test('the panel only works for the owner and moderators', async () => {
  const { h } = await make();
  await setUp(h);
  await h.slash('voice', 'panels #general', { user: IDS.admin });
  const room = await makeRoom(h);
  const stranger = await pressOnPanel(h, room, 'Lock', IDS.member2);
  assert.match(lastText(h, stranger), /Not your room/);
  assert.equal(rooms(h)[0].locked, false);
  const close = await pressOnPanel(h, room, 'Close room', IDS.member2);
  assert.match(lastText(h, close), /Not your room/);
  const mod = await pressOnPanel(h, room, 'Lock', IDS.mod);
  assert.equal(rooms(h)[0].locked, true, 'mods may');
  assert.equal(mod[mod.length - 1].type, 'update', 'the panel updates in place');
  assert.match(h.textOf(panelMessage(h, room)), /Unlock/);
});

test('lock gives a room role to the owner and people inside; unlock opens the room and the role goes when it closes', async () => {
  const { h } = await make();
  await setUp(h);
  await h.slash('voice', 'panels #general', { user: IDS.admin });
  const room = await makeRoom(h);
  await h.voiceJoin(IDS.member2, { channel: room.id });
  await pressOnPanel(h, room, 'Lock', IDS.member);
  const locked = rooms(h)[0];
  assert.equal(locked.locked, true);
  const role = h.fake.state.roles[S].find((r) => r.id === locked.roleId);
  assert.ok(role, 'room role made');
  assert.match(role.name, /Sam's room/);
  for (const uid of [IDS.member, IDS.member2]) assert.ok(h.fake.memberOf(S, uid).roles.includes(role.id), 'role given');
  assert.ok(!h.fake.memberOf(S, IDS.mod).roles.includes(role.id), 'not to people outside');
  assert.deepEqual(h.fake.state.overrides[`${room.id}:everyone`], { allow: [], deny: ['connect'] });
  assert.deepEqual(h.fake.state.overrides[`${room.id}:${role.id}`], { allow: ['view_channel', 'connect'], deny: [] });
  const text = h.textOf(panelMessage(h, room));
  assert.match(text, /Locked/);

  await h.advance(3_000);
  await pressOnPanel(h, room, 'Unlock', IDS.member);
  const open = rooms(h)[0];
  assert.equal(open.locked, false);
  assert.equal(open.roleId, role.id, 'the role is kept while the room is open, so a relock costs no new grants');
  assert.equal(h.fake.state.overrides[`${room.id}:everyone`], undefined);
  await h.advance(3_000);
  const grantsBefore = h.fake.callsTo('PUT', /\/members\/[^/]+\/roles\//).length;
  await pressOnPanel(h, room, 'Lock', IDS.member);
  assert.equal(h.fake.callsTo('PUT', /\/members\/[^/]+\/roles\//).length, grantsBefore, 'nobody is given the role twice');
  assert.equal(h.fake.state.roles[S].filter((r) => /Sam's room/.test(r.name)).length, 1);
  await h.voiceLeave(IDS.member2, { channel: room.id });
  await h.voiceLeave(IDS.member, { channel: room.id });
  assert.ok(!h.fake.state.roles[S].some((r) => r.id === role.id), 'role removed with the room');
});

test('hide denies view_channel; hide plus lock denies both and keeps one role', async () => {
  const { h } = await make();
  await setUp(h);
  const room = await makeRoom(h);
  await h.slash('voice', 'hide', { user: IDS.member });
  assert.deepEqual(h.fake.state.overrides[`${room.id}:everyone`], { allow: [], deny: ['view_channel'] });
  const roleId = rooms(h)[0].roleId;
  const again = await h.slash('voice', 'hide', { user: IDS.member });
  assert.match(lastText(h, again), /Already hidden/);
  const tooSoon = await h.slash('voice', 'lock', { user: IDS.member });
  assert.match(lastText(h, tooSoon), /Slow down/);
  assert.equal(rooms(h)[0].locked, false);
  await h.advance(3_000);
  await h.slash('voice', 'lock', { user: IDS.member });
  assert.deepEqual(h.fake.state.overrides[`${room.id}:everyone`], { allow: [], deny: ['connect', 'view_channel'] });
  assert.equal(rooms(h)[0].roleId, roleId, 'same role reused');
  assert.equal(h.fake.state.roles[S].filter((r) => /Sam's room/.test(r.name)).length, 1);
  await h.advance(3_000);
  await h.slash('voice', 'show', { user: IDS.member });
  assert.deepEqual(h.fake.state.overrides[`${room.id}:everyone`], { allow: [], deny: ['connect'] });
  assert.equal(rooms(h)[0].roleId, roleId, 'still locked, so the role stays');
  await h.advance(3_000);
  const ok = await h.slash('voice', 'unlock', { user: IDS.member });
  assert.match(lastText(h, ok), /Room unlocked/);
  assert.equal(h.fake.state.overrides[`${room.id}:everyone`], undefined);
});

test('when the roles API is off, Lock and Hide show as unavailable with a plain reason', async () => {
  const { h } = await make({ features: { roles: false } });
  await setUp(h);
  await h.slash('voice', 'panels #general', { user: IDS.admin });
  const room = await makeRoom(h);
  const ans = await pressOnPanel(h, room, 'Lock', IDS.member);
  assert.equal(rooms(h)[0].locked, false);
  const text = lastText(h, ans);
  assert.match(text, /isn't available/);
  assert.match(text, /role management isn't turned on/);
  assert.doesNotMatch(text, /403|flag/);
  const view = await h.slash('voice', '', { user: IDS.member });
  const buttons = h.allButtons(view);
  const lock = buttons.find((b) => /^Lock/.test(b.label));
  assert.equal(lock.label, 'Lock (unavailable)');
  assert.equal(lock.disabled, true);
  assert.equal(buttons.find((b) => /^Hide/.test(b.label)).disabled, true);
  const typed = await h.slash('voice', 'hide', { user: IDS.member });
  assert.match(lastText(h, typed), /Hide isn't available here/);
});

test('when my role lacks Manage Roles, Lock explains that instead', async () => {
  const { h } = await make();
  await setUp(h);
  const room = await makeRoom(h);
  const botRole = h.fake.state.roles[S].find((r) => r.id === IDS.roles.bot);
  delete botRole.perms.manage_roles;
  h.engine.perms.invalidate();
  const ans = await h.slash('voice', 'lock', { user: IDS.member });
  assert.match(lastText(h, ans), /Manage Roles/);
  assert.equal(rooms(h)[0].locked, false);
  assert.equal(room.roleId, null);
});

test('rename through the form, with the 32 character limit and content rules', async () => {
  const { h } = await make();
  await setUp(h);
  await h.slash('voice', 'panels #general', { user: IDS.admin });
  const room = await makeRoom(h);
  const opened = await pressOnPanel(h, room, 'Rename', IDS.member);
  const modal = opened.find((a) => a.type === 'modal');
  assert.ok(modal, 'a form opens');
  const formId = modal.modal?.custom_id ?? modal.custom_id;
  const tooLong = await h.submit(formId, { name: 'x'.repeat(40) }, { user: IDS.member });
  assert.match(lastText(h, tooLong), /up to 32 characters/);
  const ping = await h.submit(formId, { name: '@everyone hi' }, { user: IDS.member });
  assert.match(lastText(h, ping), /This form expired/);
  await pressOnPanel(h, room, 'Rename', IDS.member);
  const pinged = await h.submit(formId, { name: '@everyone hi' }, { user: IDS.member });
  assert.match(lastText(h, pinged), /can't mention/);
  await pressOnPanel(h, room, 'Rename', IDS.member);
  const ok = await h.submit(formId, { name: 'Movie night' }, { user: IDS.member });
  assert.match(lastText(h, ok), /Room renamed/);
  assert.equal(h.fake.channelById(room.id).name, 'Movie night');
  assert.equal(rooms(h)[0].name, 'Movie night');
  await settle();
  assert.match(h.textOf(panelMessage(h, room)), /Movie night/);
  const soon = await h.slash('voice', 'rename Game time', { user: IDS.member });
  assert.match(lastText(h, soon), /Slow down/);
  const stranger = await pressOnPanel(h, room, 'Rename', IDS.member2);
  assert.match(lastText(h, stranger), /Not your room/);
  assert.ok(!stranger.some((a) => a.type === 'modal'));
});

test('rename respects the automod word filter when Automod is on', async () => {
  const { h } = await make({ apps: ['voice', 'automod'] });
  h.engine.settings.patchApp(S, 'automod', { words: { list: ['pineapple'] } });
  await setUp(h);
  await makeRoom(h);
  const bad = await h.slash('voice', 'rename Pineapple party', { user: IDS.member });
  assert.match(lastText(h, bad), /filters out/);
  const good = await h.slash('voice', 'rename Pizza party', { user: IDS.member });
  assert.match(lastText(h, good), /Room renamed/);
});

test('kick someone with the select menu', async () => {
  const { h } = await make();
  await setUp(h);
  await h.slash('voice', 'panels #general', { user: IDS.admin });
  const room = await makeRoom(h);
  await h.voiceJoin(IDS.member2, { channel: room.id });
  const pick = await pressOnPanel(h, room, 'Kick someone', IDS.member);
  const menu = h.allButtons(pick).find((b) => b.isSelect);
  assert.ok(menu, 'a select menu');
  assert.deepEqual(menu.options.map((o) => o.label), ['Riley']);
  const stranger = await h.pick(menu.custom_id, [IDS.member2], { user: IDS.member2 });
  assert.match(lastText(h, stranger), /Not your room/);
  const done = await h.pick(menu.custom_id, [IDS.member2], { user: IDS.member, messageId: pick[pick.length - 1].message?.id });
  assert.match(lastText(h, done), /Kicked/);
  assert.match(lastText(h, done), /join again/);
  assert.ok(!inVoice(h, room.id).includes(IDS.member2));
  assert.equal(h.fake.callsTo('POST', /voice\/disconnect/).length, 1);
  const gone = await h.pick(menu.custom_id, [IDS.member2], { user: IDS.member });
  assert.match(lastText(h, gone), /Already gone/);
});

test('kick falls back to buttons when select menus are off, and members cannot kick mods', async () => {
  const { h } = await make({ features: { selects: false } });
  await setUp(h);
  const room = await makeRoom(h);
  await h.voiceJoin(IDS.mod, { channel: room.id });
  await h.voiceJoin(IDS.member2, { channel: room.id });
  const view = await h.slash('voice', '', { user: IDS.member });
  const pick = await h.clickButton('Kick someone', { user: IDS.member, in: view });
  assert.ok(!h.allButtons(pick).some((b) => b.isSelect), 'no select menu');
  assert.ok(h.findButton('Riley', pick));
  const modBtn = h.findButton('Mo', pick);
  assert.ok(modBtn);
  const refused = await h.click(modBtn.custom_id, { user: IDS.member });
  assert.match(lastText(h, refused), /Can't kick a moderator/);
  assert.ok(inVoice(h, room.id).includes(IDS.mod));
  const ok = await h.click(h.findButton('Riley', pick).custom_id, { user: IDS.member });
  assert.match(lastText(h, ok), /Kicked/);
  const typedSelf = await h.slash('voice', 'kick @sam', { user: IDS.member });
  assert.match(lastText(h, typedSelf), /That's the owner/);
});

test('kicking someone from a locked room takes their room role away', async () => {
  const { h } = await make();
  await setUp(h);
  const room = await makeRoom(h);
  await h.voiceJoin(IDS.member2, { channel: room.id });
  await h.slash('voice', 'lock', { user: IDS.member });
  const roleId = rooms(h)[0].roleId;
  assert.ok(h.fake.memberOf(S, IDS.member2).roles.includes(roleId));
  const ans = await h.slash('voice', 'kick riley', { user: IDS.member });
  assert.match(lastText(h, ans), /can't come back in/);
  assert.ok(!h.fake.memberOf(S, IDS.member2).roles.includes(roleId));
});

test('a failed disconnect is explained in plain words', async () => {
  const { h, fx } = await make();
  await setUp(h);
  const room = await makeRoom(h);
  await h.voiceJoin(IDS.member2, { channel: room.id });
  fx.disconnectError = { status: 403, message: 'Missing permission' };
  const ans = await h.slash('voice', 'kick riley', { user: IDS.member });
  const text = lastText(h, ans);
  assert.match(text, /Move Members/);
  assert.doesNotMatch(text, /403/);
});

test('transfer hands the panel to someone inside; the old owner loses control', async () => {
  const { h } = await make();
  await setUp(h);
  await h.slash('voice', 'panels #general', { user: IDS.admin });
  const room = await makeRoom(h);
  const nobody = await pressOnPanel(h, room, 'Transfer', IDS.member);
  assert.match(lastText(h, nobody), /Nobody to give it to/);
  await h.voiceJoin(IDS.member2, { channel: room.id });
  const pick = await pressOnPanel(h, room, 'Transfer', IDS.member);
  const menu = h.allButtons(pick).find((b) => b.isSelect);
  const done = await h.pick(menu.custom_id, [IDS.member2], { user: IDS.member });
  assert.match(lastText(h, done), /Room transferred/);
  assert.equal(rooms(h)[0].ownerId, IDS.member2);
  const old = await pressOnPanel(h, room, 'Lock', IDS.member);
  assert.match(lastText(h, old), /Not your room/);
  await pressOnPanel(h, room, 'Lock', IDS.member2);
  assert.equal(rooms(h)[0].locked, true);
  h.fake.state.voice[room.id].delete(IDS.member);
  const notInside = await h.slash('voice', 'transfer @sam', { user: IDS.member2 });
  assert.match(lastText(h, notInside), /need to be in the room/);
});

test('transfer of a DM panel sends the new owner their own panel', async () => {
  const { h } = await make();
  await setUp(h);
  const room = await makeRoom(h);
  await h.voiceJoin(IDS.member2, { channel: room.id });
  const ans = await h.slash('voice', 'transfer riley', { user: IDS.member });
  assert.match(lastText(h, ans), /sent them the controls by DM/);
  const now = rooms(h)[0];
  assert.equal(now.panel.channelId, dmOf(IDS.member2));
  assert.equal(panelMessage(h, room), null, 'old DM panel removed');
  assert.ok(panelMessage(h, now));
});

test('nobody can be given a second room by transfer', async () => {
  const { h } = await make();
  await setUp(h);
  const a = await makeRoom(h, IDS.member);
  await makeRoom(h, IDS.member2);
  h.fake.state.voice[a.id].add(IDS.member2);
  const ans = await h.slash('voice', 'transfer riley', { user: IDS.member });
  assert.match(lastText(h, ans), /already have a room/);
  assert.equal(rooms(h).find((r) => r.id === a.id).ownerId, IDS.member);
});

test('panel buttons work from a DM for the owner', async () => {
  const { h } = await make();
  await setUp(h);
  const room = await makeRoom(h);
  assert.ok(room.panel.dm);
  const ans = await pressOnPanel(h, room, 'Hide', IDS.member);
  assert.equal(rooms(h)[0].hidden, true);
  assert.equal(ans[ans.length - 1].type, 'update');
  assert.match(h.textOf(panelMessage(h, room)), /Hidden/);
});

test('close asks first, then deletes the room; Keep it does nothing', async () => {
  const { h } = await make();
  await setUp(h);
  await h.slash('voice', 'panels #general', { user: IDS.admin });
  const room = await makeRoom(h);
  const ask = await pressOnPanel(h, room, 'Close room', IDS.member);
  assert.match(lastText(h, ask), /Close this room\?/);
  const keep = await h.clickButton('Keep it', { user: IDS.member, in: ask });
  assert.match(lastText(h, keep), /stays open/);
  assert.equal(rooms(h).length, 1);
  const ask2 = await pressOnPanel(h, room, 'Close room', IDS.member);
  const yes = await h.clickButton('Yes, close it', { user: IDS.member, in: ask2 });
  assert.match(lastText(h, yes), /Room closed/);
  assert.equal(rooms(h).length, 0);
  assert.equal(h.fake.channelById(room.id), null);
  assert.equal(panelMessage(h, room), null);
  const stale = await h.click(h.findButton('Lock', [h.fake.state.messages[G].find((m) => m.id === room.panel.messageId)]).custom_id, { user: IDS.member });
  assert.match(lastText(h, stale), /This room is closed/);
});

test('mods close any room by name; members cannot close someone else\'s', async () => {
  const { h } = await make();
  await setUp(h);
  const room = await makeRoom(h);
  const member = await h.slash('voice', "close Sam's room", { user: IDS.member2 });
  assert.match(lastText(h, member), /Not your room/);
  const missing = await h.slash('voice', 'close Pizza palace', { user: IDS.mod });
  assert.match(lastText(h, missing), /couldn't find that room/);
  const ask = await h.slash('voice', "close Sam's room", { user: IDS.mod });
  assert.match(lastText(h, ask), /Close this room\?/);
  await h.clickButton('Yes, close it', { user: IDS.mod, in: ask });
  assert.equal(rooms(h).length, 0);
  assert.equal(h.fake.channelById(room.id), null);
});

test('mods can list rooms; members cannot', async () => {
  const { h } = await make();
  await setUp(h);
  await makeRoom(h, IDS.member);
  await makeRoom(h, IDS.member2);
  const list = await h.slash('voice', 'rooms', { user: IDS.mod });
  assert.match(lastText(h, list), /Open voice rooms \(2\)/);
  assert.ok(h.findButton("Riley's room", list));
  const refused = await h.slash('voice', 'rooms', { user: IDS.member });
  assert.match(lastText(h, refused), /Only moderators/);
});

test('/voice opens your room, or explains how to get one', async () => {
  const { h } = await make();
  const notSet = await h.slash('voice', '', { user: IDS.member });
  assert.match(lastText(h, notSet), /aren't set up yet/);
  const { createId } = await setUp(h);
  const none = await h.slash('voice', '', { user: IDS.member });
  assert.match(lastText(h, none), new RegExp(`<#${createId}>`));
  await makeRoom(h);
  const mine = await h.slash('voice', '', { user: IDS.member });
  assert.ok(h.findButton('Close room', mine), 'room panel');
  const admin = await h.slash('voice', '', { user: IDS.admin });
  assert.match(lastText(h, admin), /Voice rooms/);
  assert.match(lastText(h, admin), /1 of 20/);
  const typo = await h.slash('voice', 'lokc', { user: IDS.member });
  assert.match(lastText(h, typo), /Did you mean \*\*lock\*\*/);
  const noRoom = await h.slash('voice', 'lock', { user: IDS.member2 });
  assert.match(lastText(h, noRoom), /don't have a room/);
});

test('the home screen tile opens the right view for each level', async () => {
  const { h } = await make();
  await setUp(h);
  const panel = h.engine.apps.get('voice').def.panel;
  const ctxFor = (user) => h.engine.contextFor({ server_id: S, channel_id: G, user_id: user, author_id: user, content: '', id: uuid(1) }, { app: 'voice' });
  await panel(ctxFor(IDS.member));
  assert.match(h.textOf(h.lastSent(G)), /don't have a room/);
  await panel(ctxFor(IDS.admin));
  assert.match(h.textOf(h.lastSent(G)), /Control panels/);
});

test('admin settings buttons: panels here, panels by DM, room limit form', async () => {
  const { h } = await make();
  await setUp(h);
  const view = await h.slash('voice', 'settings', { user: IDS.admin });
  const here = await h.clickButton('Panels here', { user: IDS.admin, in: view });
  assert.equal(cfg(h).panelChannel, G);
  assert.match(lastText(h, here), /Posted in/);
  await h.clickButton('Panels by DM', { user: IDS.admin, in: view });
  assert.equal(cfg(h).panelChannel, null);
  const form = await h.clickButton('Room limit', { user: IDS.admin, in: view });
  const modal = form.find((a) => a.type === 'modal');
  assert.ok(modal);
  const formId = modal.modal?.custom_id ?? modal.custom_id;
  await h.submit(formId, { limit: '7' }, { user: IDS.admin });
  assert.equal(cfg(h).maxRooms, 7);
  const sneaky = await h.click(h.findButton('Panels here', view).custom_id, { user: IDS.member });
  assert.match(lastText(h, sneaky), /Only admins/);
  const off = await h.slash('voice', 'off', { user: IDS.admin });
  assert.match(lastText(h, off), /Voice rooms are off/);
  assert.equal(cfg(h).createChannelId, null);
});

test('the sweep deletes rooms that emptied without an event, but not brand new ones', async () => {
  const { h } = await make();
  await setUp(h);
  const room = await makeRoom(h);
  h.fake.state.voice[room.id].clear();
  await h.advance(10 * 60_000);
  assert.equal(rooms(h).length, 0, 'empty room swept');
  assert.equal(h.fake.channelById(room.id), null);
  const job = h.engine.scheduler.list({ kind: 'voice.sweep', serverId: S })[0];
  h.clock.t = job.at - 30_000;
  const fresh = await makeRoom(h);
  h.fake.state.voice[fresh.id].clear();
  await h.advance(30_000);
  assert.equal(rooms(h).length, 1, 'too new to sweep');
  await h.advance(10 * 60_000);
  assert.equal(rooms(h).length, 0);
});

test('the sweep forgets rooms whose channel was deleted and notices a deleted create channel', async () => {
  const { h } = await make();
  const { createId } = await setUp(h);
  const room = await makeRoom(h);
  h.fake.state.channels[S] = h.fake.state.channels[S].filter((c) => c.id !== room.id && c.id !== createId);
  await h.advance(10 * 60_000);
  assert.equal(rooms(h).length, 0);
  assert.equal(cfg(h).createChannelId, null);
  assert.match(h.textOf(h.lastSent(LOG)), /was deleted/);
});

test('a channel_delete event for a room forgets it straight away', async () => {
  const { h } = await make();
  await setUp(h);
  const room = await makeRoom(h);
  await h.bot.handle({ id: 88888, type: 'channel_delete', data: { id: room.id, server_id: S, type: 'voice', name: room.name }, created_at: new Date().toISOString() });
  await settle();
  assert.equal(rooms(h).length, 0);
});

test('restart: empty or missing rooms are cleaned on startup, busy ones stay', async () => {
  const { h } = await make();
  await setUp(h);
  const empty = await makeRoom(h, IDS.member);
  const busy = await makeRoom(h, IDS.member2);
  await makeRoom(h, IDS.mod);
  h.engine.scheduler.stop();
  const store = h.store;
  const { h: h2 } = await make({ store, keepClock: h.clock.t + 5 * 60_000 });
  const keep = [empty, busy].map((r) => ({ ...h.fake.channelById(r.id) }));
  h2.fake.state.channels[S].push(...keep);
  h2.fake.state.channels[S].push({ ...h.fake.channelById(cfg(h).createChannelId) });
  h2.fake.state.voice[busy.id] = new Set([IDS.member2]);
  assert.equal(rooms(h2).length, 3, 'rooms survive the restart');
  await h2.advance(20_000);
  const left = rooms(h2);
  assert.deepEqual(left.map((r) => r.id), [busy.id], 'only the busy room is left');
  assert.equal(h2.fake.channelById(empty.id), null, 'empty room deleted');
  const after = await h2.slash('voice', 'lock', { user: IDS.member2 });
  assert.match(lastText(h2, after), /Room locked/);
});

test('turned off for a server: no rooms are made, busy rooms stay, empty ones are cleaned up and the sweep stops', async () => {
  const { h } = await make();
  const { createId } = await setUp(h);
  await h.slash('voice', 'panels #general', { user: IDS.admin });
  const room = await makeRoom(h);
  const busy = await makeRoom(h, IDS.mod);
  h.engine.settings.setEnabled(S, 'voice', false);
  await h.voiceJoin(IDS.member2, { channel: createId });
  assert.equal(rooms(h).length, 2, 'no new room while uninstalled');
  h.fake.state.voice[room.id].clear();
  await h.advance(11 * 60_000);
  assert.deepEqual(rooms(h).map((r) => r.id), [busy.id], 'the empty room is cleaned up, the busy one stays');
  assert.equal(h.fake.channelById(room.id), null);
  assert.equal(panelMessage(h, room), null, 'its panel is gone too');
  assert.equal(h.engine.scheduler.list({ kind: 'voice.sweep', serverId: S }).length, 1, 'still sweeping while a room is open');
  h.fake.state.voice[busy.id].clear();
  await h.advance(10 * 60_000);
  assert.equal(rooms(h).length, 0);
  assert.equal(h.engine.scheduler.list({ kind: 'voice.sweep', serverId: S }).length, 0, 'the sweep stops once nothing is left');
  assert.ok(cfg(h).createChannelId, 'settings are kept for when it is turned back on');
});

test('uninstalling cleans up rooms that are already empty within seconds', async () => {
  const { h } = await make();
  await setUp(h);
  const room = await makeRoom(h);
  await h.advance(5 * 60_000);
  h.fake.state.voice[room.id]?.clear();
  h.engine.settings.setEnabled(S, 'voice', false);
  await settle();
  await h.advance(2000);
  assert.equal(rooms(h).length, 0, 'no ten-minute wait');
  assert.equal(h.fake.channelById(room.id), null);
});
test('bounded: never more than the server cap, ids stay short', async () => {
  const { h } = await make();
  const { createId } = await setUp(h);
  await h.slash('voice', 'limit 3', { user: IDS.admin });
  const people = [IDS.member, IDS.member2, IDS.mod, IDS.admin];
  for (const uid of people) await h.voiceJoin(uid, { channel: createId });
  assert.equal(rooms(h).length, 3);
  for (const r of rooms(h)) assert.equal(r.key.length, 6);
  await wait(1);
});

test('review: locking never lifts room members above moderators', async () => {
  const { h } = await make({ apps: ['voice', 'mod'] });
  await setUp(h);
  const room = await makeRoom(h);
  await h.voiceJoin(IDS.member2, { channel: room.id });
  await h.slash('voice', 'lock', { user: IDS.member });
  const role = h.fake.state.roles[S].find((r) => r.id === rooms(h)[0].roleId);
  const modRole = h.fake.state.roles[S].find((r) => r.id === IDS.roles.mod);
  assert.ok(role.position < modRole.position, 'the room role sits at the bottom of the list');
  h.engine.perms.invalidate();
  assert.equal((await h.engine.perms.canActOn(S, IDS.member2, { actorId: IDS.mod })).ok, true);
  const t = await h.slash('mod', `timeout <@${IDS.member2}> 10m spam`, { user: IDS.mod });
  assert.doesNotMatch(lastText(h, t), /above yours/);
});

test('review: if the room role cannot be moved down, it is removed and Lock says why', async () => {
  const { h } = await make();
  await setUp(h);
  await makeRoom(h);
  h.fake.fail('PATCH', /\/roles\/[^/]+$/, { status: 403, error: 'Missing permission' });
  const ans = await h.slash('voice', 'lock', { user: IDS.member });
  assert.match(lastText(h, ans), /isn't available here/);
  assert.match(lastText(h, ans), /bottom of the role list/);
  assert.equal(rooms(h)[0].locked, false);
  assert.equal(rooms(h)[0].roleId, null);
  assert.ok(!h.fake.state.roles[S].some((r) => /Sam's room/.test(r.name)), 'no high room role is left behind');
  assert.ok(!h.fake.memberOf(S, IDS.member).roles.some((r) => !Object.values(IDS.roles).includes(r)));
});

test('review: a forged kick or transfer never touches people outside the room, even when the voice list leaves it out', async () => {
  const { h } = await make();
  await setUp(h);
  const room = await makeRoom(h);
  await h.slash('voice', 'hide', { user: IDS.member });
  await h.voiceJoin(IDS.member2, { channel: LOUNGE });
  const real = h.bot.voice.bind(h.bot);
  h.bot.voice = async (sid) => (await real(sid)).filter((v) => v.channel_id !== room.id);
  const kick = await h.click(`yo:voice:kickp:${S}:${room.key}:${IDS.member2}`, { user: IDS.member });
  assert.match(lastText(h, kick), /can't see who's inside/);
  assert.ok(inVoice(h, LOUNGE).includes(IDS.member2), 'still in the lounge');
  assert.equal(h.fake.callsTo('POST', /voice\/disconnect/).length, 0);
  const give = await h.click(`yo:voice:xferp:${S}:${room.key}:${IDS.member2}`, { user: IDS.member });
  assert.match(lastText(h, give), /need to be in the room/);
  assert.equal(rooms(h)[0].ownerId, IDS.member);
  h.bot.voice = real;
  const outside = await h.click(`yo:voice:kickp:${S}:${room.key}:${IDS.member2}`, { user: IDS.member });
  assert.match(lastText(h, outside), /Already gone/);
  assert.ok(inVoice(h, LOUNGE).includes(IDS.member2));
});

test('review: when the voice list only shows busy channels, empty rooms still close on leave and in the sweep', async () => {
  const { h } = await make();
  await setUp(h);
  const real = h.bot.voice.bind(h.bot);
  h.bot.voice = async (sid) => (await real(sid)).filter((v) => v.user_ids.length);
  const a = await makeRoom(h, IDS.member);
  await h.voiceLeave(IDS.member, { channel: a.id });
  assert.equal(h.fake.channelById(a.id), null, 'closed on the last leave');
  const b = await makeRoom(h, IDS.member2);
  h.fake.state.voice[b.id].clear();
  await h.advance(10 * 60_000);
  assert.equal(h.fake.channelById(b.id), null, 'closed by the sweep');
  assert.equal(rooms(h).length, 0);
});

test('review: default room names follow the same rules as renames', async () => {
  const { h } = await make({ apps: ['voice', 'automod'] });
  h.engine.settings.patchApp(S, 'automod', { words: { list: ['pineapple'] } });
  const { createId } = await setUp(h);
  h.fake.memberOf(S, IDS.member).display_name = 'pineapple king';
  h.fake.memberOf(S, IDS.member2).display_name = 'join yapin.gg/x';
  h.engine.perms.invalidate();
  await h.voiceJoin(IDS.member, { channel: createId });
  await h.voiceJoin(IDS.member2, { channel: createId });
  const names = rooms(h).map((r) => h.fake.channelById(r.id).name);
  assert.deepEqual(names, ['Voice room', 'Voice room']);
  assert.equal(roomNameFor({ display_name: 'Sam' }), "Sam's room");
});

test('a new room lands in the Create room category even when Yapin drops it on create', async () => {
  const { h } = await make();
  const { createId } = await setUp(h);
  const VC = uuid(7);
  h.fake.state.channels[S].find((c) => c.id === createId).category_id = VC;
  const base = h.bot.api;
  h.bot.api = async (method, fullPath, body) => {
    if (method === 'POST' && /^\/servers\/[^/]+\/channels$/.test(fullPath)) {
      const out = await base(method, fullPath, { ...body, category_id: undefined });
      return out;
    }
    return base(method, fullPath, body);
  };
  const room = await makeRoom(h);
  assert.ok(room, 'room made');
  const made = h.fake.state.channels[S].find((c) => c.id === room.id);
  assert.equal(made.category_id, VC);
  const edits = h.fake.calls.filter((c) => c.method === 'PATCH' && c.path === `/channels/${room.id}`);
  assert.equal(edits.length, 1);
});

test('a new room that already landed in its category is not edited again', async () => {
  const { h } = await make();
  const { createId } = await setUp(h);
  h.fake.state.channels[S].find((c) => c.id === createId).category_id = uuid(8);
  const room = await makeRoom(h);
  assert.ok(room);
  assert.equal(h.fake.calls.filter((c) => c.method === 'PATCH' && c.path === `/channels/${room.id}`).length, 0);
});
