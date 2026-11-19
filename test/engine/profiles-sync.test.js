import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { profileSync, dropProfileSync, syncProfiles, PROFILES_PER_POST } from '../../engine/profiles-sync.js';
import { privacyOf, setPrivacy } from '../../engine/profile-data.js';
import { mutateGlobal, SEASON_NS } from '../../engine/global.js';

const S = IDS.server;
const MIN = 60_000;
const START = Date.parse('2026-11-15T12:00:00Z');

function fakeWorker() {
  const w = { profiles: [], acks: [], status: [] };
  w.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    const status = w.status.length ? w.status.shift() : 200;
    if (path === '/bot/profiles') w.profiles.push(body);
    if (path === '/bot/party/ack') w.acks.push(body);
    return { ok: status === 200, status, text: async () => '{"ok":true}' };
  };
  return w;
}

async function make() {
  const h = await createHarness({ apps: ['levels', 'economy', 'quests', 'profile'], fakeClock: true });
  h.clock.t = START;
  h.engine.config.dashboardUrl = 'https://yapos.test';
  h.engine.config.dashboardSecret = 'test-secret';
  const w = fakeWorker();
  dropProfileSync(h.engine);
  const sync = profileSync(h.engine, { fetch: w.fetch, now: h.now });
  sync.install();
  return { h, w, sync };
}

test('profiles-sync: people active lately get a public snapshot in the agreed shape', async () => {
  const { h, w, sync } = await make();
  h.engine.clans = { getClanOf: (id) => (id === IDS.member ? { name: 'Night Owls', tag: 'OWL', colour: '#F1C40F' } : null) };
  mutateGlobal(h.engine, SEASON_NS, (d) => { d.badges = { [IDS.member]: [{ month: '2026-10', kind: 'xp', rank: 2, score: 900 }] }; }, {});
  h.engine.service('levels').addXp(S, IDS.member, 500, 'test');
  h.engine.service('economy').add(S, IDS.member, 300, 'test');
  await h.message('hello there', { user: IDS.member });
  await h.message('hi', { user: IDS.member2 });
  const r = await sync.push();
  assert.equal(r.sent, 2);
  assert.equal(w.profiles.length, 1);
  const sam = w.profiles[0].profiles.find((p) => p.id === IDS.member);
  assert.deepEqual(Object.keys(sam).sort(), ['achievements', 'avatar_url', 'badges', 'clan', 'hidden', 'id', 'level', 'name', 'season', 'shards', 'username', 'xp']);
  assert.equal(sam.avatar_url, null, 'a person with no Yapin picture is sent as null so the site shows initials');
  assert.equal(sam.name, 'sam');
  assert.equal(sam.username, 'sam');
  assert.ok(sam.level >= 1 && sam.xp >= 500);
  assert.equal(sam.shards, null, 'Shards stay off until the person opts in');
  assert.deepEqual(sam.season, [{ month: '2026-10', rank: 2, kind: 'xp' }]);
  assert.deepEqual(sam.clan, { name: 'Night Owls', tag: 'OWL', colour: '#f1c40f' });
  assert.equal(sam.hidden, false);
  assert.ok(!JSON.stringify(w.profiles).includes(S), 'servers are never sent');
});

test('profiles-sync: Shards show only after opting in, and hidden profiles send almost nothing', async () => {
  const { h, w, sync } = await make();
  h.engine.service('economy').add(S, IDS.member, 300, 'test');
  setPrivacy(h.engine, IDS.member, { showShards: true });
  setPrivacy(h.engine, IDS.member2, { hidden: true });
  sync.note(IDS.member, { username: 'sam', display_name: 'Sam' });
  sync.note(IDS.member2, { username: 'riley', display_name: 'Riley' });
  await sync.push();
  const [sam, riley] = [IDS.member, IDS.member2].map((id) => w.profiles[0].profiles.find((p) => p.id === id));
  assert.ok(sam.shards >= 300);
  assert.equal(riley.hidden, true);
  assert.equal(riley.level, 0);
  assert.equal(riley.shards, null);
  assert.deepEqual(riley.season, []);
});

test('profiles-sync: uploads go in batches of at most 50 and only repeat after new activity', async () => {
  const { h, w, sync } = await make();
  for (let i = 0; i < 120; i++) sync.note(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, { username: `u${i}` });
  await sync.push();
  assert.equal(PROFILES_PER_POST, 50);
  assert.deepEqual(w.profiles.map((b) => b.profiles.length), [50, 50, 20]);
  await sync.push();
  assert.equal(w.profiles.length, 3, 'nobody new to send');
  h.clock.t += 11 * MIN;
  sync.note('00000000-0000-4000-8000-000000000001', { username: 'u1' });
  await sync.push();
  assert.equal(w.profiles.length, 4);
  assert.deepEqual(w.profiles[3].profiles.map((p) => p.id), ['00000000-0000-4000-8000-000000000001']);
});

test('profiles-sync: a failed upload is tried again next time', async () => {
  const { w, sync } = await make();
  sync.note(IDS.member, { username: 'sam' });
  w.status.push(503);
  await sync.push();
  await sync.push();
  assert.equal(w.profiles.length, 2);
  assert.equal(w.profiles[1].profiles[0].id, IDS.member);
});

test('profiles-sync: visibility changes from yapos.dev are applied, acked and pushed', async () => {
  const { h, w, sync } = await make();
  const r = await syncProfiles(h.engine, { jobs: [], profileSettings: [{ user: IDS.member, hidden: true, showShards: true }, { user: 'bad id!', hidden: true }, 'junk'] });
  assert.equal(r.applied, 1);
  assert.deepEqual(privacyOf(h.engine, IDS.member), { hidden: true, showShards: true });
  assert.deepEqual(w.acks, [{ profileIds: [IDS.member] }]);
  await sync.push();
  assert.equal(w.profiles[0].profiles[0].id, IDS.member);
  assert.equal(w.profiles[0].profiles[0].hidden, true);
  await syncProfiles(h.engine, { party: { profileSettings: [{ user: IDS.member, hidden: false }] } });
  assert.equal(privacyOf(h.engine, IDS.member).hidden, false);
  assert.deepEqual(await syncProfiles(h.engine, { jobs: [] }), { applied: 0, acked: 0 });
  assert.deepEqual(await syncProfiles(h.engine, null), { applied: 0, acked: 0 });
});

test('profiles-sync: a failed ack is sent again with the next poll', async () => {
  const { h, w } = await make();
  w.status.push(500);
  const first = await syncProfiles(h.engine, { profileSettings: [{ user: IDS.member, hidden: true }] });
  assert.equal(first.acked, 0);
  const second = await syncProfiles(h.engine, { profileSettings: [{ user: IDS.member2, showShards: true }] });
  assert.equal(second.acked, 2);
  assert.deepEqual(w.acks[1].profileIds.sort(), [IDS.member, IDS.member2].sort());
});

test('profiles-sync: nothing is sent without a dashboard', async () => {
  const { h, w, sync } = await make();
  h.engine.config.dashboardUrl = '';
  sync.note(IDS.member, { username: 'sam' });
  assert.deepEqual(await sync.push(), { sent: 0, batches: 0 });
  assert.equal(w.profiles.length, 0);
});

test('profiles-sync: a picture seen on a message is sent with the snapshot, and a new picture sends a fresh one', async () => {
  const { h, w, sync } = await make();
  h.engine.bot.user = async () => { throw new Error('should not be needed'); };
  sync.note(IDS.member, { username: 'sam', display_name: 'Sam', avatar_path: 'sam/r2-1-a.png' });
  await sync.push();
  const first = w.profiles[0].profiles.find((p) => p.id === IDS.member);
  assert.equal(first.avatar_url, 'https://files.yapper.website/avatars/sam/r2-1-a.png');
  h.clock.t += MIN;
  sync.note(IDS.member, { username: 'sam', avatar_path: 'sam/r2-2-b.png' });
  h.clock.t += MIN;
  await sync.push();
  const second = w.profiles.at(-1).profiles.find((p) => p.id === IDS.member);
  assert.equal(second.avatar_url, 'https://files.yapper.website/avatars/sam/r2-2-b.png', 'a changed picture goes out on the next push');
});

test('profiles-sync: people whose picture is unknown or old are looked up, a few per run', async () => {
  const { h, w, sync } = await make();
  const asked = [];
  h.engine.bot.user = async (id) => { asked.push(id); return { id, username: `u${asked.length}`, display_name: 'Someone', avatar_path: `${id}/pic.png` }; };
  for (let i = 0; i < 30; i++) sync.note(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, { username: `u${i}` });
  await sync.push();
  assert.equal(asked.length, 20, 'at most 20 picture lookups per run');
  const sent = w.profiles.flatMap((b) => b.profiles);
  assert.equal(sent.filter((p) => 'avatar_url' in p).length, 20);
  assert.equal(sent.filter((p) => !('avatar_url' in p)).length, 10, 'unknown pictures are left out, never sent as empty');
});
