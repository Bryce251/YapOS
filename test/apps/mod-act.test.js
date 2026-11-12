import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS, settle } from '../harness.js';

const S = IDS.server;
const R = IDS.roles;
const LOG = IDS.channels.modlog;
const tkey = (uid) => `${S}:${uid}`;

async function make() {
  const h = await createHarness({ apps: ['mod'] });
  h.fake.clock.t = Date.now();
  h.engine.settings.patchCore(S, { logChannel: LOG });
  return { h, mod: h.engine.service('mod') };
}

const data = (h) => h.store.get('mod', S, { cases: [], warns: [], notes: [] });
const cases = (h) => data(h).cases;
const act = (mod, kind, extra = {}) => mod.act(S, { actorId: IDS.admin, kind, targetId: IDS.member, source: 'dashboard', ...extra });
const grantBot = (h, perm) => { h.fake.state.roles[S].find((r) => r.id === R.bot).perms[perm] = true; h.engine.perms.invalidate(); };
const memberOf = (h, uid) => h.fake.memberOf(S, uid);

test('the mod service exposes act, memberDetail, stats and explainError', async () => {
  const { mod } = await make();
  for (const fn of ['act', 'memberDetail', 'stats', 'explainError', 'warn', 'timeout', 'addCase', 'logCase', 'activeWarns']) assert.equal(typeof mod[fn], 'function', fn);
});

test('act refuses without the permission, without mod level, and over the hierarchy', async () => {
  const { h, mod } = await make();
  await assert.rejects(act(mod, 'ban', { actorId: IDS.mod }), (e) => e.friendly && /Ban Members/.test(e.message));
  await assert.rejects(act(mod, 'warn', { actorId: IDS.member2 }), (e) => e.friendly);
  await assert.rejects(act(mod, 'timeout', { actorId: IDS.mod, targetId: IDS.admin, durationMs: 600000 }), (e) => e.friendly && /above (yours|mine)|admin/.test(e.message));
  await assert.rejects(act(mod, 'kick', { targetId: IDS.owner }), (e) => e.friendly && /server owner/.test(e.message));
  await assert.rejects(act(mod, 'kick', { targetId: IDS.admin }), (e) => e.friendly && /yourself|above/.test(e.message));
  await assert.rejects(act(mod, 'kick', { targetId: IDS.bot }), (e) => e.friendly);
  memberOf(h, IDS.member2).roles.push(R.mod);
  await assert.rejects(act(mod, 'kick', { actorId: IDS.mod, targetId: IDS.member2 }), (e) => e.friendly && /above yours/.test(e.message));
  await assert.rejects(act(mod, 'explode'), (e) => e.friendly && /don't know that action/.test(e.message));
  assert.equal(cases(h).length, 0, 'nothing was recorded');
  assert.ok(memberOf(h, IDS.member), 'nobody was removed');
  assert.ok(memberOf(h, IDS.admin));
});

test('act numbers cases like the commands and marks the source', async () => {
  const { h, mod } = await make();
  const w = await act(mod, 'warn', { reason: 'spam' });
  assert.equal(w.case.id, 1);
  assert.equal(w.case.source, 'dashboard');
  assert.equal(w.count, 1);
  assert.match(w.message, /^Warned @sam\. They now have 1 warning in the last 30 days\./);
  assert.doesNotMatch(w.message, /\*\*|`/);
  const t = await act(mod, 'timeout', { durationMs: 3600000, reason: 'calm down' });
  assert.equal(t.case.id, 2);
  assert.equal(t.case.action, 'timeout');
  assert.equal(t.case.durationMs, 3600000);
  assert.equal(h.fake.state.timeouts[tkey(IDS.member)].minutes, 60);
  assert.match(t.message, /Timed out @sam for 1h/);
  assert.equal(t.dm, 'sent');
  const u = await act(mod, 'untimeout');
  assert.equal(u.case.id, 3);
  assert.equal(h.fake.state.timeouts[tkey(IDS.member)], undefined);
  const slash = await h.slash('mod', 'warn @riley rude', { user: IDS.mod });
  assert.match(h.textOf(slash[slash.length - 1]), /Case #4/);
  const k = await act(mod, 'kick', { targetId: IDS.member2 });
  assert.equal(k.case.id, 5);
  assert.equal(memberOf(h, IDS.member2), null);
  assert.deepEqual(cases(h).map((c) => c.action), ['warn', 'timeout', 'untimeout', 'warn', 'kick']);
  assert.deepEqual(cases(h).map((c) => c.source), ['dashboard', 'dashboard', 'dashboard', 'mod', 'dashboard']);
  await settle();
  assert.ok(h.sent(LOG).some((m) => /Case #5: Kick/.test(h.textOf(m))), 'cases reach the mod log');
});

test('timeouts need a length from 1 minute to 28 days', async () => {
  const { h, mod } = await make();
  await assert.rejects(act(mod, 'timeout'), (e) => e.friendly && /at least 1 minute/.test(e.message));
  await assert.rejects(act(mod, 'timeout', { durationMs: 30000 }), (e) => e.friendly);
  await assert.rejects(act(mod, 'timeout', { durationMs: 29 * 864e5 }), (e) => e.friendly && /28 days/.test(e.message));
  const ok = await act(mod, 'timeout', { durationMs: 28 * 864e5 });
  assert.equal(h.fake.state.timeouts[tkey(IDS.member)].minutes, 40320);
  assert.equal(ok.case.id, 1);
});

test('act warn escalates like /mod warn, and unwarn reverses it', async () => {
  const { h, mod } = await make();
  await act(mod, 'warn', { reason: 'one' });
  await act(mod, 'warn', { reason: 'two' });
  const third = await act(mod, 'warn', { reason: 'three' });
  assert.equal(third.count, 3);
  assert.equal(third.escalated.ok, true);
  assert.equal(third.escalated.action, 'timeout');
  assert.equal(third.escalated.case.id, 4);
  assert.match(third.message, /That's 3 warnings, so I timed them out for 1h \(case #4\)\./);
  assert.equal(h.fake.state.timeouts[tkey(IDS.member)].minutes, 60);
  assert.equal(cases(h).find((c) => c.id === 3).meta.escalation, 4);

  await assert.rejects(act(mod, 'unwarn', { caseNumber: 4 }), (e) => e.friendly && /couldn't find a warning/.test(e.message));
  await assert.rejects(act(mod, 'unwarn', { caseNumber: 3, targetId: IDS.member2 }), (e) => e.friendly && /someone else/.test(e.message));
  const undone = await act(mod, 'unwarn', { caseNumber: 3 });
  assert.equal(undone.case.id, 5);
  assert.equal(undone.case.action, 'unwarn');
  assert.equal(undone.case.reason, 'Undo of case #3');
  assert.equal(undone.count, 2);
  assert.deepEqual(undone.notes, ['I also cleared the timeout it caused.']);
  assert.match(undone.message, /Removed the warning in case #3\. @sam is back to 2 warnings\. I also cleared the timeout it caused\./);
  assert.equal(h.fake.state.timeouts[tkey(IDS.member)], undefined);
  const after = cases(h);
  assert.equal(after.find((c) => c.id === 3).undone, true);
  assert.equal(after.find((c) => c.id === 4).undone, true);
  assert.equal(data(h).warns.length, 2);
  await assert.rejects(act(mod, 'unwarn', { caseNumber: 3 }), (e) => e.friendly && /already removed/.test(e.message));
});

test('unwarn by someone else still needs the rights to reverse the escalation', async () => {
  const { h, mod } = await make();
  h.engine.settings.patchApp(S, 'mod', { escalation: [{ at: 1, action: 'ban' }] });
  const w = await act(mod, 'warn', { targetId: IDS.member2 });
  assert.equal(w.escalated.action, 'ban');
  await assert.rejects(mod.act(S, { actorId: IDS.mod, kind: 'unwarn', caseNumber: w.case.id }), (e) => e.friendly && /Ban Members/.test(e.message));
  assert.ok(h.fake.state.bans[S].some((b) => b.user_id === IDS.member2), 'still banned');
  const r = await act(mod, 'unwarn', { caseNumber: w.case.id, targetId: IDS.member2 });
  assert.deepEqual(r.notes, ['I also lifted the ban it caused.']);
  assert.equal(h.fake.state.bans[S].length, 0);
});

test('temporary bans are scheduled, checked for length, and unban cancels them', async () => {
  const { h, mod } = await make();
  await assert.rejects(act(mod, 'ban', { durationMs: 30000 }), (e) => e.friendly && /at least 1 minute/.test(e.message));
  await assert.rejects(act(mod, 'ban', { durationMs: 400 * 864e5 }), (e) => e.friendly && /1 year/.test(e.message));
  assert.equal(h.fake.state.bans[S].length, 0);
  const b = await act(mod, 'ban', { durationMs: 7 * 864e5, reason: 'cool off' });
  assert.ok(h.fake.state.bans[S].some((x) => x.user_id === IDS.member));
  const jobs = h.engine.scheduler.list({ kind: 'mod.unban', serverId: S });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].key, IDS.member);
  assert.equal(b.case.meta.until, jobs[0].at);
  assert.equal(b.until, jobs[0].at);
  assert.equal(b.case.durationMs, 7 * 864e5);
  assert.match(b.message, /^Banned @sam until .+ UTC\. I'll lift the ban by myself when it ends\./);
  assert.equal(mod.stats(S).tempBans, 1);

  const detail = await mod.memberDetail(S, IDS.member, IDS.admin);
  assert.equal(detail.inServer, false);
  assert.equal(detail.banned, true);
  assert.equal(detail.tempBan.until, new Date(jobs[0].at).toISOString());
  assert.equal(detail.can.unban, true);
  assert.equal(detail.can.ban, false);
  assert.equal(detail.can.kick, false);

  const u = await act(mod, 'unban');
  assert.equal(u.case.action, 'unban');
  assert.equal(h.fake.state.bans[S].length, 0);
  assert.equal(h.engine.scheduler.list({ kind: 'mod.unban', serverId: S }).length, 0);
});

test('role add and remove need Manage Roles, respect positions and only log a line', async () => {
  const { h, mod } = await make();
  await assert.rejects(act(mod, 'role_add', { actorId: IDS.mod, roleId: R.vip }), (e) => e.friendly && /Manage Roles/.test(e.message));
  await assert.rejects(act(mod, 'role_add', { roleId: R.admin }), (e) => e.friendly && /My role must be above/.test(e.message));
  await assert.rejects(act(mod, 'role_add', { roleId: 'r-missing' }), (e) => e.friendly && /couldn't find that role/.test(e.message));
  await assert.rejects(act(mod, 'role_add', { roleId: R.member }), (e) => e.friendly && /already has/.test(e.message));
  const added = await act(mod, 'role_add', { roleId: R.vip, reason: 'regular' });
  assert.equal(added.case, null);
  assert.equal(added.message, 'Gave @sam the VIP role.');
  assert.ok(memberOf(h, IDS.member).roles.includes(R.vip));
  const removed = await act(mod, 'role_remove', { roleId: R.vip });
  assert.equal(removed.message, 'Took the VIP role from @sam.');
  assert.equal(memberOf(h, IDS.member).roles.includes(R.vip), false);
  await assert.rejects(act(mod, 'role_remove', { roleId: R.vip }), (e) => e.friendly && /doesn't have/.test(e.message));
  assert.equal(cases(h).length, 0, 'roles get no case number');
  await settle();
  const lines = h.sent(LOG).map((m) => h.textOf(m));
  assert.ok(lines.some((t) => /Role added/.test(t) && /@sam got the \*\*VIP\*\* role/.test(t) && /regular/.test(t)));
  assert.ok(lines.some((t) => /Role removed/.test(t)));
});

test('nick needs Manage Nicknames for both sides, and an empty name clears it', async () => {
  const { h, mod } = await make();
  await assert.rejects(act(mod, 'nick', { nickname: 'Sammy' }), (e) => e.friendly && /My role needs \*\*Manage Nicknames\*\*/.test(e.message));
  grantBot(h, 'manage_nicknames');
  await assert.rejects(act(mod, 'nick', { actorId: IDS.mod, nickname: 'Sammy' }), (e) => e.friendly && /Manage Nicknames/.test(e.message));
  const set = await act(mod, 'nick', { nickname: '  Sammy the Great Sammy the Great Sammy  ' });
  assert.equal(set.nickname, 'Sammy the Great Sammy the Great ');
  assert.equal(memberOf(h, IDS.member).nickname.length <= 32, true);
  assert.match(set.message, /^Changed @sam's nickname to Sammy/);
  const cleared = await act(mod, 'nick', { nickname: '' });
  assert.equal(cleared.message, "Cleared @sam's nickname.");
  assert.equal(memberOf(h, IDS.member).nickname, null);
  assert.equal(cases(h).length, 0);
  await settle();
  assert.ok(h.sent(LOG).some((m) => /Nickname changed/.test(h.textOf(m))));
});

test('notes are stored like /mod note and show newest first in the member detail', async () => {
  const { h, mod } = await make();
  await assert.rejects(act(mod, 'note', { note: '   ' }), (e) => e.friendly && /empty/.test(e.message));
  const first = await act(mod, 'note', { note: 'first note' });
  assert.equal(first.case, null);
  assert.equal(first.note.id, 1);
  assert.match(first.message, /Saved a note about @sam/);
  await act(mod, 'note', { note: 'x'.repeat(600) });
  const all = data(h).notes;
  assert.equal(all.length, 2);
  assert.equal(all[1].text.length, 500);
  assert.equal(all[0].by, IDS.admin);
  await h.slash('mod', 'note @sam typed one', { user: IDS.mod });
  const detail = await mod.memberDetail(S, IDS.member, IDS.admin);
  assert.deepEqual(detail.notes.map((n) => n.id), [3, 2, 1]);
  assert.equal(detail.notes[0].text, 'typed one');
  assert.equal(detail.notes[0].by.id, IDS.mod);
  assert.equal(detail.notes[0].by.name, '@morgan');
  assert.equal(typeof detail.notes[0].at, 'number');
});

test('memberDetail lists roles, timeout and what the requester can do', async () => {
  const { h, mod } = await make();
  await act(mod, 'timeout', { durationMs: 3600000 });
  const d = await mod.memberDetail(S, IDS.member, IDS.admin);
  assert.equal(d.username, 'sam');
  assert.equal(d.nickname, null);
  assert.equal(d.joined_at, '2026-01-05T00:00:00Z');
  assert.deepEqual(d.roles, [{ id: R.member, name: 'Member', color: null, position: 1, manageable: true }]);
  assert.ok(d.timeout?.until);
  assert.ok(Date.parse(d.timeout.until) > Date.now());
  assert.equal(d.banned, false);
  assert.equal(d.tempBan, null);
  assert.deepEqual(d.can, { warn: true, unwarn: true, timeout: true, kick: true, ban: true, unban: false, role: true, nick: false, note: true });
  assert.ok(d.assignable.includes(R.member), 'roles below the admin and YapOS can be given');
  assert.ok(!d.assignable.includes(R.admin), 'roles at or above the admin are not offered');

  const up = await mod.memberDetail(S, IDS.admin, IDS.mod);
  assert.deepEqual(up.can, { warn: false, unwarn: true, timeout: false, kick: false, ban: false, unban: false, role: false, nick: false, note: true }, 'mods can still remove warnings from someone above them');
  assert.deepEqual(up.assignable, []);
  assert.ok(up.roles.every((r) => r.manageable === false));
  assert.deepEqual(up.roles.map((r) => r.name), ['Admin', 'Member']);

  const byMod = await mod.memberDetail(S, IDS.member2, IDS.mod);
  assert.equal(byMod.can.kick, true);
  assert.equal(byMod.can.ban, false, 'Moderator has no Ban Members');
  assert.equal(byMod.can.role, false);

  const nobody = await mod.memberDetail(S, IDS.member, IDS.member2);
  assert.equal(Object.values(nobody.can).some(Boolean), false);

  const gone = await mod.memberDetail(S, 'a0000000-0000-4000-8000-0000000000ff', IDS.admin);
  assert.equal(gone.inServer, false);
  assert.equal(gone.banned, false);
  assert.deepEqual(gone.roles, []);
  assert.equal(gone.can.ban, true);
});

test('stats counts cases by day and type, warnings, timeouts and temp bans', async () => {
  const { h, mod } = await make();
  const empty = mod.stats(S);
  assert.equal(empty.casesByDay.length, 14);
  assert.ok(empty.casesByDay.every((d) => d.count === 0 && /^\d{4}-\d{2}-\d{2}$/.test(d.day)));
  assert.equal(empty.casesByDay[13].day, new Date().toISOString().slice(0, 10));
  assert.deepEqual(empty.casesByType, {});
  await act(mod, 'warn');
  await act(mod, 'warn', { targetId: IDS.member2 });
  await act(mod, 'timeout', { durationMs: 3600000 });
  await act(mod, 'timeout', { targetId: IDS.member2, durationMs: 3600000 });
  await act(mod, 'untimeout', { targetId: IDS.member2 });
  h.store.update('mod', S, (d) => {
    d.cases.push({ id: 99, action: 'kick', targetId: 'x', at: Date.now() - 20 * 864e5 });
    d.cases.push({ id: 100, action: 'ban', targetId: 'y', at: Date.now() - 40 * 864e5 });
    return d;
  });
  const s = mod.stats(S);
  assert.equal(s.casesByDay[13].count, 5);
  assert.equal(s.casesByDay.reduce((a, d) => a + d.count, 0), 5);
  assert.deepEqual(s.casesByType, { warn: 2, timeout: 2, untimeout: 1, kick: 1 });
  assert.equal(s.activeWarns, 2);
  assert.equal(s.activeTimeouts, 1);
  assert.equal(s.tempBans, 0);
});

test('explainError turns refusals and API errors into plain sentences', async () => {
  const { mod } = await make();
  let err;
  try { await act(mod, 'ban', { actorId: IDS.mod }); } catch (e) { err = e; }
  const text = mod.explainError(err, 'ban', '@sam');
  assert.match(text, /You need Ban Members to ban people\./);
  assert.doesNotMatch(text, /\*\*|`|\n/);
  const api = Object.assign(new Error('Forbidden'), { status: 403 });
  assert.match(mod.explainError(api, 'kick', '@sam'), /My role needs Kick Members and must be above @sam's highest role\./);
});

test('act keeps reasons up to 500 characters, like the dashboard form allows', async () => {
  const { mod } = await make();
  const long = 'r'.repeat(480);
  const out = await act(mod, 'warn', { reason: long });
  assert.equal(out.case.reason, long);
  const over = await act(mod, 'warn', { reason: 'x'.repeat(700) });
  assert.equal(over.case.reason.length, 500);
});

test('memberDetail reuses the ban list for a short while and refreshes it after a ban', async () => {
  const { h, mod } = await make();
  let calls = 0;
  const orig = h.engine.bot.bans;
  h.engine.bot.bans = async (...a) => { calls++; return orig.apply(h.engine.bot, a); };
  const ghost = 'a0000000-0000-4000-8000-0000000000fd';
  await mod.memberDetail(S, ghost, IDS.admin);
  await mod.memberDetail(S, ghost, IDS.admin);
  assert.equal(calls, 1, 'the second look used the cached ban list');
  await act(mod, 'ban', { targetId: IDS.member2 });
  const banned = await mod.memberDetail(S, IDS.member2, IDS.admin);
  assert.equal(banned.banned, true);
  assert.equal(calls, 2);
});
