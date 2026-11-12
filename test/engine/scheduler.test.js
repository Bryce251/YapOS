import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createScheduler, nextRun, MAX_DELAY } from '../../engine/scheduler.js';
import { createMemoryStore } from '../../engine/storage.js';
import { defineApp } from '../../engine/apps.js';
import { createHarness, settle, IDS } from '../harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T0 = Date.parse('2026-11-07T12:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const S1 = 'server-one';
const S2 = 'server-two';
const iso = (ms) => new Date(ms).toISOString();
const tick = () => new Promise((r) => setImmediate(r));

function rig({ store = createMemoryStore(), t0 = T0, limits, start = true } = {}) {
  const clock = { t: t0 };
  const timers = [];
  const lines = [];
  const text = (a) => a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ');
  const log = {
    debug() {},
    info: (...a) => lines.push(`info ${text(a)}`),
    warn: (...a) => lines.push(`warn ${text(a)}`),
    error: (...a) => lines.push(`error ${text(a)}`),
  };
  const engine = { name: 'engine' };
  const s = createScheduler({
    store, log, engine, limits,
    now: () => clock.t,
    setTimeout: (fn, ms) => { const h = { fn, ms, unref() { return h; } }; timers.push(h); return h; },
    clearTimeout: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
  });
  if (start) s.start();
  const advance = async (ms) => { clock.t += ms; await s.runDue(); };
  const helperMs = [limits?.softTimeoutMs ?? 30_000, limits?.hardTimeoutMs ?? 15 * 60_000];
  const mainTimer = () => [...timers].reverse().find((h) => !helperMs.includes(h.ms)) || null;
  return { s, clock, timers, lines, store, engine, advance, mainTimer };
}

function recorder(result) {
  const calls = [];
  const fn = async (job, engine) => {
    calls.push({ job, engine });
    return typeof result === 'function' ? result(job) : result;
  };
  return { fn, calls };
}

test('a one-shot job runs at its time, not before, and is then removed', async () => {
  const r = rig();
  const rec = recorder();
  r.s.register('test.ping', rec.fn);
  const job = r.s.schedule({ kind: 'test.ping', at: T0 + 10 * MIN, data: { hello: 'there' }, serverId: S1, userId: 'u1' });
  assert.equal(typeof job.id, 'string');
  assert.deepEqual(Object.keys(job).sort(), ['at', 'createdAt', 'data', 'id', 'key', 'kind', 'repeat', 'runs', 'serverId', 'userId'].sort());
  assert.equal(r.store.has('scheduler', S1), false);
  await null;
  assert.equal(r.store.get('scheduler', S1).jobs.length, 1);
  await r.advance(9 * MIN);
  assert.equal(rec.calls.length, 0);
  await r.advance(MIN);
  assert.equal(rec.calls.length, 1);
  const seen = rec.calls[0].job;
  assert.deepEqual(seen.data, { hello: 'there' });
  assert.equal(seen.attempt, 1);
  assert.equal(seen.late, false);
  assert.equal(seen.lateByMs, 0);
  assert.equal(seen.missed, 0);
  assert.equal(rec.calls[0].engine, r.engine);
  assert.equal(r.s.get(job.id), null);
  assert.equal(r.store.has('scheduler', S1), false);
  await r.advance(HOUR);
  assert.equal(rec.calls.length, 1);
});

test('global jobs live in the "global" document; saves of one tick are batched', () => {
  const r = rig();
  r.s.schedule({ kind: 'pocket.remind', at: T0 + MIN, userId: 'u1' });
  r.s.schedule({ kind: 'pocket.remind', at: T0 + MIN, userId: 'u2' });
  assert.equal(r.store.has('scheduler', 'global'), false);
  r.s.flush();
  assert.equal(r.store.get('scheduler', 'global').jobs.length, 2);
  assert.equal(r.store.get('scheduler', 'global').jobs[0].kind, 'pocket.remind');
});

test('scheduling the same kind, server and key replaces the earlier job', async () => {
  const r = rig();
  const rec = recorder();
  r.s.register('engage.giveawayEnd', rec.fn);
  const first = r.s.schedule({ kind: 'engage.giveawayEnd', at: T0 + 10 * MIN, data: 1, serverId: S1, key: 'g1' });
  const second = r.s.schedule({ kind: 'engage.giveawayEnd', at: T0 + 20 * MIN, data: 2, serverId: S1, key: 'g1' });
  r.s.schedule({ kind: 'engage.giveawayEnd', at: T0 + 10 * MIN, data: 3, serverId: S2, key: 'g1' });
  assert.notEqual(first.id, second.id);
  assert.equal(r.s.get(first.id), null);
  assert.equal(r.s.list({ serverId: S1 }).length, 1);
  await r.advance(10 * MIN);
  assert.deepEqual(rec.calls.map((c) => c.job.data), [3]);
  await r.advance(10 * MIN);
  assert.deepEqual(rec.calls.map((c) => c.job.data), [3, 2]);
});

test('cancel, cancelWhere and get', async () => {
  const r = rig();
  const rec = recorder();
  r.s.register('mod.unban', rec.fn);
  const a = r.s.schedule({ kind: 'mod.unban', at: T0 + MIN, serverId: S1, userId: 'u1', key: 'u1' });
  r.s.schedule({ kind: 'mod.unban', at: T0 + MIN, serverId: S1, userId: 'u2', key: 'u2' });
  r.s.schedule({ kind: 'mod.unban', at: T0 + MIN, serverId: S2, userId: 'u2', key: 'u2' });
  r.s.schedule({ kind: 'tools.post', at: T0 + MIN, serverId: S2 });
  assert.equal(r.s.get(a.id).userId, 'u1');
  assert.equal(r.s.cancel(a.id), true);
  assert.equal(r.s.cancel(a.id), false);
  assert.equal(r.s.get(a.id), null);
  assert.equal(r.s.cancelWhere({ kind: 'mod.unban', userId: 'u2' }), 2);
  assert.throws(() => r.s.cancelWhere({}), TypeError);
  assert.equal(r.s.cancelWhere({ serverId: S2 }), 1);
  assert.equal(r.s.list().length, 0);
  assert.equal(r.store.has('scheduler', S1), false);
  await r.advance(HOUR);
  assert.equal(rec.calls.length, 0);
});

test('list filters and sorts by time', () => {
  const r = rig();
  r.s.schedule({ kind: 'a.x', at: T0 + 30 * MIN, serverId: S1, userId: 'u1' });
  r.s.schedule({ kind: 'a.x', at: T0 + 10 * MIN, serverId: S1 });
  r.s.schedule({ kind: 'b.y', at: T0 + 20 * MIN, serverId: S2, userId: 'u1' });
  r.s.schedule({ kind: 'a.x', at: T0 + 5 * MIN });
  assert.deepEqual(r.s.list().map((j) => j.at - T0), [5, 10, 20, 30].map((m) => m * MIN));
  assert.deepEqual(r.s.list({ kind: 'a.x', serverId: S1 }).map((j) => j.at - T0), [10 * MIN, 30 * MIN]);
  assert.deepEqual(r.s.list({ userId: 'u1' }).map((j) => j.kind), ['b.y', 'a.x']);
  assert.deepEqual(r.s.list({ serverId: null }).map((j) => j.at - T0), [5 * MIN]);
  const listed = r.s.list()[0];
  listed.data = 'changed';
  assert.equal(r.s.list()[0].data, null);
});

test('caps and validation give clear errors', () => {
  const r = rig({ limits: { serverJobs: 3, userJobs: 2 } });
  for (let i = 0; i < 3; i++) r.s.schedule({ kind: 'x.y', at: T0 + MIN, serverId: S1, key: `k${i}` });
  const serverErr = (() => { try { r.s.schedule({ kind: 'x.y', at: T0 + MIN, serverId: S1 }); } catch (e) { return e; } return null; })();
  assert.ok(serverErr?.friendly);
  assert.match(serverErr.message, /3 things scheduled/);
  assert.doesNotThrow(() => r.s.schedule({ kind: 'x.y', at: T0 + 2 * MIN, serverId: S1, key: 'k1' }));
  r.s.schedule({ kind: 'p.r', at: T0 + MIN, userId: 'u9' });
  r.s.schedule({ kind: 'p.r', at: T0 + MIN, userId: 'u9', serverId: S2 });
  const userErr = (() => { try { r.s.schedule({ kind: 'p.r', at: T0 + MIN, userId: 'u9' }); } catch (e) { return e; } return null; })();
  assert.ok(userErr?.friendly);
  assert.match(userErr.message, /You already have 2/);

  const big = 'x'.repeat(17 * 1024);
  assert.throws(() => r.s.schedule({ kind: 'x.big', at: T0, data: big }), (e) => e.friendly && /too much/i.test(e.message));
  assert.throws(() => r.s.schedule({ kind: 'x.bad', at: T0, data: { n: 1n } }), TypeError);
  const loop = {};
  loop.self = loop;
  assert.throws(() => r.s.schedule({ kind: 'x.bad', at: T0, data: loop }), TypeError);
  assert.throws(() => r.s.schedule({ kind: '', at: T0 }), TypeError);
  assert.throws(() => r.s.schedule({ kind: 'x.y', at: NaN }), TypeError);
  assert.throws(() => r.s.schedule({ kind: 'x.y', at: '2026' }), TypeError);
  assert.throws(() => r.s.schedule({ kind: 'x.y', at: T0, repeat: { everyMs: 1000 } }), (e) => e.friendly);
  assert.throws(() => r.s.schedule({ kind: 'x.y', at: T0, repeat: { daily: '25:00' } }), (e) => e.friendly);
  assert.throws(() => r.s.schedule({ kind: 'x.y', at: T0, repeat: { daily: '09:00', tz: 'Mars/Olympus' } }), (e) => e.friendly && /time zone/.test(e.message));
  assert.throws(() => r.s.schedule({ kind: 'x.y', at: T0, repeat: { monthly: { day: 31, time: '09:00' } } }), (e) => e.friendly);
  assert.throws(() => r.s.schedule({ kind: 'x.y', at: T0, repeat: { weekly: { days: [7], time: '09:00' } } }), (e) => e.friendly);
  const stored = r.s.schedule({ kind: 'x.fn', at: T0, data: { when: new Date(T0), skip: undefined } });
  assert.deepEqual(stored.data, { when: iso(T0) });
});

test('everyMs repeats from the scheduled time', async () => {
  const r = rig();
  const rec = recorder();
  r.s.register('tools.stats', rec.fn);
  const job = r.s.schedule({ kind: 'tools.stats', at: T0 + HOUR, serverId: S1, repeat: { everyMs: HOUR } });
  await r.advance(HOUR + 5 * 1000);
  assert.equal(rec.calls.length, 1);
  assert.equal(r.s.get(job.id).at, T0 + 2 * HOUR);
  assert.equal(r.s.get(job.id).runs, 1);
  await r.advance(HOUR);
  assert.equal(rec.calls.length, 2);
  assert.equal(rec.calls[1].job.missed, 0);
  assert.equal(r.s.get(job.id).at, T0 + 3 * HOUR);
});

test('a repeating job that missed runs while offline runs once with job.missed', async () => {
  const r = rig();
  const rec = recorder();
  r.s.register('tools.stats', rec.fn);
  const job = r.s.schedule({ kind: 'tools.stats', at: T0 + HOUR, serverId: S1, repeat: { everyMs: HOUR } });
  await r.advance(5 * HOUR + 30 * MIN);
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].job.missed, 4);
  assert.equal(rec.calls[0].job.late, true);
  assert.equal(rec.calls[0].job.at, T0 + HOUR);
  assert.equal(r.s.get(job.id).at, T0 + 6 * HOUR);

  const daily = r.s.schedule({ kind: 'tools.stats', serverId: S2, repeat: { daily: '09:00', tz: 'Europe/London' } });
  assert.equal(iso(daily.at), '2026-11-08T09:00:00.000Z');
  r.clock.t = Date.parse('2026-11-12T10:00:00Z');
  await r.s.runDue();
  const dailyRun = rec.calls.find((c) => c.job.id === daily.id);
  assert.equal(dailyRun.job.missed, 4);
  assert.equal(rec.calls.filter((c) => c.job.id === daily.id).length, 1);
  assert.equal(iso(r.s.get(daily.id).at), '2026-11-13T09:00:00.000Z');
});

test('nextRun keeps local times across DST in London and New York', () => {
  const london = { daily: '09:00', tz: 'Europe/London' };
  assert.equal(iso(nextRun(london, Date.parse('2026-03-28T09:00:00Z'))), '2026-03-29T08:00:00.000Z');
  assert.equal(iso(nextRun(london, Date.parse('2026-03-29T08:00:00Z'))), '2026-03-30T08:00:00.000Z');
  assert.equal(iso(nextRun(london, Date.parse('2026-10-24T08:00:00Z'))), '2026-10-25T09:00:00.000Z');
  const ny = { daily: '09:00', tz: 'America/New_York' };
  assert.equal(iso(nextRun(ny, Date.parse('2026-03-07T14:00:00Z'))), '2026-03-08T13:00:00.000Z');
  assert.equal(iso(nextRun(ny, Date.parse('2026-10-31T13:00:00Z'))), '2026-11-01T14:00:00.000Z');

  assert.equal(iso(nextRun({ daily: '01:30', tz: 'Europe/London' }, Date.parse('2026-03-28T01:30:00Z'))), '2026-03-29T01:30:00.000Z');
  const fallBack = nextRun({ daily: '01:30', tz: 'Europe/London' }, Date.parse('2026-10-24T00:30:00Z'));
  assert.equal(iso(fallBack), '2026-10-25T00:30:00.000Z');
  assert.equal(iso(nextRun({ daily: '01:30', tz: 'Europe/London' }, fallBack)), '2026-10-26T01:30:00.000Z');
  assert.equal(iso(nextRun({ daily: '02:30', tz: 'America/New_York' }, Date.parse('2026-03-07T12:00:00Z'))), '2026-03-08T07:30:00.000Z');

  const weekly = { weekly: { days: [3, 1], time: '18:00' }, tz: 'America/New_York' };
  const mon = nextRun(weekly, Date.parse('2026-10-30T12:00:00Z'));
  assert.equal(iso(mon), '2026-11-02T23:00:00.000Z');
  assert.equal(iso(nextRun(weekly, mon)), '2026-11-04T23:00:00.000Z');
  assert.equal(iso(nextRun(weekly, Date.parse('2026-10-26T12:00:00Z'))), '2026-10-26T22:00:00.000Z');

  const monthly = { monthly: { day: 15, time: '12:00' }, tz: 'Europe/London' };
  assert.equal(iso(nextRun(monthly, Date.parse('2026-10-20T00:00:00Z'))), '2026-11-15T12:00:00.000Z');
  const march = nextRun(monthly, Date.parse('2026-03-01T00:00:00Z'));
  assert.equal(iso(march), '2026-03-15T12:00:00.000Z');
  assert.equal(iso(nextRun(monthly, march)), '2026-04-15T11:00:00.000Z');
  assert.equal(iso(nextRun({ monthly: { day: 1, time: '00:00' } }, Date.parse('2026-12-31T23:59:00Z'))), '2027-01-01T00:00:00.000Z');

  assert.equal(nextRun({ everyMs: HOUR }, T0), T0 + HOUR);
  assert.equal(iso(nextRun({ daily: '9:05' }, Date.parse('2026-11-07T09:05:00Z'))), '2026-11-08T09:05:00.000Z');
});

test('daily, weekly and monthly jobs run through a DST change at the right local time', async () => {
  const r = rig({ t0: Date.parse('2026-03-27T10:00:00Z') });
  const rec = recorder();
  r.s.register('tools.post', rec.fn);
  const daily = r.s.schedule({ kind: 'tools.post', serverId: S1, repeat: { daily: '09:00', tz: 'Europe/London' } });
  assert.equal(iso(daily.at), '2026-03-28T09:00:00.000Z');
  r.clock.t = daily.at;
  await r.s.runDue();
  assert.equal(rec.calls.length, 1);
  assert.equal(iso(r.s.get(daily.id).at), '2026-03-29T08:00:00.000Z');

  const ny = rig({ t0: Date.parse('2026-10-30T12:00:00Z') });
  const nyRec = recorder();
  ny.s.register('tools.post', nyRec.fn);
  const weekly = ny.s.schedule({ kind: 'tools.post', serverId: S1, repeat: { weekly: { days: [0, 1], time: '08:00' }, tz: 'America/New_York' } });
  assert.equal(iso(weekly.at), '2026-11-01T13:00:00.000Z');
  ny.clock.t = weekly.at;
  await ny.s.runDue();
  assert.equal(iso(ny.s.get(weekly.id).at), '2026-11-02T13:00:00.000Z');
  const monthly = ny.s.schedule({ kind: 'tools.post', serverId: S2, repeat: { monthly: { day: 2, time: '08:00' }, tz: 'America/New_York' } });
  assert.equal(iso(monthly.at), '2026-11-02T13:00:00.000Z');
  ny.clock.t = monthly.at;
  await ny.s.runDue();
  assert.equal(iso(ny.s.get(monthly.id).at), '2026-12-02T13:00:00.000Z');
  assert.equal(nyRec.calls.length, 3);
});

test('a one-shot job that came due while the bot was off runs late after a restart', async () => {
  const store = createMemoryStore();
  const a = await createHarness({ fakeClock: true, store, apps: [] });
  const first = recorder();
  a.engine.scheduler.register('pocket.remind', first.fn);
  const job = a.engine.scheduler.schedule({ kind: 'pocket.remind', at: a.clock.t + 10 * MIN, userId: IDS.member, data: { text: 'stretch' } });
  a.engine.scheduler.stop();

  const b = await createHarness({ fakeClock: true, store, apps: [] });
  b.clock.t += 3 * HOUR;
  const second = recorder();
  b.engine.scheduler.register('pocket.remind', second.fn);
  await b.runDue();
  assert.equal(first.calls.length, 0);
  assert.equal(second.calls.length, 1);
  const seen = second.calls[0].job;
  assert.equal(seen.id, job.id);
  assert.equal(seen.late, true);
  assert.equal(seen.lateByMs, 2 * HOUR + 50 * MIN);
  assert.equal(second.calls[0].engine, b.engine);
  assert.equal(b.engine.scheduler.stats().late, 1);
  assert.equal(b.engine.scheduler.get(job.id), null);
});

test('a job overdue only slightly at start still counts as late, a just-due one does not', async () => {
  const store = createMemoryStore();
  const r1 = rig({ store, start: false });
  r1.s.schedule({ kind: 'x.y', at: T0 + 10 * 1000, key: 'old' });
  r1.s.stop();
  const r2 = rig({ store, t0: T0 + 20 * 1000 });
  const rec = recorder();
  r2.s.register('x.y', rec.fn);
  r2.s.schedule({ kind: 'x.y', at: T0 + 20 * 1000, key: 'new' });
  await r2.s.runDue();
  const byKey = Object.fromEntries(rec.calls.map((c) => [c.job.key, c.job.late]));
  assert.deepEqual(byKey, { old: true, new: false });
  assert.ok(r2.lines.some((l) => /catching up on 1 scheduled job/.test(l)));
});

test('a crash mid-run runs the job again on the next start with a higher attempt', async () => {
  const store = createMemoryStore();
  const r1 = rig({ store });
  let started = 0;
  r1.s.register('tickets.autoclose', async () => { started++; return new Promise(() => {}); });
  const job = r1.s.schedule({ kind: 'tickets.autoclose', at: T0, serverId: S1 });
  r1.s.runDue();
  await tick();
  await tick();
  assert.equal(started, 1);
  assert.equal(store.get('scheduler', S1).jobs[0].tries, 1);
  r1.s.stop();

  const r2 = rig({ store, t0: T0 + MIN });
  const rec = recorder();
  r2.s.register('tickets.autoclose', rec.fn);
  await r2.s.runDue();
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].job.id, job.id);
  assert.equal(rec.calls[0].job.attempt, 2);
  assert.equal(store.has('scheduler', S1), false);
});

test('a job that keeps crashing the bot is dropped instead of looping forever', async () => {
  const store = createMemoryStore({ scheduler: { [S1]: { jobs: [{ id: 'j1', kind: 'x.y', at: T0, data: null, serverId: S1, userId: null, key: null, repeat: null, createdAt: T0, runs: 0, tries: 4 }] } } });
  const r = rig({ store, t0: T0 + MIN });
  const rec = recorder();
  r.s.register('x.y', rec.fn);
  await r.s.runDue();
  assert.equal(rec.calls.length, 0);
  assert.equal(r.s.get('j1'), null);
  assert.equal(r.s.stats().dropped, 1);
});

test('failures retry after 1, 5 and 30 minutes, then the job is dropped', async () => {
  const r = rig();
  const attempts = [];
  r.s.register('mod.unban', async (job) => { attempts.push(job.attempt); throw new Error('boom'); });
  const job = r.s.schedule({ kind: 'mod.unban', at: T0, serverId: S1 });
  await r.s.runDue();
  assert.deepEqual(attempts, [1]);
  assert.equal(r.s.get(job.id).at, T0 + MIN);
  await r.advance(59 * 1000);
  assert.deepEqual(attempts, [1]);
  await r.advance(1000);
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(r.s.get(job.id).at, T0 + 6 * MIN);
  await r.advance(5 * MIN);
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.equal(r.s.get(job.id).at, T0 + 36 * MIN);
  await r.advance(30 * MIN);
  assert.deepEqual(attempts, [1, 2, 3, 4]);
  assert.equal(r.s.get(job.id), null);
  assert.equal(r.store.has('scheduler', S1), false);
  const st = r.s.stats();
  assert.equal(st.failed, 4);
  assert.equal(st.dropped, 1);
  assert.ok(r.lines.some((l) => l.startsWith('error') && /mod\.unban failed \(try 1 of 4\); trying again in 1 min/.test(l)));
  assert.ok(r.lines.some((l) => /gave up on mod\.unban after 4 tries/.test(l)));
});

test('a failing repeating job moves on to its next time', async () => {
  const r = rig();
  r.s.register('x.rep', async () => { throw new Error('nope'); });
  const job = r.s.schedule({ kind: 'x.rep', at: T0 + HOUR, repeat: { everyMs: HOUR } });
  await r.advance(HOUR);
  assert.equal(r.s.get(job.id).at, T0 + 2 * HOUR);
  assert.equal(r.s.stats().failed, 1);
});

test('a handler can push a job back with { reschedule }', async () => {
  const r = rig();
  let n = 0;
  r.s.register('engage.pollEnd', async () => (++n === 1 ? { reschedule: T0 + 10 * MIN } : undefined));
  const job = r.s.schedule({ kind: 'engage.pollEnd', at: T0, serverId: S1 });
  await r.s.runDue();
  assert.equal(r.s.get(job.id).at, T0 + 10 * MIN);
  assert.equal(r.s.get(job.id).runs, 1);
  await r.advance(10 * MIN);
  assert.equal(n, 2);
  assert.equal(r.s.get(job.id), null);
});

test('jobs with no handler wait, and run once the handler is registered', async () => {
  const r = rig();
  const job = r.s.schedule({ kind: 'later.app', at: T0, serverId: S1 });
  await r.advance(MIN);
  assert.equal(r.s.stats().waiting, 1);
  assert.equal(r.mainTimer(), null);
  const rec = recorder();
  r.s.register('later.app', rec.fn);
  await r.s.runDue();
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].job.id, job.id);
  const again = recorder();
  r.s.register('later.app', again.fn);
  r.s.schedule({ kind: 'later.app', at: T0 + MIN });
  await r.s.runDue();
  assert.equal(rec.calls.length, 1);
  assert.equal(again.calls.length, 1);
  assert.equal(r.s.unregister('later.app', rec.fn), false);
  assert.equal(r.s.unregister('later.app', again.fn), true);
  assert.equal(r.s.has('later.app'), false);
});

test('apps declare jobs in defineApp; they register on load and go away on unload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yapos-jobs-'));
  const appsUrl = pathToFileURL(path.resolve(HERE, '..', '..', 'engine', 'apps.js')).href;
  const file = path.join(dir, 'clocky.js');
  fs.writeFileSync(file, [
    `import { defineApp } from ${JSON.stringify(appsUrl)};`,
    'export const seen = [];',
    "export const { setup, teardown, check } = defineApp({ id: 'clocky', name: 'Clocky', jobs: { tick: async (job, engine) => { seen.push({ id: job.id, hasEngine: !!engine.scheduler }); globalThis.clockySeen = seen; } } });",
  ].join('\n'));
  try {
    const h = await createHarness({ fakeClock: true, loadApps: false });
    await h.bot.load(file);
    h.engine.scheduler.start();
    assert.equal(h.engine.scheduler.has('clocky.tick'), true);
    const job = h.engine.scheduler.schedule({ kind: 'clocky.tick', at: h.clock.t + MIN, serverId: IDS.server });
    await h.advance(MIN);
    assert.deepEqual(globalThis.clockySeen, [{ id: job.id, hasEngine: true }]);

    await h.bot.unload('clocky');
    assert.equal(h.engine.scheduler.has('clocky.tick'), false);
    const pending = h.engine.scheduler.schedule({ kind: 'clocky.tick', at: h.clock.t + MIN, serverId: IDS.server });
    await h.advance(MIN);
    assert.equal(h.engine.scheduler.list({ kind: 'clocky.tick' }).length, 1);

    globalThis.clockySeen = null;
    await h.bot.load(file);
    await h.runDue();
    assert.equal(h.engine.scheduler.get(pending.id), null);
    assert.equal(globalThis.clockySeen.at(-1).id, pending.id);
  } finally {
    delete globalThis.clockySeen;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => defineApp({ id: 'badjobs', jobs: { 'Bad Name': async () => {} } }), /bad job name/);
  assert.throws(() => defineApp({ id: 'badjobs', jobs: { ok: 'nope' } }), /handler function/);
});

test('long delays are capped and re-armed', async () => {
  const r = rig({ limits: { wakeCheckMs: Infinity } });
  const rec = recorder();
  r.s.register('x.far', rec.fn);
  const at = T0 + 40 * DAY;
  r.s.schedule({ kind: 'x.far', at });
  assert.equal(r.mainTimer().ms, MAX_DELAY);
  r.clock.t += MAX_DELAY;
  r.mainTimer().fn();
  await settle();
  assert.equal(rec.calls.length, 0);
  assert.equal(r.mainTimer().ms, at - r.clock.t);
  r.clock.t = at;
  r.mainTimer().fn();
  await settle();
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].job.late, false);
  assert.equal(r.s.stats().wakes, 0);
});

test('a timer that fires much later than planned is treated as a wake from sleep', async () => {
  const r = rig({ limits: { wakeCheckMs: Infinity } });
  const rec = recorder();
  r.s.register('x.y', rec.fn);
  r.s.schedule({ kind: 'x.y', at: T0 + 10 * MIN });
  assert.equal(r.mainTimer().ms, 10 * MIN);
  r.clock.t += 3 * HOUR;
  r.mainTimer().fn();
  await settle();
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].job.late, true);
  assert.equal(rec.calls[0].job.lateByMs, 3 * HOUR - 10 * MIN);
  assert.equal(r.s.stats().wakes, 1);
  assert.ok(r.lines.some((l) => /woke up 2 h 50 min late/.test(l)));
});

test('jobs run one at a time per server and at most 4 servers at once', async () => {
  const r = rig();
  const waiting = [];
  const order = [];
  r.s.register('x.slow', (job) => new Promise((resolve) => { order.push(job.data); waiting.push(resolve); }));
  for (let i = 0; i < 6; i++) r.s.schedule({ kind: 'x.slow', at: T0, serverId: `s${i}`, data: `s${i}-a` });
  r.s.schedule({ kind: 'x.slow', at: T0, serverId: 's0', data: 's0-b' });
  const done = r.s.runDue();
  await settle();
  assert.equal(order.length, 4);
  assert.ok(!order.includes('s0-b'));
  while (waiting.length) {
    waiting.shift()();
    await settle();
  }
  await done;
  assert.equal(order.length, 7);
  assert.ok(order.indexOf('s0-b') > order.indexOf('s0-a'));
});

test('a slow handler is logged and the server queue moves on', async () => {
  const r = rig({ limits: { softTimeoutMs: 30_000 } });
  const ran = [];
  let release;
  r.s.register('x.slow', (job) => { ran.push(job.data); return job.data === 'first' ? new Promise((res) => { release = res; }) : undefined; });
  r.s.schedule({ kind: 'x.slow', at: T0, serverId: S1, data: 'first' });
  r.s.schedule({ kind: 'x.slow', at: T0 + 1, serverId: S1, data: 'second' });
  r.clock.t += 1;
  const done = r.s.runDue();
  await settle();
  assert.deepEqual(ran, ['first']);
  r.timers.find((t) => t.ms === 30_000).fn();
  await done;
  assert.deepEqual(ran, ['first', 'second']);
  assert.ok(r.lines.some((l) => /x\.slow is taking longer than 30 s/.test(l)));
  assert.equal(r.s.stats().running, 1);
  release();
  await settle();
  assert.equal(r.s.stats().running, 0);
  assert.equal(r.s.list().length, 0);
});

test('a job cancelled while it runs is not put back', async () => {
  const r = rig();
  let release;
  r.s.register('x.rep', () => new Promise((res) => { release = res; }));
  const job = r.s.schedule({ kind: 'x.rep', at: T0, repeat: { everyMs: HOUR } });
  const done = r.s.runDue();
  await settle();
  r.s.cancel(job.id);
  release();
  await done;
  assert.equal(r.s.list().length, 0);
});

test('stats report jobs, next time, runs, failures and late runs', async () => {
  const r = rig();
  assert.deepEqual(r.s.stats(), { jobs: 0, nextAt: null, ran: 0, failed: 0, late: 0, dropped: 0, running: 0, waiting: 0, wakes: 0, hung: 0 });
  r.s.register('x.ok', async () => {});
  r.s.register('x.bad', async () => { throw new Error('bad'); });
  r.s.schedule({ kind: 'x.ok', at: T0 + MIN });
  r.s.schedule({ kind: 'x.bad', at: T0 + MIN });
  r.s.schedule({ kind: 'x.ok', at: T0 + 10 * MIN });
  r.s.schedule({ kind: 'x.none', at: T0 + 20 * MIN });
  assert.equal(r.s.stats().nextAt, T0 + MIN);
  assert.equal(r.s.stats().jobs, 4);
  await r.advance(5 * MIN);
  const st = r.s.stats();
  assert.equal(st.ran, 1);
  assert.equal(st.failed, 1);
  assert.equal(st.late, 2);
  assert.equal(st.jobs, 3);
  assert.equal(st.waiting, 1);
  assert.equal(st.nextAt, T0 + 6 * MIN);
});

test('real timers: the scheduler fires on its own and stop() clears the timer', async () => {
  const store = createMemoryStore();
  const s = createScheduler({ store, log: null });
  const ran = [];
  s.register('x.real', async (job) => { ran.push(job.data); });
  s.start();
  s.schedule({ kind: 'x.real', at: Date.now() + 20, data: 'soon' });
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(ran, ['soon']);
  s.schedule({ kind: 'x.real', at: Date.now() + 40, data: 'never' });
  assert.ok(s.timerDelay !== null);
  s.stop();
  assert.equal(s.timerDelay, null);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(ran, ['soon']);
});

test('the engine exposes a started scheduler; the harness uses real time unless asked', async () => {
  const h = await createHarness({ apps: [] });
  assert.equal(h.engine.scheduler.started, true);
  assert.equal(h.fakeClock, false);
  await assert.rejects(() => h.advance(MIN), /fakeClock/);
  const f = await createHarness({ fakeClock: true, apps: [] });
  const rec = recorder();
  f.engine.scheduler.register('x.y', rec.fn);
  const start = f.clock.t;
  f.engine.scheduler.schedule({ kind: 'x.y', at: start + 2 * HOUR, serverId: IDS.server });
  await f.advance(HOUR);
  assert.equal(rec.calls.length, 0);
  await f.advanceTo(start + 2 * HOUR);
  assert.equal(rec.calls.length, 1);
  assert.equal(f.now(), start + 2 * HOUR);
});

test('the timer never sleeps longer than the wake check, so a clock jump is caught quickly', async () => {
  const r = rig();
  const rec = recorder();
  r.s.register('x.y', rec.fn);
  r.s.schedule({ kind: 'x.y', at: T0 + 2 * HOUR });
  assert.equal(r.mainTimer().ms, 5 * MIN);
  r.clock.t += 2 * HOUR + 5 * MIN;
  r.mainTimer().fn();
  await settle();
  assert.equal(rec.calls.length, 1);
  assert.equal(r.s.stats().wakes, 1);
  r.s.schedule({ kind: 'x.y', at: r.clock.t + 3 * MIN });
  assert.equal(r.mainTimer().ms, 3 * MIN);
});

test('a handler that never finishes is given up on, and its repeats carry on', async () => {
  const r = rig({ limits: { hardTimeoutMs: 10 * MIN } });
  let calls = 0;
  r.s.register('x.hang', () => { calls++; return calls === 1 ? new Promise(() => {}) : undefined; });
  const job = r.s.schedule({ kind: 'x.hang', at: T0, serverId: S1, repeat: { everyMs: HOUR } });
  const done = r.s.runDue();
  await settle();
  assert.equal(calls, 1);
  r.timers.find((t) => t.ms === 30_000).fn();
  await settle();
  r.clock.t += 10 * MIN;
  r.timers.find((t) => t.ms === 10 * MIN).fn();
  await done;
  await settle();
  assert.equal(r.s.stats().hung, 1);
  assert.equal(r.s.stats().running, 0);
  assert.equal(r.s.get(job.id).at, T0 + HOUR);
  await r.advance(50 * MIN);
  assert.equal(calls, 2);
  assert.ok(r.lines.some((l) => /x\.hang was still running after 10 min/.test(l)));
});

test('a storage failure is logged and never stops jobs from running', async () => {
  const base = createMemoryStore();
  let failing = true;
  const store = { ...base, set(ns, key, value) { if (ns === 'scheduler' && failing) throw new Error('disk full'); return base.set(ns, key, value); } };
  const r = rig({ store });
  let n = 0;
  r.s.register('x.y', async () => { n++; });
  r.s.schedule({ kind: 'x.y', at: T0, serverId: S1 });
  const later = r.s.schedule({ kind: 'x.y', at: T0 + HOUR, serverId: S1 });
  await r.s.runDue();
  assert.equal(n, 1);
  assert.ok(r.lines.some((l) => /couldn't save scheduled jobs/.test(l)));
  assert.equal(base.has('scheduler', S1), false);
  failing = false;
  r.s.schedule({ kind: 'x.z', at: T0 + 2 * HOUR, serverId: S1 });
  await null;
  assert.deepEqual(base.get('scheduler', S1).jobs.map((j) => j.id).includes(later.id), true);
});

test('an unexpected error around a run is retried in a minute instead of spinning', async () => {
  let throws = 1;
  const lines = [];
  const log = { debug() {}, info() {}, warn() {}, error: (msg) => { lines.push(String(msg)); if (throws-- > 0) throw new Error('log broke'); } };
  const clock = { t: T0 };
  const s = createScheduler({ store: createMemoryStore(), log, now: () => clock.t, setTimeout: () => ({}), clearTimeout() {} });
  let n = 0;
  s.register('x.y', async () => { n++; throw new Error('handler failed'); });
  const job = s.schedule({ kind: 'x.y', at: T0, serverId: S1 });
  await s.runDue();
  assert.equal(n, 1);
  assert.equal(s.get(job.id).at, T0 + MIN);
  assert.ok(lines.some((l) => /something went wrong around x\.y/.test(l)));
  clock.t += MIN;
  await s.runDue();
  assert.equal(n, 2);
});
test('jobs with no server and no person have their own cap; keys and ids have length limits', () => {
  const r = rig({ limits: { serverJobs: 2, userJobs: 5 } });
  r.s.schedule({ kind: 'sys.tick', at: T0 + MIN, key: 'a' });
  r.s.schedule({ kind: 'sys.tick', at: T0 + MIN, key: 'b' });
  assert.throws(() => r.s.schedule({ kind: 'sys.tick', at: T0 + MIN, key: 'c' }), (e) => e.friendly && /outside any server/.test(e.message));
  assert.doesNotThrow(() => r.s.schedule({ kind: 'sys.tick', at: T0 + 2 * MIN, key: 'b' }));
  assert.doesNotThrow(() => r.s.schedule({ kind: 'pocket.remind', at: T0 + MIN, userId: 'u1' }));
  assert.throws(() => r.s.schedule({ kind: 'x.y', at: T0, serverId: S1, key: 'k'.repeat(201) }), TypeError);
  assert.throws(() => r.s.schedule({ kind: 'x.y', at: T0, serverId: S1, key: '' }), TypeError);
  assert.throws(() => r.s.schedule({ kind: 'x.y', at: T0, serverId: 's'.repeat(101) }), TypeError);
  assert.throws(() => r.s.schedule({ kind: 'x.y', at: T0, userId: 42 }), TypeError);
});

test('a catch-up of thousands of overdue jobs is quick and saves in batches', async () => {
  const base = createMemoryStore();
  let writes = 0;
  const store = { ...base, set(ns, key, value) { if (ns === 'scheduler') writes++; return base.set(ns, key, value); } };
  const r = rig({ store, limits: { userJobs: 1e9 } });
  let n = 0;
  r.s.register('pocket.remind', async () => { n++; await null; });
  const startedAdding = performance.now();
  for (let i = 0; i < 4000; i++) r.s.schedule({ kind: 'pocket.remind', at: T0 + MIN + i, userId: `u${i % 300}`, data: { text: 'drink some water and stretch', channelId: 'c'.repeat(36) } });
  assert.ok(performance.now() - startedAdding < 20000);
  writes = 0;
  r.clock.t += DAY;
  const started = performance.now();
  await r.s.runDue();
  assert.equal(n, 4000);
  assert.ok(performance.now() - started < 8000);
  assert.ok(writes <= 3, `writes ${writes}`);
  assert.equal(r.store.has('scheduler', 'global'), false);
});

test('scheduling the same key while the old job is running replaces it cleanly', async () => {
  const r = rig();
  const seen = [];
  let release;
  r.s.register('engage.giveawayEnd', (job) => { seen.push(job.data); return job.data === 1 ? new Promise((res) => { release = res; }) : undefined; });
  r.s.schedule({ kind: 'engage.giveawayEnd', at: T0, serverId: S1, key: 'g1', data: 1 });
  const done = r.s.runDue();
  await settle();
  const second = r.s.schedule({ kind: 'engage.giveawayEnd', at: T0 + MIN, serverId: S1, key: 'g1', data: 2 });
  release();
  await done;
  assert.deepEqual(r.s.list().map((j) => j.id), [second.id]);
  await r.advance(MIN);
  assert.deepEqual(seen, [1, 2]);
  assert.equal(r.s.list().length, 0);
});

test('a handler may schedule its own follow-up with the same key', async () => {
  const r = rig();
  const seen = [];
  r.s.register('tickets.autoclose', async (job) => {
    seen.push(job.data.step);
    if (job.data.step === 'warn') r.s.schedule({ kind: 'tickets.autoclose', at: r.clock.t + HOUR, serverId: job.serverId, key: job.key, data: { step: 'close' } });
  });
  r.s.schedule({ kind: 'tickets.autoclose', at: T0 + MIN, serverId: S1, key: 'ticket-1', data: { step: 'warn' } });
  await r.advance(MIN);
  assert.equal(r.s.list().length, 1);
  await r.advance(HOUR);
  assert.deepEqual(seen, ['warn', 'close']);
  assert.equal(r.s.list().length, 0);
});

test('more DST cases: Sydney, Lord Howe half-hour shift and a skipped New York time on a weekly job', () => {
  assert.equal(iso(nextRun({ daily: '02:30', tz: 'Australia/Sydney' }, Date.parse('2026-10-03T00:00:00Z'))), '2026-10-03T16:30:00.000Z');
  assert.equal(iso(nextRun({ daily: '02:30', tz: 'Australia/Sydney' }, Date.parse('2026-04-04T00:00:00Z'))), '2026-04-04T15:30:00.000Z');
  assert.equal(iso(nextRun({ daily: '02:15', tz: 'Australia/Lord_Howe' }, Date.parse('2026-10-03T00:00:00Z'))), '2026-10-03T15:45:00.000Z');
  assert.equal(iso(nextRun({ daily: '09:00', tz: 'Asia/Kathmandu' }, Date.parse('2026-03-07T12:00:00Z'))), '2026-03-08T03:15:00.000Z');
  const weekly = { weekly: { days: [0], time: '02:30' }, tz: 'America/New_York' };
  const skipped = nextRun(weekly, Date.parse('2026-03-01T12:00:00Z'));
  assert.equal(iso(skipped), '2026-03-08T07:30:00.000Z');
  assert.equal(iso(nextRun(weekly, skipped)), '2026-03-15T06:30:00.000Z');
  for (const tz of ['Europe/London', 'America/New_York', 'Australia/Sydney']) {
    let t = Date.parse('2026-01-01T00:00:00Z');
    for (let i = 0; i < 400; i++) {
      const next = nextRun({ daily: '01:30', tz }, t);
      assert.ok(next > t && next - t <= 25 * HOUR, `${tz} ${iso(t)}`);
      t = next;
    }
  }
});

test('h.advance steps through every due time; h.skip jumps as if the bot was off', async () => {
  const h = await createHarness({ fakeClock: true, apps: [] });
  const rec = recorder();
  h.engine.scheduler.register('x.tick', rec.fn);
  assert.equal(h.engine.scheduler.now(), h.clock.t);
  h.engine.scheduler.schedule({ kind: 'x.tick', at: h.clock.t + HOUR, repeat: { everyMs: HOUR } });
  await h.advance(5 * HOUR);
  assert.equal(rec.calls.length, 5);
  assert.ok(rec.calls.every((c) => c.job.missed === 0 && !c.job.late));
  await h.skip(5 * HOUR);
  assert.equal(rec.calls.length, 6);
  assert.equal(rec.calls[5].job.missed, 4);

  let attempts = 0;
  h.engine.scheduler.register('x.flaky', async () => { attempts++; throw new Error('nope'); });
  h.engine.scheduler.schedule({ kind: 'x.flaky', at: h.clock.t + MIN });
  await h.advance(HOUR);
  assert.equal(attempts, 4);
  assert.equal(h.engine.scheduler.list({ kind: 'x.flaky' }).length, 0);
});
