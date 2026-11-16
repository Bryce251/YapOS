import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { inviteText, digestText, sendDigest } from '../../apps/party.js';

const G = IDS.channels.general;
const LOUNGE = IDS.channels.voice;
const START = Date.parse('2026-11-07T12:00:00Z');
const dmOf = (user) => `d${user.slice(1)}`;

async function make(opts = {}) {
  const h = await createHarness({ apps: ['party'], fakeClock: true, ...opts });
  h.clock.t = START;
  return h;
}

const invites = (h) => h.sent(G).filter((m) => /A YapOS Party is on/.test(h.textOf(m)));
const stubReports = (h, n) => Object.defineProperty(h.engine.dashboard, 'reportsOpen', { value: n, configurable: true, writable: true });

test('party: the invite and digest texts read right', () => {
  assert.equal(inviteText('abc'), '🎉 A YapOS Party is on in <#abc>! Join the call, then open **Activities → YapOS Party**.');
  assert.equal(digestText(3), 'You have 3 open YapOS Party reports: https://yapos.dev/party/reports');
  assert.equal(digestText(1), 'You have 1 open YapOS Party report: https://yapos.dev/party/reports');
  for (const none of [0, -2, undefined, null, 'x', NaN]) assert.equal(digestText(none), null);
});

test('party: /party posts a button-free invite for the voice channel you are in', async () => {
  const h = await make();
  await h.voiceJoin(IDS.member);
  const ans = await h.slash('party', '', { user: IDS.member });
  const posted = invites(h);
  assert.equal(posted.length, 1);
  assert.match(h.textOf(posted[0]), new RegExp(`<#${LOUNGE}>`));
  assert.match(h.textOf(posted[0]), /Activities → YapOS Party/);
  assert.match(h.textOf(posted[0]), new RegExp(`<@${IDS.member}>`));
  assert.ok(!(posted[0].components || []).length, 'no buttons');
  assert.equal(ans[0].type, 'ephemeral');
  assert.match(h.textOf(ans[0]), /Invite posted/);
});

test('party: not in voice gets a kind refusal and nothing is posted', async () => {
  const h = await make();
  const ans = await h.slash('party', '', { user: IDS.member });
  assert.match(h.textOf(ans[0]), /not in a voice channel/i);
  assert.match(h.textOf(ans[0]), /\/party Lounge/);
  assert.equal(invites(h).length, 0);
});

test('party: you can name a voice channel instead, and a wrong name is explained', async () => {
  const h = await make();
  await h.slash('party', 'lounge', { user: IDS.member });
  assert.equal(invites(h).length, 1);
  assert.match(h.textOf(invites(h)[0]), new RegExp(`<#${LOUNGE}>`));
  const bad = await h.slash('party', 'nowhere-at-all', { user: IDS.member2 });
  assert.match(h.textOf(bad[0]), /couldn't find that voice channel/);
  const text = await h.slash('party', '#general', { user: IDS.member2 });
  assert.match(h.textOf(text[0]), /couldn't find that voice channel/);
  assert.equal(invites(h).length, 1);
});

test('party: one invite per voice channel every 10 minutes', async () => {
  const h = await make();
  await h.voiceJoin(IDS.member);
  await h.voiceJoin(IDS.member2);
  await h.slash('party', '', { user: IDS.member });
  const again = await h.slash('party', '', { user: IDS.member2 });
  assert.match(h.textOf(again[0]), /Already invited/);
  assert.match(h.textOf(again[0]), /10 minutes/);
  assert.equal(invites(h).length, 1);
  h.clock.t += 9 * 60_000;
  const soon = await h.slash('party', '', { user: IDS.member2 });
  assert.match(h.textOf(soon[0]), /1 minute\b/);
  h.clock.t += 60_000;
  await h.slash('party', '', { user: IDS.member2 });
  assert.equal(invites(h).length, 2);
});

test('party: if I cannot look up voice, I ask for the channel name', async () => {
  const h = await make();
  const base = h.bot.api;
  h.bot.api = async (method, fullPath, body) => {
    if (method === 'GET' && /\/voice$/.test(fullPath.split('?')[0])) { const e = new Error('Voice is in testing'); e.status = 403; throw e; }
    return base.call(h.bot, method, fullPath, body);
  };
  const ans = await h.slash('party', '', { user: IDS.member });
  assert.match(h.textOf(ans[0]), /can't see who's in voice/);
  assert.equal(invites(h).length, 0);
});

test('party: a failed post does not start the cooldown', async () => {
  const h = await make();
  await h.voiceJoin(IDS.member);
  const send = h.engine.budget.send;
  h.engine.budget.send = async () => { const e = new Error('Missing permissions'); e.status = 403; throw e; };
  await h.slash('party', '', { user: IDS.member });
  h.engine.budget.send = send;
  await h.slash('party', '', { user: IDS.member });
  assert.equal(invites(h).length, 1);
});

test('party: the daily report digest is scheduled for 18:00 UTC and DMs the owner only when reports are open', async () => {
  const h = await make();
  const jobs = h.engine.scheduler.list({ kind: 'party.digest' });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].at, Date.parse('2026-11-07T18:00:00Z'));
  assert.equal(jobs[0].serverId, null);

  stubReports(h, 0);
  await h.advanceTo(Date.parse('2026-11-07T18:00:05Z'));
  assert.equal(h.sent(dmOf(IDS.owner)).length, 0);

  stubReports(h, 4);
  await h.advanceTo(Date.parse('2026-11-08T18:00:05Z'));
  const dms = h.sent(dmOf(IDS.owner));
  assert.equal(dms.length, 1);
  assert.equal(h.textOf(dms[0]), 'You have 4 open YapOS Party reports: https://yapos.dev/party/reports');
  assert.equal(h.sent(dmOf(IDS.admin)).length, 0);

  await sendDigest(h.engine);
  await h.settle();
  assert.equal(h.sent(dmOf(IDS.owner)).length, 1, 'only one digest a day');
  assert.equal(h.engine.scheduler.list({ kind: 'party.digest' })[0].at, Date.parse('2026-11-09T18:00:00Z'));
});

test('party: a restart keeps the one digest job', async () => {
  const h = await make();
  const h2 = await createHarness({ apps: ['party'], fakeClock: true, store: h.store });
  assert.equal(h2.engine.scheduler.list({ kind: 'party.digest' }).length, 1);
});

test('party: the digest copes with a missing reports count', async () => {
  const h = await make();
  stubReports(h, undefined);
  await sendDigest(h.engine);
  await h.settle();
  assert.equal(h.sent(dmOf(IDS.owner)).length, 0);
});

test('party: the panel and /party help explain how to start a party', async () => {
  const h = await make();
  const ans = await h.slash('party', 'help', { user: IDS.member });
  assert.match(h.textOf(ans[0]), /Activities → YapOS Party/);
  assert.equal(invites(h).length, 0);
  const tile = await h.click('yo:system:open:party', { user: IDS.member });
  assert.match(h.textOf(tile[tile.length - 1]), /Join a voice channel/);
});

test('party: one person can post one invite every 2 minutes, even across voice channels', async () => {
  const h = await make();
  const STAGE = 'c0000000-0000-4000-8000-0000000000f1';
  h.fake.state.channels[IDS.server].push({ id: STAGE, name: 'Stage', type: 'voice', kind: 'voice', server_id: IDS.server, position: 9, category: null, category_id: null, private: false, read_only: false, slowmode: 0 });
  await h.slash('party', 'lounge', { user: IDS.member });
  const next = await h.slash('party', 'stage', { user: IDS.member });
  assert.match(h.textOf(next[0]), /One invite at a time/);
  assert.equal(invites(h).length, 1);
  await h.slash('party', 'stage', { user: IDS.member2 });
  assert.equal(invites(h).length, 2);
  h.clock.t += 2 * 60_000;
  const later = await h.slash('party', 'lounge', { user: IDS.member });
  assert.match(h.textOf(later[0]), /Already invited/);
});
