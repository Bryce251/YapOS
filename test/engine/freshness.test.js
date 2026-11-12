import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS, eventStamp } from '../harness.js';
import { createFreshness, eventTime, LATE_MS } from '../../engine/freshness.js';
import { customId } from '../../engine/router.js';

const S = IDS.server;
const G = IDS.channels.general;
const HOURS = 3 * 60 * 60_000;

function giveModBan(h) {
  h.fake.state.roles[S].find((r) => r.id === IDS.roles.mod).perms.ban_members = true;
}

function modStub() {
  return {
    addCase: async () => ({ id: 1 }),
    warn: async () => ({ case: { id: 1 }, count: 1, escalated: null }),
    timeout: async () => ({ id: 1 }),
    log: async () => {},
  };
}

const raider = (i, tag = 3) => `a0000000-0000-4000-8000-000000000${tag}${String(i).padStart(2, '0')}`;

test('default window is two minutes and event age reads the envelope first', () => {
  assert.equal(LATE_MS, 120_000);
  assert.equal(eventTime({ created_at: '2026-11-01T00:00:00.000Z', data: { created_at: '2020-01-01T00:00:00.000Z' } }), Date.parse('2026-11-01T00:00:00.000Z'));
  assert.equal(eventTime({ data: { created_at: '2026-11-01T00:00:00.000Z' } }), Date.parse('2026-11-01T00:00:00.000Z'));
  assert.equal(eventTime({ data: {} }), null);
  assert.equal(eventTime({ created_at: 'nonsense' }), null);
});

test('events without a time and events from the future count as fresh', () => {
  const f = createFreshness({ bot: { commands: new Map(), prefixes: ['/', '!'] }, now: () => 1_000_000 });
  assert.equal(f.isLate({ type: 'message', data: {} }), false);
  assert.equal(f.isLate({ type: 'message', created_at: new Date(2_000_000).toISOString() }), false);
  assert.equal(f.isLate({ type: 'message', created_at: new Date(1_000_000 - 120_000).toISOString() }), false);
  assert.equal(f.isLate({ type: 'message', created_at: new Date(1_000_000 - 120_001).toISOString() }), true);
});

test('harness events carry a fresh created_at by default and can be made late', async () => {
  const seen = [];
  const h = await createHarness({ apps: [] });
  const original = h.bot.handle;
  h.bot.handle = async (ev) => { seen.push(ev); return original(ev); };
  await h.message('hello');
  await h.join(IDS.member2, { lateBy: HOURS });
  const now = Date.now();
  assert.ok(Math.abs(now - Date.parse(seen[0].created_at)) < 5000);
  assert.ok(Math.abs(now - HOURS - Date.parse(seen[1].created_at)) < 5000);
  assert.equal(eventStamp({ createdAt: '2026-01-01T00:00:00.000Z' }), '2026-01-01T00:00:00.000Z');
});

test('a fresh typed !ban runs', async () => {
  const h = await createHarness({ apps: ['mod'] });
  giveModBan(h);
  await h.message(`!ban <@${IDS.member}> raiding`, { user: IDS.mod });
  assert.equal(h.fake.state.bans[S].length, 1);
  assert.equal(h.engine.freshness.skipped.commands, 0);
});

test('a typed !ban from three hours ago is skipped and logged once per wake-up', async () => {
  const h = await createHarness({ apps: ['mod'] });
  giveModBan(h);
  const seen = [];
  h.bot.on('message', (m) => seen.push(m));
  await h.message(`!ban <@${IDS.member}> raiding`, { user: IDS.mod, lateBy: HOURS });
  await h.message(`!kick <@${IDS.member2}>`, { user: IDS.mod, lateBy: HOURS - 1000 });
  assert.equal(h.fake.state.bans[S].length, 0);
  assert.ok(h.fake.memberOf(S, IDS.member2), 'not kicked');
  assert.equal(h.engine.freshness.skipped.commands, 2);
  assert.equal(seen.length, 2, 'late messages still reach message listeners');
  assert.ok(seen.every((m) => m.yaposLate === true && !m.command));
  assert.equal(h.sent(G).length, 0, 'no late replies in chat');
  assert.equal(h.lines.filter((l) => /asleep/.test(l)).length, 0, 'not logged until the wake-up ends');
  await h.message('morning all', { user: IDS.member });
  const logged = h.lines.filter((l) => /asleep/.test(l));
  assert.equal(logged.length, 1);
  assert.match(logged[0], /Skipped 2 old commands from while I was asleep/);
  assert.equal(h.engine.freshness.lastWake.commands, 2);
  await h.message('another fresh one', { user: IDS.member });
  assert.equal(h.lines.filter((l) => /asleep/.test(l)).length, 1, 'only once');
  await h.message(`!ban <@${IDS.member}> raiding`, { user: IDS.mod });
  assert.equal(h.fake.state.bans[S].length, 1, 'the same command works when fresh');
});

test('late plain messages flow on, marked late', async () => {
  const h = await createHarness({ apps: [] });
  const seen = [];
  h.bot.on('message', (m) => seen.push(m));
  await h.message('just chatting', { lateBy: HOURS });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].yaposLate, true);
  assert.equal(seen[0].content, 'just chatting');
  assert.equal(h.engine.freshness.skipped.commands, 0);
  assert.equal(h.engine.freshness.lateEvents, 1);
});

test('a late slash command is answered privately and not run', async () => {
  const h = await createHarness({ apps: ['mod'] });
  giveModBan(h);
  const ans = await h.slash('ban', '@sam raiding', { user: IDS.mod, lateBy: HOURS });
  assert.equal(h.fake.state.bans[S].length, 0);
  assert.equal(ans.length, 1);
  assert.equal(ans[0].type, 'ephemeral');
  assert.equal(h.textOf(ans[0]), "I was offline when you sent this, so I didn't run it. Please run /ban again.");
  assert.equal(h.engine.freshness.skipped.slash, 1);
  const fresh = await h.slash('ban', '@sam raiding', { user: IDS.mod });
  assert.equal(h.fake.state.bans[S].length, 1);
  assert.match(h.textOf(fresh[fresh.length - 1]), /Banned/);
});

test('a late click, pick or form is answered privately and its handler does not run', async () => {
  const h = await createHarness({ apps: [] });
  let runs = 0;
  h.engine.router.register('system', 'probe', { run: async (ctx) => { runs++; await ctx.ack(); } });
  const id = customId('system', 'probe');
  const late = await h.click(id, { user: IDS.member, lateBy: HOURS });
  assert.equal(runs, 0);
  assert.equal(late.length, 1);
  assert.equal(late[0].type, 'ephemeral');
  assert.equal(h.textOf(late[0]), 'That button press reached me late (I was offline). Please press it again.');
  const latePick = await h.pick(id, ['a'], { lateBy: HOURS });
  assert.match(h.textOf(latePick[0]), /press it again/);
  const lateForm = await h.submit(id, { text: 'hi' }, { lateBy: HOURS });
  assert.match(h.textOf(lateForm[0]), /form reached me late/);
  assert.equal(runs, 0);
  assert.equal(h.engine.freshness.skipped.clicks, 3);
  await h.click(id, { user: IDS.member });
  assert.equal(runs, 1);
  const logged = h.lines.filter((l) => /asleep/.test(l));
  assert.equal(logged.length, 1);
  assert.match(logged[0], /Skipped 3 old button presses from while I was asleep/);
});

test('late joins and leaves carry yaposLate', async () => {
  const h = await createHarness({ apps: [] });
  const joins = [];
  const leaves = [];
  h.bot.on('member_join', (ev) => joins.push(ev));
  h.bot.on('member_leave', (ev) => leaves.push(ev));
  await h.join(raider(1), { lateBy: HOURS });
  await h.join(raider(2));
  await h.leave(raider(1), { lateBy: HOURS });
  assert.equal(joins[0].yaposLate, true);
  assert.equal(joins[1].yaposLate, undefined);
  assert.equal(leaves[0].yaposLate, true);
});

test('the raid shield ignores late joins but still counts fresh ones', async () => {
  const h = await createHarness({ apps: ['automod'] });
  h.engine.services.set('mod', modStub());
  await h.slash('automod', 'raid on', { user: IDS.admin });
  for (let i = 0; i < 20; i++) await h.join(raider(i, 3), { username: `sleeper${i}`, lateBy: HOURS });
  assert.notEqual(h.fake.state.everyone[S].send_messages, false, 'late joins never lock the server');
  for (let i = 0; i < 9; i++) await h.join(raider(i, 4), { username: `raider${i}` });
  assert.equal(h.fake.state.everyone[S].send_messages, false, 'fresh joins still trip it');
});

test('late DMs that look like commands are skipped, other late DMs pass marked', async () => {
  const h = await createHarness({ apps: [] });
  const seen = [];
  h.bot.on('dm_message', (m) => seen.push(m));
  await h.dm('!remind 10m stretch', { lateBy: HOURS });
  await h.dm('help', { lateBy: HOURS });
  await h.dm('thanks for the reminder', { lateBy: HOURS });
  await h.dm('fresh hello');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].content, 'thanks for the reminder');
  assert.equal(seen[0].yaposLate, true);
  assert.equal(seen[1].yaposLate, undefined);
  assert.equal(h.engine.freshness.skipped.dms, 2);
});

test('the late window can be changed for tests and stats are kept', async () => {
  const h = await createHarness({ apps: ['mod'], freshness: { lateMs: 1000 } });
  giveModBan(h);
  await h.slash('ban', '@sam', { user: IDS.mod, lateBy: 5000 });
  assert.equal(h.fake.state.bans[S].length, 0);
  const stats = h.engine.freshness.stats();
  assert.equal(stats.lateMs, 1000);
  assert.equal(stats.skipped.slash, 1);
  assert.ok(stats.pending);
  const done = h.engine.freshness.flush();
  assert.equal(done.slash, 1);
  assert.equal(h.engine.freshness.stats().lastWake.slash, 1);
  assert.equal(h.engine.freshness.stats().pending, null);
});

test('mocked clocks do not make harness events look late', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-07T12:00:00Z') });
  try {
    const h = await createHarness({ apps: ['mod'] });
    giveModBan(h);
    mock.timers.tick(HOURS);
    await h.slash('ban', '@sam', { user: IDS.mod });
    assert.equal(h.fake.state.bans[S].length, 1);
    assert.equal(h.engine.freshness.lateEvents, 0);
  } finally {
    mock.timers.reset();
  }
});
