import crypto from 'node:crypto';
import { FriendlyError } from './errors.js';

export const MAX_DELAY = 2 ** 31 - 1;
export const RETRY_DELAYS = [60_000, 5 * 60_000, 30 * 60_000];
export const MAX_TRIES = RETRY_DELAYS.length + 1;
export const LIMITS = {
  serverJobs: 1000,
  userJobs: 100,
  dataBytes: 16 * 1024,
  minEveryMs: 60_000,
  servers: 4,
  softTimeoutMs: 30_000,
  hardTimeoutMs: 15 * 60_000,
  lateMs: 60_000,
  wakeSlackMs: 60_000,
  wakeCheckMs: 5 * 60_000,
  persistEveryMs: 200,
  minRescheduleMs: 1000,
  keyLength: 200,
  idLength: 100,
};

const NS = 'scheduler';
const GLOBAL = 'global';
const DAY = 86_400_000;
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const QUERY_FIELDS = ['kind', 'serverId', 'key', 'userId'];
const HUNG = Symbol('hung');

const friendly = (message, title) => new FriendlyError(message, { title });

const formatters = new Map();
function formatterFor(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(tz, f);
  }
  return f;
}

export function isTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

export function partsAt(ms, tz = 'UTC') {
  const out = {};
  for (const p of formatterFor(tz).formatToParts(new Date(ms))) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return { y: out.year, mo: out.month, d: out.day, h: out.hour === 24 ? 0 : out.hour, mi: out.minute, s: out.second };
}

function offsetAt(ms, tz) {
  const p = partsAt(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

export function zonedTime(y, mo, d, h, mi, tz = 'UTC') {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const before = offsetAt(wall - DAY, tz);
  const after = offsetAt(wall + DAY, tz);
  const fits = [...new Set([before, after])]
    .map((o) => wall - o)
    .filter((t) => offsetAt(t, tz) === wall - t)
    .sort((a, b) => a - b);
  return fits.length ? fits[0] : wall - before;
}

function cleanTime(value) {
  const m = TIME_RE.exec(String(value ?? '').trim());
  if (!m) throw friendly('Times look like 09:00 or 18:30 (24-hour clock).', 'Check the time');
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

export function normalizeRepeat(spec) {
  if (spec === null || spec === undefined) return null;
  if (typeof spec !== 'object') throw friendly("I didn't understand how often to repeat that.", 'Check the repeat');
  const tz = spec.tz ?? 'UTC';
  if (!isTimeZone(tz)) throw friendly(`I don't know the time zone "${tz}". Use a name like Europe/London or America/New_York.`, 'Unknown time zone');
  if (spec.everyMs !== undefined) {
    const every = Number(spec.everyMs);
    if (!Number.isFinite(every) || every < LIMITS.minEveryMs) throw friendly('Repeats need to be at least 1 minute apart.', 'Too often');
    return { everyMs: Math.round(every) };
  }
  if (spec.daily !== undefined) return { daily: cleanTime(spec.daily), tz };
  if (spec.weekly !== undefined) {
    const raw = Array.isArray(spec.weekly?.days) ? spec.weekly.days : [];
    const days = [...new Set(raw.map(Number))].sort((a, b) => a - b);
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw friendly('Pick at least one day of the week (Sunday to Saturday).', 'Check the days');
    return { weekly: { days, time: cleanTime(spec.weekly.time) }, tz };
  }
  if (spec.monthly !== undefined) {
    const day = Number(spec.monthly?.day);
    if (!Number.isInteger(day) || day < 1 || day > 28) throw friendly('Monthly repeats can use days 1 to 28, so they happen every month.', 'Check the day');
    return { monthly: { day, time: cleanTime(spec.monthly.time) }, tz };
  }
  throw friendly("I didn't understand how often to repeat that.", 'Check the repeat');
}

function calendarNext(rep, fromMs) {
  const tz = rep.tz || 'UTC';
  const [hh, mm] = (rep.daily || rep.weekly?.time || rep.monthly?.time).split(':').map(Number);
  const start = partsAt(fromMs, tz);
  if (rep.monthly) {
    for (let i = 0; i < 4; i++) {
      const month = new Date(Date.UTC(start.y, start.mo - 1 + i, 1));
      const t = zonedTime(month.getUTCFullYear(), month.getUTCMonth() + 1, rep.monthly.day, hh, mm, tz);
      if (t > fromMs) return t;
    }
    return null;
  }
  for (let i = 0; i < 10; i++) {
    const day = new Date(Date.UTC(start.y, start.mo - 1, start.d + i));
    if (rep.weekly && !rep.weekly.days.includes(day.getUTCDay())) continue;
    const t = zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, tz);
    if (t > fromMs) return t;
  }
  return null;
}

export function nextRun(spec, fromMs) {
  const rep = normalizeRepeat(spec);
  if (!rep) return null;
  if (rep.everyMs) return fromMs + rep.everyMs;
  return calendarNext(rep, fromMs);
}

function upcoming(rep, at, t) {
  if (rep.everyMs) return at + Math.max(1, Math.floor((t - at) / rep.everyMs) + 1) * rep.everyMs;
  let next = calendarNext(rep, at);
  for (let guard = 0; next !== null && next <= t && guard < 100_000; guard++) next = calendarNext(rep, next);
  if (next === null || next <= t) next = calendarNext(rep, t);
  return next ?? t + DAY;
}

function countMissed(rep, at, t) {
  if (t <= at) return 0;
  if (rep.everyMs) return Math.floor((t - at) / rep.everyMs);
  let n = 0;
  let next = calendarNext(rep, at);
  while (next !== null && next <= t && n < 100_000) {
    n++;
    next = calendarNext(rep, next);
  }
  return n;
}

export function formatWait(ms) {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

const optionalId = (v, name, max) => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' || !v || v.length > max) throw new TypeError(`scheduler: ${name} must be a string of up to ${max} characters, or null`);
  return v;
};

export function createScheduler({
  store,
  log = null,
  engine = null,
  now = () => Date.now(),
  setTimeout: setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimeout: clearTimer = (t) => clearTimeout(t),
  limits = {},
} = {}) {
  if (!store) throw new Error('createScheduler needs a store');
  const L = { ...LIMITS, ...limits };
  const handlers = new Map();
  const jobs = new Map();
  const buckets = new Map();
  const userCounts = new Map();
  const running = new Set();
  const overdueAtLoad = new Set();
  const active = new Map();
  const dirty = new Set();
  const flushedAt = new Map();
  const storm = new Set();
  const counters = { ran: 0, failed: 0, late: 0, dropped: 0, wakes: 0, hung: 0 };
  let anonGlobal = 0;
  let flushQueued = false;
  let loaded = false;
  let started = false;
  let stopped = false;
  let timer = null;
  let plannedAt = null;
  let manual = 0;

  const auto = () => started && !stopped;
  const bucketOf = (job) => job.serverId ?? GLOBAL;
  const isAnon = (job) => !job.serverId && !job.userId;

  const publicJob = (job) => structuredClone({
    id: job.id, kind: job.kind, at: job.at, data: job.data, serverId: job.serverId, userId: job.userId,
    key: job.key, repeat: job.repeat, createdAt: job.createdAt, runs: job.runs,
  });
  const storedJob = (job) => ({
    id: job.id, kind: job.kind, at: job.at, data: job.data, serverId: job.serverId, userId: job.userId,
    key: job.key, repeat: job.repeat, createdAt: job.createdAt, runs: job.runs, tries: job.tries,
  });

  function addJob(job) {
    jobs.set(job.id, job);
    const b = bucketOf(job);
    if (!buckets.has(b)) buckets.set(b, new Map());
    buckets.get(b).set(job.id, job);
    if (job.userId) userCounts.set(job.userId, (userCounts.get(job.userId) || 0) + 1);
    if (isAnon(job)) anonGlobal++;
  }

  function removeJob(job) {
    if (jobs.get(job.id) !== job) return false;
    jobs.delete(job.id);
    overdueAtLoad.delete(job.id);
    const b = bucketOf(job);
    const bucket = buckets.get(b);
    bucket?.delete(job.id);
    if (bucket && !bucket.size) buckets.delete(b);
    if (job.userId) {
      const n = (userCounts.get(job.userId) || 1) - 1;
      if (n > 0) userCounts.set(job.userId, n);
      else userCounts.delete(job.userId);
    }
    if (isAnon(job)) anonGlobal--;
    return true;
  }

  function flush(b) {
    if (!dirty.has(b)) return;
    dirty.delete(b);
    flushedAt.set(b, now());
    const bucket = buckets.get(b);
    try {
      if (!bucket || !bucket.size) store.delete(NS, b);
      else store.set(NS, b, { jobs: [...bucket.values()].map(storedJob) });
    } catch (e) {
      dirty.add(b);
      log?.error?.(`[scheduler] couldn't save scheduled jobs in data/${NS} (${b}); I'll try again on the next change`, e);
    }
  }

  function flushAll() {
    for (const b of [...dirty]) flush(b);
  }

  function persist(b, { soon = false } = {}) {
    dirty.add(b);
    if (soon && now() - (flushedAt.get(b) ?? -Infinity) < L.persistEveryMs) return;
    if (flushQueued) return;
    flushQueued = true;
    queueMicrotask(() => {
      flushQueued = false;
      flushAll();
    });
  }

  const persistAfterRun = (b) => persist(b, { soon: storm.has(b) });

  function revive(raw, b) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || typeof raw.kind !== 'string' || !Number.isFinite(raw.at)) return null;
    let repeat = null;
    try {
      repeat = normalizeRepeat(raw.repeat);
    } catch {
      return null;
    }
    return {
      id: raw.id,
      kind: raw.kind,
      at: raw.at,
      data: raw.data ?? null,
      serverId: b === GLOBAL ? null : b,
      userId: typeof raw.userId === 'string' && raw.userId ? raw.userId : null,
      key: raw.key === null || raw.key === undefined ? null : String(raw.key),
      repeat,
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : raw.at,
      runs: Number.isInteger(raw.runs) ? raw.runs : 0,
      tries: Number.isInteger(raw.tries) ? raw.tries : 0,
    };
  }

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    const t = now();
    for (const b of store.keys(NS)) {
      const doc = store.get(NS, b, null);
      const list = Array.isArray(doc?.jobs) ? doc.jobs : [];
      let skipped = 0;
      for (const raw of list) {
        const job = revive(raw, b);
        if (!job || jobs.has(job.id)) {
          skipped++;
          continue;
        }
        addJob(job);
        if (job.at <= t) overdueAtLoad.add(job.id);
      }
      if (skipped) {
        log?.warn?.(`[scheduler] skipped ${skipped} damaged scheduled job${skipped === 1 ? '' : 's'} in data/${NS} (${b})`);
        persist(b);
      }
    }
  }

  const runnable = (job) => handlers.has(job.kind) && !running.has(job.id);

  function rearm() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (!auto() || active.size >= L.servers) return;
    let next = null;
    for (const job of jobs.values()) {
      if (!runnable(job) || active.has(bucketOf(job))) continue;
      if (next === null || job.at < next) next = job.at;
    }
    if (next === null) return;
    const t = now();
    const delay = Math.min(MAX_DELAY, L.wakeCheckMs, Math.max(0, next - t));
    plannedAt = t + delay;
    timer = setTimer(onTimer, delay);
    timer?.unref?.();
  }

  function onTimer() {
    timer = null;
    const drift = plannedAt === null ? 0 : now() - plannedAt;
    plannedAt = null;
    if (drift > L.wakeSlackMs) {
      counters.wakes++;
      log?.info?.(`[scheduler] woke up ${formatWait(drift)} late (the computer was probably asleep), catching up on scheduled jobs`);
    }
    pump();
  }

  function pump() {
    const t = now();
    const due = new Map();
    for (const job of jobs.values()) {
      if (job.at > t || !runnable(job)) continue;
      const b = bucketOf(job);
      if (!due.has(b) || job.at < due.get(b)) due.set(b, job.at);
    }
    const order = [...due].sort((a, b) => a[1] - b[1]).map(([b]) => b);
    for (const b of order) {
      if (active.has(b)) continue;
      if (active.size >= L.servers) break;
      const p = drain(b)
        .catch((e) => log?.error?.('[scheduler] a run of scheduled jobs stopped early:', e))
        .finally(() => {
          active.delete(b);
          if (auto() || manual) pump();
        });
      active.set(b, p);
    }
    rearm();
  }

  async function drain(b) {
    try {
      for (;;) {
        const bucket = buckets.get(b);
        if (!bucket) return;
        const t = now();
        const due = [...bucket.values()].filter((job) => job.at <= t && runnable(job)).sort((x, y) => x.at - y.at);
        if (!due.length) return;
        if (due.length > 1) storm.add(b);
        else storm.delete(b);
        for (const job of due) {
          if (jobs.get(job.id) !== job || !runnable(job) || job.at > now()) continue;
          await runWithSoftTimeout(job);
        }
      }
    } finally {
      storm.delete(b);
      flush(b);
    }
  }

  async function runWithSoftTimeout(job) {
    const done = runOne(job).then(() => 'done');
    let slowTimer = null;
    const slow = new Promise((resolve) => {
      slowTimer = setTimer(() => resolve('slow'), L.softTimeoutMs);
      slowTimer?.unref?.();
    });
    const outcome = await Promise.race([done, slow]);
    clearTimer(slowTimer);
    if (outcome === 'slow') log?.warn?.(`[scheduler] ${job.kind} is taking longer than ${formatWait(L.softTimeoutMs)}; moving on and letting it finish in the background`);
  }

  function drop(job, why, err) {
    removeJob(job);
    persistAfterRun(bucketOf(job));
    counters.dropped++;
    if (err) log?.error?.(`[scheduler] gave up on ${job.kind} ${why}`, err);
    else log?.warn?.(`[scheduler] gave up on ${job.kind} ${why}`);
  }

  async function callHandler(handler, view) {
    let hardTimer = null;
    const hard = new Promise((resolve) => {
      hardTimer = setTimer(() => resolve(HUNG), L.hardTimeoutMs);
      hardTimer?.unref?.();
    });
    const work = Promise.resolve()
      .then(() => handler(view, engine))
      .then((value) => ({ value }), (error) => ({ error: error || new Error('job failed') }));
    const out = await Promise.race([work, hard]);
    clearTimer(hardTimer);
    if (out !== HUNG) return out;
    counters.hung++;
    work.then((late) => log?.warn?.(`[scheduler] ${view.kind} finished${late.error ? ' with an error' : ''} after I had already stopped waiting for it`));
    return { error: new Error(`${view.kind} was still running after ${formatWait(L.hardTimeoutMs)}, so I stopped waiting for it`) };
  }

  async function runOne(job) {
    try {
      await runOneUnsafe(job);
    } catch (e) {
      running.delete(job.id);
      log?.error?.(`[scheduler] something went wrong around ${job.kind}; trying it again in ${formatWait(RETRY_DELAYS[0])}`, e);
      if (jobs.get(job.id) === job) job.at = now() + RETRY_DELAYS[0];
      try {
        rearm();
      } catch {}
    }
  }

  async function runOneUnsafe(job) {
    const handler = handlers.get(job.kind);
    if (!handler || jobs.get(job.id) !== job) return;
    const startAt = now();
    if (job.tries >= MAX_TRIES) {
      if (!job.repeat) {
        drop(job, `after ${MAX_TRIES} tries (it kept stopping part-way)`);
        return;
      }
      log?.warn?.(`[scheduler] skipped one run of ${job.kind} (it kept stopping part-way)`);
      job.tries = 0;
      job.at = upcoming(job.repeat, job.at, startAt);
      persistAfterRun(bucketOf(job));
      return;
    }
    const missed = job.repeat ? countMissed(job.repeat, job.at, startAt) : 0;
    job.tries += 1;
    persistAfterRun(bucketOf(job));
    running.add(job.id);
    const lateByMs = Math.max(0, startAt - job.at);
    const late = overdueAtLoad.has(job.id) || lateByMs > L.lateMs;
    overdueAtLoad.delete(job.id);
    if (late) counters.late++;
    const view = { ...publicJob(job), attempt: job.tries, late, lateByMs, missed };
    const { value, error = null } = await callHandler(handler, view);
    running.delete(job.id);
    finish(job, value, error);
  }

  function finish(job, result, error) {
    const t = now();
    if (error) counters.failed++;
    else counters.ran++;
    const b = bucketOf(job);
    if (jobs.get(job.id) !== job) {
      if (!active.has(b)) rearm();
      return;
    }
    if (!error) job.runs++;
    if (error) {
      if (job.repeat) {
        log?.error?.(`[scheduler] ${job.kind} failed; it will run again at its next time`, error);
        job.tries = 0;
        job.at = upcoming(job.repeat, job.at, t);
        persistAfterRun(b);
      } else if (job.tries <= RETRY_DELAYS.length) {
        const wait = RETRY_DELAYS[job.tries - 1];
        log?.error?.(`[scheduler] ${job.kind} failed (try ${job.tries} of ${MAX_TRIES}); trying again in ${formatWait(wait)}`, error);
        job.at = t + wait;
        persistAfterRun(b);
      } else {
        drop(job, `after ${MAX_TRIES} tries`, error);
      }
    } else if (result && typeof result === 'object' && Number.isFinite(result.reschedule)) {
      job.at = Math.max(Math.round(result.reschedule), t + L.minRescheduleMs);
      job.tries = 0;
      persistAfterRun(b);
    } else if (job.repeat) {
      job.tries = 0;
      job.at = upcoming(job.repeat, job.at, t);
      persistAfterRun(b);
    } else {
      removeJob(job);
      persistAfterRun(b);
    }
    if (!active.has(b)) rearm();
  }

  function encodeData(kind, data) {
    let json;
    try {
      json = JSON.stringify(data ?? null);
    } catch (e) {
      throw new TypeError(`scheduler: the data for ${kind} can't be saved (${e.message})`);
    }
    if (json === undefined) throw new TypeError(`scheduler: the data for ${kind} can't be saved as JSON`);
    if (Buffer.byteLength(json, 'utf8') > L.dataBytes) throw friendly("That's too much to schedule in one go. Make it shorter and try again.", 'Too long to schedule');
    return JSON.parse(json);
  }

  function findKeyed(kind, serverId, key) {
    const bucket = buckets.get(serverId ?? GLOBAL);
    if (!bucket) return null;
    for (const job of bucket.values()) if (job.kind === kind && job.key === key) return job;
    return null;
  }

  function checkCaps(serverId, userId, replacing) {
    if (serverId) {
      const have = (buckets.get(serverId)?.size || 0) - (replacing ? 1 : 0);
      if (have >= L.serverJobs) {
        throw friendly(`This server already has ${L.serverJobs} things scheduled, which is the most I can keep track of. Cancel a few (old reminders, giveaways or scheduled posts) and try again.`, 'Too many scheduled things');
      }
    }
    if (!serverId && !userId) {
      const have = anonGlobal - (replacing && isAnon(replacing) ? 1 : 0);
      if (have >= L.serverJobs) {
        throw friendly(`There are already ${L.serverJobs} things scheduled outside any server, which is the most I can keep track of. Cancel a few and try again.`, 'Too many scheduled things');
      }
    }
    if (userId) {
      const have = (userCounts.get(userId) || 0) - (replacing && replacing.userId === userId ? 1 : 0);
      if (have >= L.userJobs) {
        throw friendly(`You already have ${L.userJobs} things scheduled, which is the most I can keep for one person. Cancel a few and try again.`, 'Too many scheduled things');
      }
    }
  }

  function schedule({ kind, at, data = null, serverId = null, userId = null, key = null, repeat = null } = {}) {
    ensureLoaded();
    if (typeof kind !== 'string' || !kind.trim() || kind.length > 80) throw new TypeError('scheduler.schedule needs a kind, a short string like "mod.unban"');
    const sid = optionalId(serverId, 'serverId', L.idLength);
    const uid = optionalId(userId, 'userId', L.idLength);
    const k = key === null || key === undefined ? null : String(key);
    if (k !== null && (!k || k.length > L.keyLength)) throw new TypeError(`scheduler.schedule: key must be 1 to ${L.keyLength} characters for ${kind}`);
    const rep = normalizeRepeat(repeat);
    let when = at instanceof Date ? at.getTime() : at;
    if ((when === null || when === undefined) && rep) when = nextRun(rep, now());
    if (typeof when !== 'number' || !Number.isFinite(when)) throw new TypeError(`scheduler.schedule needs at (a time in epoch ms) for ${kind}`);
    const clean = encodeData(kind, data);
    const existing = k === null ? null : findKeyed(kind, sid, k);
    checkCaps(sid, uid, existing);
    if (existing) removeJob(existing);
    const job = { id: crypto.randomUUID(), kind, at: Math.round(when), data: clean, serverId: sid, userId: uid, key: k, repeat: rep, createdAt: now(), runs: 0, tries: 0 };
    addJob(job);
    persist(bucketOf(job));
    if (auto()) pump();
    return publicJob(job);
  }

  function matches(job, q) {
    for (const f of QUERY_FIELDS) {
      if (q[f] === undefined) continue;
      const want = f === 'key' && q[f] !== null ? String(q[f]) : q[f];
      if (job[f] !== want) return false;
    }
    return true;
  }

  function cancel(id) {
    ensureLoaded();
    const job = jobs.get(id);
    if (!job) return false;
    removeJob(job);
    persist(bucketOf(job));
    rearm();
    return true;
  }

  function cancelWhere(q = {}) {
    ensureLoaded();
    if (!QUERY_FIELDS.some((f) => q[f] !== undefined)) throw new TypeError('scheduler.cancelWhere needs at least one of kind, serverId, key or userId');
    const pool = q.serverId !== undefined ? [...(buckets.get(q.serverId ?? GLOBAL)?.values() || [])] : [...jobs.values()];
    const touched = new Set();
    let n = 0;
    for (const job of pool) {
      if (!matches(job, q)) continue;
      removeJob(job);
      touched.add(bucketOf(job));
      n++;
    }
    for (const b of touched) persist(b);
    if (n) rearm();
    return n;
  }

  function get(id) {
    ensureLoaded();
    const job = jobs.get(id);
    return job ? publicJob(job) : null;
  }

  function list(q = {}) {
    ensureLoaded();
    const pool = q.serverId !== undefined ? [...(buckets.get(q.serverId ?? GLOBAL)?.values() || [])] : [...jobs.values()];
    return pool.filter((j) => matches(j, q)).sort((a, b) => a.at - b.at || a.createdAt - b.createdAt).map(publicJob);
  }

  function register(kind, handler) {
    if (typeof kind !== 'string' || !kind.trim()) throw new TypeError('scheduler.register needs a kind');
    if (typeof handler !== 'function') throw new TypeError(`scheduler.register needs a handler function for ${kind}`);
    handlers.set(kind, handler);
    if (loaded && auto()) pump();
    return () => unregister(kind, handler);
  }

  function unregister(kind, handler) {
    if (!handlers.has(kind)) return false;
    if (handler && handlers.get(kind) !== handler) return false;
    handlers.delete(kind);
    rearm();
    return true;
  }

  function start() {
    if (auto()) return;
    started = true;
    stopped = false;
    ensureLoaded();
    const waiting = overdueAtLoad.size;
    if (waiting) log?.info?.(`[scheduler] catching up on ${waiting} scheduled job${waiting === 1 ? '' : 's'} from while I was offline`);
    pump();
  }

  function stop() {
    stopped = true;
    flushAll();
    if (timer !== null) clearTimer(timer);
    timer = null;
    plannedAt = null;
  }

  async function runDue() {
    ensureLoaded();
    manual++;
    try {
      pump();
      while (active.size) await Promise.allSettled([...active.values()]);
    } finally {
      manual--;
      flushAll();
      rearm();
    }
  }

  function stats() {
    ensureLoaded();
    let nextAt = null;
    let waiting = 0;
    for (const job of jobs.values()) {
      if (nextAt === null || job.at < nextAt) nextAt = job.at;
      if (!handlers.has(job.kind)) waiting++;
    }
    return { jobs: jobs.size, nextAt, ran: counters.ran, failed: counters.failed, late: counters.late, dropped: counters.dropped, running: running.size, waiting, wakes: counters.wakes, hung: counters.hung };
  }

  return {
    register,
    unregister,
    schedule,
    cancel,
    cancelWhere,
    get,
    list,
    nextRun,
    start,
    stop,
    runDue,
    stats,
    flush: flushAll,
    now: () => now(),
    has: (kind) => handlers.has(kind),
    get started() { return auto(); },
    get timerDelay() { return timer === null || plannedAt === null ? null : Math.max(0, plannedAt - now()); },
  };
}
