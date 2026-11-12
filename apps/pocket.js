import { defineApp } from '../engine/apps.js';
import { card, dialog, button, linkButton, row, ICONS } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { messageFiles, messageLink, isPicture } from '../engine/links.js';
import { tokenize, parseDuration, takeDuration, formatDuration, mentionedUserIds, clip, didYouMean, authorName } from '../engine/parse.js';
import { isTimeZone, partsAt, zonedTime, nextRun } from '../engine/scheduler.js';
import { canMemberSee } from '../engine/visibility.js';

const ID = 'pocket';
const KIND = 'pocket.remind';
const cid = (action, ...args) => customId(ID, action, ...args);

const MAX_NOTES = 100;
const MAX_TODOS = 100;
const MAX_REPEATING = 10;
const MAX_ONE_SHOT = 50;
const NOTE_MAX = 300;
const TODO_MAX = 200;
const REMINDER_MAX = 500;
const AFK_REASON_MAX = 100;
const AFK_LINKS = 10;
const AFK_REPLY_GAP_MS = 10 * 60_000;
const AFK_NOTE_TTL_MS = 30_000;
const WELCOME_TTL_MS = 60_000;
const BOOKMARKS_PER_HOUR = 20;
const BOOKMARK_MEMORY = 20;
const HOUR = 3600_000;
const DAY = 86_400_000;
const MIN_EVERY_MS = 30 * 60_000;
const MAX_AHEAD_MS = 366 * DAY;
const PAGE = 10;
const HELP_REPEAT_MS = 10 * 60_000;
const THROTTLE_LIMIT = 2000;
const MAX_HIGHLIGHTS = 15;
const HIGHLIGHT_MIN = 2;
const HIGHLIGHT_MAX = 50;
const HIGHLIGHT_GAP_MS = 5 * 60_000;
const HIGHLIGHT_SEEN_MS = 5 * 60_000;
const HIGHLIGHTS_PER_HOUR = 20;
const HIGHLIGHTS_PER_MINUTE = 10;
const HIGHLIGHT_INDEX_TTL_MS = 15 * 60_000;
const HIGHLIGHT_TEXT_MAX = 1000;
const HIGHLIGHT_LOOKUPS = 25;
const HIGHLIGHT_NOT_MEMBER_MS = 10 * 60_000;
const KNOWN_SERVERS_SAVED = 50;
const KNOWN_SERVERS_MEMORY = 200;
const MATCHER_LIMIT = 5000;
const WORD_CHARS = /[\p{L}\p{N}_]+/gu;

const DM_WORDS = ['remind', 'note', 'notes', 'todo', 'todos', 'afk', 'pocket', 'help', 'tz', 'highlight', 'highlights'];
const HIGHLIGHT_WORDS = ['highlight', 'highlights', 'hl'];
const DEL_WORDS = ['delete', 'del', 'remove', 'rm', 'forget'];
const DONE_WORDS = ['done', 'check', 'tick', 'finish', 'finished', 'complete', 'undone', 'uncheck', 'untick'];
const CANCEL_WORDS = ['cancel', 'delete', 'del', 'remove', 'stop', 'rm'];
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ZONE_ALIASES = {
  utc: 'UTC', gmt: 'UTC', z: 'UTC', uk: 'Europe/London', bst: 'Europe/London', london: 'Europe/London',
  est: 'America/New_York', edt: 'America/New_York', et: 'America/New_York', cst: 'America/Chicago', cdt: 'America/Chicago',
  mst: 'America/Denver', mdt: 'America/Denver', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles', pt: 'America/Los_Angeles',
  cet: 'Europe/Paris', cest: 'Europe/Paris', eet: 'Europe/Athens', ist: 'Asia/Kolkata', jst: 'Asia/Tokyo', aest: 'Australia/Sydney', nzst: 'Pacific/Auckland',
};

const states = new WeakMap();
function stateOf(engine) {
  let s = states.get(engine);
  if (!s) {
    s = { afkReplies: new Map(), helpShown: new Map(), hlIndex: null, hlSeen: new Map(), hlCool: new Map(), hlHourly: new Map(), hlAbsent: new Map(), hlRecent: [] };
    states.set(engine, s);
  }
  return s;
}

const nowOf = (engine) => engine.scheduler?.now?.() ?? Date.now();
const botId = (engine) => engine.bot.me?.id;
const afkKey = (uid) => `afk-${uid}`;
const reminderKey = (uid, n) => `${uid}:${n}`;
const plain = (text) => String(text ?? '').replace(/@/g, '@​').replace(/<#/g, '<​#');
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

function afterWords(text, n) {
  let s = String(text ?? '').trimStart();
  for (let i = 0; i < n; i++) s = s.replace(/^\S+\s*/, '');
  return s.trim();
}

const blankUser = () => ({ tz: null, notes: [], todos: [], nextNote: 1, nextTodo: 1, nextReminder: 1, bookmarks: { total: 0, times: [], recent: [] }, delivered: {}, highlights: [], highlightsPaused: false, servers: [] });
function fillUser(d) {
  const u = { ...blankUser(), ...(d && typeof d === 'object' ? d : {}) };
  u.notes = Array.isArray(u.notes) ? u.notes : [];
  u.todos = Array.isArray(u.todos) ? u.todos : [];
  u.bookmarks = { total: 0, times: [], recent: [], ...(u.bookmarks || {}) };
  u.delivered = u.delivered && typeof u.delivered === 'object' ? u.delivered : {};
  u.highlights = Array.isArray(u.highlights) ? u.highlights.filter((w) => typeof w === 'string' && w).slice(0, MAX_HIGHLIGHTS) : [];
  u.highlightsPaused = !!u.highlightsPaused;
  u.servers = Array.isArray(u.servers) ? u.servers.filter((s) => typeof s === 'string' && s).slice(-KNOWN_SERVERS_SAVED) : [];
  return u;
}
const readUser = (engine, uid) => fillUser(engine.store.get(ID, uid, null));
function updateUser(engine, uid, fn) {
  let out;
  engine.store.update(ID, uid, (d) => {
    const u = fillUser(d);
    out = fn(u);
    return u;
  }, null);
  return out;
}
const tzOf = (user) => (user?.tz && isTimeZone(user.tz) ? user.tz : 'UTC');

const formatters = new Map();
function formatterFor(tz, kind) {
  const k = `${tz}|${kind}`;
  let f = formatters.get(k);
  if (!f) {
    const opts = kind === 'clock'
      ? { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
      : { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
    f = new Intl.DateTimeFormat('en-GB', opts);
    formatters.set(k, f);
  }
  return f;
}
const clockAt = (ms, tz) => formatterFor(tz, 'clock').format(new Date(ms));
const whenAt = (ms, tz) => `${formatterFor(tz, 'full').format(new Date(ms))} (${tz})`;
const ago = (ms) => (ms < 60_000 ? 'just now' : `${formatDuration(ms)} ago`);

function canonicalZone(tz) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

let zoneList = null;
function allZones() {
  if (!zoneList) {
    try { zoneList = Intl.supportedValuesOf('timeZone'); } catch { zoneList = []; }
  }
  return zoneList;
}
const cityOf = (zone) => zone.split('/').pop().replace(/_/g, ' ').toLowerCase();

export function resolveZone(text) {
  const raw = oneLine(text);
  if (!raw || raw.length > 64) return { zone: null, guesses: [] };
  const lower = raw.toLowerCase();
  if (ZONE_ALIASES[lower]) return { zone: ZONE_ALIASES[lower], guesses: [] };
  const offset = /^(?:utc|gmt)\s*([+-])\s*(\d{1,2})$/i.exec(raw);
  if (offset) {
    const hours = Number(offset[2]);
    if (hours === 0) return { zone: 'UTC', guesses: [] };
    if (hours <= 14) {
      const zone = `Etc/GMT${offset[1] === '+' ? '-' : '+'}${hours}`;
      if (isTimeZone(zone)) return { zone: canonicalZone(zone) || zone, guesses: [] };
    }
  }
  const underscored = raw.replace(/\s+/g, '_');
  if (/^[A-Za-z_+\-/0-9]+$/.test(underscored) && isTimeZone(underscored)) return { zone: canonicalZone(underscored) || underscored, guesses: [] };
  const city = lower.replace(/_/g, ' ');
  const hit = allZones().find((z) => cityOf(z) === city);
  if (hit) return { zone: hit, guesses: [] };
  const guesses = didYouMean(city, allZones().map(cityOf), { limit: 3 }).map((c) => allZones().find((z) => cityOf(z) === c)).filter(Boolean);
  return { zone: null, guesses };
}

function dayIndex(word) {
  const w = String(word ?? '').toLowerCase().replace(/[,.]$/, '');
  if (w.length < 3) return -1;
  const base = w.length > 3 && w.endsWith('s') && !DAY_NAMES.includes(w) ? w.slice(0, -1) : w;
  const tries = [w, base];
  for (const t of tries) {
    const i = DAY_NAMES.findIndex((d) => d === t || (t.length >= 3 && d.startsWith(t)));
    if (i >= 0) return i;
  }
  return -1;
}

function parseClock(words, i, { bare = false } = {}) {
  const tok = String(words[i] ?? '').toLowerCase().replace(/[,]$/, '');
  if (!tok) return null;
  if (tok === 'noon' || tok === 'midday') return { h: 12, mi: 0, used: 1 };
  if (tok === 'midnight') return { h: 0, mi: 0, used: 1 };
  const m = /^(\d{1,2})(?:[:.](\d{2}))?(am|pm|a|p)?$/.exec(tok);
  if (!m) return null;
  let suffix = m[3] || null;
  let used = 1;
  const next = String(words[i + 1] ?? '').toLowerCase();
  if (!suffix && /^(am|pm|a\.m\.|p\.m\.)$/.test(next)) { suffix = next[0]; used = 2; }
  if (!m[2] && !suffix && !bare) return null;
  let h = Number(m[1]);
  const mi = m[2] ? Number(m[2]) : 0;
  if (mi > 59) return null;
  if (suffix) {
    if (h < 1 || h > 12) return null;
    const pm = suffix[0] === 'p';
    h = (h % 12) + (pm ? 12 : 0);
  } else if (h > 23) return null;
  return { h, mi, used };
}

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (c) => `${pad(c.h)}:${pad(c.mi)}`;

function localDay(now, tz, offset) {
  const p = partsAt(now, tz);
  const d = new Date(Date.UTC(p.y, p.mo - 1, p.d + offset));
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay() };
}

const timeError = (body) => Object.assign(new Error(body), { pocketTime: true });

function stripLead(words) {
  const out = [...words];
  while (out.length && /^(me|us)$/i.test(out[0])) out.shift();
  return out;
}

function finishText(words) {
  const rest = [...words];
  if (rest.length > 1 && /^(to|that|about)$/i.test(rest[0])) rest.shift();
  const text = rest.join(' ').trim();
  if (!text) throw timeError('What should I remind you about? Put it after the time, like `/remind in 2h stretch`.');
  if (text.length > REMINDER_MAX) throw timeError(`Keep reminders under ${REMINDER_MAX} characters.`);
  return text;
}

function parseRepeat(words, tz, now) {
  let i = 1;
  const first = String(words[0]).toLowerCase();
  let spec = null;
  let everyMs = null;
  if (first === 'daily') spec = { daily: null };
  else if (first === 'weekdays') spec = { weekly: { days: [1, 2, 3, 4, 5] } };
  else {
    const what = String(words[1] ?? '').toLowerCase().replace(/,$/, '');
    i = 2;
    if (what === 'day' || what === 'days') spec = { daily: null };
    else if (what === 'weekday' || what === 'weekdays') spec = { weekly: { days: [1, 2, 3, 4, 5] } };
    else if (what === 'weekend' || what === 'weekends') spec = { weekly: { days: [0, 6] } };
    else if (what === 'week') spec = { weekly: { days: [localDay(now, tz, 0).dow] } };
    else if (what === 'month') {
      const today = localDay(now, tz, 0).d;
      if (today > 28) throw timeError('Monthly reminders can use days 1 to 28, so they happen every month. Try again on another day, or use `every week`.');
      spec = { monthly: { day: today } };
    } else if (what === 'hour') everyMs = HOUR;
    else if (dayIndex(what.split(',')[0]) >= 0) {
      const days = new Set();
      let j = 1;
      for (; j < words.length; j++) {
        const w = String(words[j]).toLowerCase();
        if ((w === 'and' || w === '&') && dayIndex(words[j + 1]) >= 0) continue;
        const parts = w.split(',').filter(Boolean);
        const found = parts.map(dayIndex);
        if (!parts.length || found.some((d) => d < 0)) break;
        found.forEach((d) => days.add(d));
      }
      i = j;
      spec = { weekly: { days: [...days].sort((a, b) => a - b) } };
    } else {
      const took = takeDuration(words.slice(1), { bareUnit: 'h' });
      if (took.ms === null) throw timeError('How often? Try `every day 8:00`, `every monday 9:00`, `every weekday 7:30` or `every 2h`.');
      everyMs = took.ms;
      i = words.length - took.rest.length;
    }
  }
  if (everyMs !== null) {
    if (everyMs < MIN_EVERY_MS) throw timeError('Repeating reminders need to be at least 30 minutes apart.');
    if (everyMs > 365 * DAY) throw timeError('Repeating reminders need to come at least once a year.');
    return { repeat: { everyMs }, at: now + everyMs, used: i };
  }
  if (/^at$/i.test(words[i] ?? '')) i++;
  const clock = parseClock(words, i, { bare: true });
  if (!clock) throw timeError('Add a time for repeating reminders, like `every day 8:00 water` or `every friday 5pm`.');
  i += clock.used;
  const time = hhmm(clock);
  const full = spec.daily !== undefined ? { daily: time, tz } : spec.weekly ? { weekly: { days: spec.weekly.days, time }, tz } : { monthly: { day: spec.monthly.day, time }, tz };
  return { repeat: full, at: nextRun(full, now), used: i };
}

export function parseWhen(input, { tz = 'UTC', now = Date.now() } = {}) {
  const words = stripLead(String(input ?? '').trim().split(/\s+/).filter(Boolean));
  if (!words.length) throw timeError('When? Try `/remind in 2h stretch` or `/remind tomorrow 9:00 call mum`.');
  const first = words[0].toLowerCase();

  if (first === 'every' || first === 'daily' || first === 'weekdays') {
    const r = parseRepeat(words, tz, now);
    return { at: r.at, repeat: r.repeat, text: finishText(words.slice(r.used)) };
  }

  const hasUnit = (/^(\d+(\.\d+)?[a-z]+)+$/i.test(first) && parseDuration(first) !== null)
    || (/^\d+(\.\d+)?$/.test(first) && /^(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)$/i.test(words[1] ?? ''));
  if (first === 'in' || first === 'after' || hasUnit) {
    const from = first === 'in' || first === 'after' ? 1 : 0;
    const took = takeDuration(words.slice(from));
    if (took.ms === null) throw timeError('How long from now? Try `in 10m`, `in 2h30m` or `in 3 days`.');
    if (took.ms < 60_000) throw timeError('Reminders need to be at least a minute away.');
    if (took.ms > MAX_AHEAD_MS) throw timeError('I can remind you up to a year ahead.');
    return { at: now + took.ms, repeat: null, text: finishText(took.rest) };
  }

  let i = 0;
  let offset = null;
  let weekday = null;
  let date = null;
  let defaultClock = { h: 9, mi: 0 };
  let explicitToday = false;
  if (first === 'today') { offset = 0; explicitToday = true; i = 1; }
  else if (first === 'tonight') { offset = 0; explicitToday = true; defaultClock = { h: 20, mi: 0 }; i = 1; }
  else if (/^(tomorrow|tmrw|tmr|tomorow)$/.test(first)) { offset = 1; i = 1; }
  else if ((first === 'on' || first === 'next') && dayIndex(words[1]) >= 0) { weekday = dayIndex(words[1]); i = 2; }
  else if (/^[a-z]+$/.test(first) && dayIndex(first) >= 0 && (DAY_NAMES.includes(first.replace(/s$/, '')) || parseClock(words, 1, { bare: true }) || /^at$/i.test(words[1] ?? ''))) { weekday = dayIndex(first); i = 1; }
  else if (/^\d{4}-\d{2}-\d{2}$/.test(first)) {
    const [y, mo, d] = first.split('-').map(Number);
    const check = new Date(Date.UTC(y, mo - 1, d));
    if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) throw timeError("That date doesn't exist. Dates look like 2026-12-25.");
    date = { y, mo, d };
    i = 1;
  }
  const hasDay = offset !== null || weekday !== null || date !== null;
  let explicitAt = false;
  if (/^at$/i.test(words[i] ?? '')) { i++; explicitAt = true; }
  let clock = parseClock(words, i, { bare: hasDay || explicitAt });
  if (clock) i += clock.used;
  else if (!hasDay) throw timeError("I didn't catch when. Try `in 2h`, `tomorrow 9:00`, `at 18:30`, `friday 5pm` or `every day 8:00`.");
  else clock = { ...defaultClock, used: 0 };

  let at;
  if (date) {
    at = zonedTime(date.y, date.mo, date.d, clock.h, clock.mi, tz);
    if (at <= now) throw timeError('That time has already passed.');
  } else if (weekday !== null) {
    const today = localDay(now, tz, 0).dow;
    let add = (weekday - today + 7) % 7;
    let day = localDay(now, tz, add);
    at = zonedTime(day.y, day.mo, day.d, clock.h, clock.mi, tz);
    if (at <= now || (first === 'next' && add === 0)) {
      add += 7;
      day = localDay(now, tz, add);
      at = zonedTime(day.y, day.mo, day.d, clock.h, clock.mi, tz);
    }
  } else {
    let day = localDay(now, tz, offset ?? 0);
    at = zonedTime(day.y, day.mo, day.d, clock.h, clock.mi, tz);
    if (at <= now) {
      if (explicitToday) throw timeError(`It's already past ${hhmm(clock)} today. Try \`tomorrow ${hhmm(clock)}\`.`);
      if (offset === null) {
        day = localDay(now, tz, 1);
        at = zonedTime(day.y, day.mo, day.d, clock.h, clock.mi, tz);
      }
    }
  }
  if (at - now > MAX_AHEAD_MS) throw timeError('I can remind you up to a year ahead.');
  return { at, repeat: null, text: finishText(words.slice(i)) };
}

function describeRepeat(rep) {
  if (!rep) return '';
  const zone = rep.tz ? ` (${rep.tz})` : '';
  if (rep.everyMs) return `every ${formatDuration(rep.everyMs)}`;
  if (rep.daily) return `every day at ${rep.daily}${zone}`;
  if (rep.weekly) {
    const d = rep.weekly.days;
    const names = d.join(',') === '1,2,3,4,5' ? 'weekday' : d.join(',') === '0,6' ? 'weekend day' : d.map((x) => DAY_LABELS[x]).join(', ');
    return `every ${names} at ${rep.weekly.time}${zone}`;
  }
  if (rep.monthly) return `every month on day ${rep.monthly.day} at ${rep.monthly.time}${zone}`;
  return 'repeating';
}

const listReminders = (engine, uid) => engine.scheduler.list({ kind: KIND, userId: uid });

function reminderLine(job, tz) {
  const n = job.data?.n ?? '?';
  const text = clip(oneLine(job.data?.text), 80);
  if (job.repeat) return `**#${n}** · 🔁 ${describeRepeat(job.repeat)} · next ${whenAt(job.at, job.repeat.tz || tz)}\n${text}`;
  return `**#${n}** · ${whenAt(job.at, tz)}\n${text}`;
}

function remindExamples() {
  return [
    '`/remind in 2h stretch`',
    '`/remind tomorrow 9:00 call mum`',
    '`/remind friday 5pm pay rent`',
    '`/remind every day 8:00 water`',
    '`/remind list` · `/remind cancel 2`',
  ].join('\n');
}

async function answer(ctx, payload) {
  return ctx.ephemeral(payload);
}

async function runRemind(ctx, raw) {
  const { engine } = ctx;
  const uid = ctx.userId;
  const text = String(raw ?? '').trim();
  const words = text.split(/\s+/).filter(Boolean);
  const sub = (words[0] || '').toLowerCase();
  const user = readUser(engine, uid);
  const tz = tzOf(user);
  if (!sub || sub === 'help') {
    return answer(ctx, { embeds: [card({ title: '⏰ Reminders', body: `I'll DM you when it's time. If your DMs are closed, I'll mention you where you set it.\n\n${remindExamples()}\n\n-# Times are in ${tz}.${user.tz ? '' : ' Set yours with `/pocket tz Europe/London`.'}`, color: 'pocket' })] });
  }
  if (sub === 'list' || sub === 'reminders' || sub === 'all') return answer(ctx, reminderListView(engine, uid));
  if (CANCEL_WORDS.includes(sub) && words.length <= 2 && (words.length === 1 || numberArg(words[1]) || /^(all|everything)$/i.test(words[1]))) return cancelReminder(ctx, words[1]);

  let parsed;
  try {
    parsed = parseWhen(text, { tz, now: nowOf(engine) });
  } catch (e) {
    if (!e.pocketTime) throw e;
    return ctx.warn("I didn't get the time", `${e.message}\n\n${remindExamples()}`);
  }
  const mine = listReminders(engine, uid);
  const repeating = mine.filter((j) => j.repeat).length;
  if (parsed.repeat && repeating >= MAX_REPEATING) return ctx.warn('Too many repeating reminders', `You can have ${MAX_REPEATING} repeating reminders. Cancel one with \`/remind cancel <number>\` (see \`/remind list\`).`);
  if (!parsed.repeat && mine.length - repeating >= MAX_ONE_SHOT) return ctx.warn('Too many reminders', `You can have ${MAX_ONE_SHOT} reminders waiting. Cancel some with \`/remind cancel <number>\`.`);

  const n = updateUser(engine, uid, (u) => {
    const next = Number.isInteger(u.nextReminder) && u.nextReminder > 0 ? u.nextReminder : 1;
    u.nextReminder = next + 1;
    return next;
  });
  const data = { n, text: parsed.text, serverId: ctx.serverId || null, channelId: ctx.serverId ? ctx.channelId : null, setAt: nowOf(engine) };
  let job;
  try {
    job = engine.scheduler.schedule({ kind: KIND, at: parsed.at, userId: uid, key: reminderKey(uid, n), data, repeat: parsed.repeat });
  } catch (e) {
    return ctx.fail(e);
  }
  const zone = parsed.repeat?.tz || tz;
  const whenLine = parsed.repeat
    ? `🔁 ${describeRepeat(job.repeat)}\nFirst one: ${whenAt(job.at, zone)}`
    : `${whenAt(job.at, zone)}, in ${formatDuration(job.at - nowOf(engine))}`;
  const tips = [`\`/remind cancel ${n}\` to cancel`, '`/remind list` to see them all'];
  if (!user.tz) tips.push('set your time zone with `/pocket tz Europe/London`');
  return ctx.ok(`Reminder #${n} set`, `${whenLine}\n> ${clip(oneLine(plain(parsed.text)), 200)}\n-# ${tips.join(' · ')}`);
}

function reminderListView(engine, uid) {
  const user = readUser(engine, uid);
  const tz = tzOf(user);
  const jobs = listReminders(engine, uid);
  if (!jobs.length) return { embeds: [card({ title: '⏰ Your reminders', body: `Nothing waiting.\n\n${remindExamples()}`, color: 'pocket' })] };
  const shown = jobs.slice(0, 15).map((j) => reminderLine(j, tz));
  const more = jobs.length > shown.length ? `\n-# …and ${jobs.length - shown.length} more.` : '';
  return { embeds: [card({ title: `⏰ Your reminders (${jobs.length})`, body: `${shown.join('\n\n')}${more}\n\n-# Cancel one with \`/remind cancel <number>\`, or all with \`/remind cancel all\`.`, color: 'pocket' })] };
}

function cancelJobs(engine, uid, which) {
  const jobs = listReminders(engine, uid);
  const picked = which === 'all' ? jobs : jobs.filter((j) => j.data?.n === which);
  for (const j of picked) engine.scheduler.cancel(j.id);
  return picked;
}

function restoreJobs(engine, uid, jobs) {
  let n = 0;
  for (const j of jobs) {
    const at = j.repeat ? (nextRun(j.repeat, nowOf(engine)) ?? j.at) : j.at;
    try {
      engine.scheduler.schedule({ kind: KIND, at, userId: uid, key: j.key || reminderKey(uid, j.data?.n), data: j.data, repeat: j.repeat });
      n++;
    } catch (e) {
      engine.log.debug('could not restore a reminder', e?.message);
    }
  }
  return n;
}

function undoButton(engine, ctx, label, restore) {
  const uid = ctx.userId;
  return engine.router.addUndo({
    serverId: ctx.serverId,
    actorId: uid,
    label,
    perm: 'member',
    run: async (i) => {
      if (i.user_id !== uid) {
        await i.ephemeral('', { embeds: [dialog.denied(null, { title: 'Not yours', body: 'Only the person who did this can undo it.' })] });
        return false;
      }
      const ok = await restore(i);
      if (ok === false && !i.answered) await i.ephemeral('', { embeds: [dialog.warn("Couldn't undo that", 'Your list is full, or it already came back. Make some room and try again.')] });
      return ok;
    },
  }).button;
}

async function cancelReminder(ctx, token) {
  const { engine } = ctx;
  const uid = ctx.userId;
  const t = String(token ?? '').toLowerCase().replace(/^#/, '');
  if (!t) return ctx.warn('Which one?', 'Add the number from `/remind list`, like `/remind cancel 2`, or `/remind cancel all`.');
  const which = t === 'all' || t === 'everything' ? 'all' : Number(t);
  if (which !== 'all' && (!Number.isInteger(which) || which < 1)) return ctx.warn('Which one?', 'Use the number from `/remind list`, like `/remind cancel 2`.');
  const gone = cancelJobs(engine, uid, which);
  if (!gone.length) return ctx.warn(which === 'all' ? 'Nothing to cancel' : `No reminder #${which}`, which === 'all' ? 'You have no reminders waiting.' : 'It may have gone off already. See `/remind list`.');
  const undo = undoButton(engine, ctx, gone.length === 1 ? `reminder #${gone[0].data?.n}` : 'reminders', async (i) => {
    const back = restoreJobs(engine, uid, gone);
    if (!back) {
      await i.ephemeral('', { embeds: [dialog.warn("Couldn't bring them back", 'You may be at your reminder limit.')] });
      return false;
    }
    return true;
  });
  const what = gone.length === 1 ? `Reminder #${gone[0].data?.n} is cancelled:\n> ${clip(oneLine(plain(gone[0].data?.text)), 200)}` : `All ${gone.length} reminders are cancelled.`;
  return ctx.ok('Cancelled', what, { components: [row(undo)] });
}

async function runAfk(ctx, raw) {
  const { engine } = ctx;
  const uid = ctx.userId;
  const text = oneLine(raw);
  if (/^(off|back|clear|stop|done)$/i.test(text)) {
    const had = engine.store.delete(ID, afkKey(uid));
    return had ? ctx.ok('Welcome back', "You're not AFK any more.") : ctx.info("You weren't AFK", 'Set it with `/afk lunch`.');
  }
  const reason = clip(text || 'AFK', AFK_REASON_MAX);
  engine.store.set(ID, afkKey(uid), { reason, since: nowOf(engine), count: 0, mentions: [] });
  return ctx.ok("You're AFK", `💤 ${plain(reason)}\nWhen someone mentions you I'll let them know. Your next message clears it and shows who mentioned you.\n-# Or type \`/afk off\`.`);
}

async function memberName(engine, sid, uid) {
  if (!sid || !uid) return 'someone';
  const m = await engine.perms.member(sid, uid).catch(() => null);
  return m?.nickname || m?.display_name || m?.username || 'someone';
}

function deleteLater(engine, channelId, message, ms) {
  if (!message?.id) return;
  const t = setTimeout(() => { engine.bot.delete(channelId, message.id).catch(() => {}); }, ms);
  t.unref?.();
}

async function onMessage(ctx, msg) {
  const { engine } = ctx;
  if (!msg || msg.yaposLate || msg.author_bot || !msg.server_id) return;
  const uid = msg.author_id;
  if (!uid || uid === botId(engine)) return;
  const now = nowOf(engine);

  if (engine.store.has(ID, afkKey(uid)) && msg.command !== 'afk' && !(msg.command === 'yap' && /^\s*afk\b/i.test(msg.args || ''))) {
    await welcomeBack(engine, msg, uid, now);
  }

  await afkMentions(engine, msg, uid, now);
  try {
    highlightMessage(engine, msg, uid, now);
  } catch (e) {
    engine.log.debug('[pocket] could not check a message for highlights', e?.message);
  }
}

async function afkMentions(engine, msg, uid, now) {
  const mentioned = [...new Set(mentionedUserIds(msg.content))].filter((id) => id !== uid && id !== botId(engine) && engine.store.has(ID, afkKey(id)));
  if (!mentioned.length) return;
  const st = stateOf(engine);
  const by = clip(authorName(msg), 40);
  const lines = [];
  for (const id of mentioned) {
    const afk = engine.store.update(ID, afkKey(id), (a) => {
      if (!a) return a;
      a.count = (a.count || 0) + 1;
      a.mentions = [...(a.mentions || []), { serverId: msg.server_id, channelId: msg.channel_id, by, at: now }].slice(-AFK_LINKS);
      return a;
    }, null);
    if (!afk) continue;
    const k = `${id}:${msg.server_id}`;
    const last = st.afkReplies.get(k);
    if (last !== undefined && now - last < AFK_REPLY_GAP_MS) continue;
    if (st.afkReplies.size > THROTTLE_LIMIT) for (const [key, t] of st.afkReplies) if (now - t >= AFK_REPLY_GAP_MS) st.afkReplies.delete(key);
    st.afkReplies.set(k, now);
    const name = await memberName(engine, msg.server_id, id);
    lines.push(`💤 **${plain(name)}** is AFK: ${plain(afk.reason)} (since ${ago(now - afk.since)})`);
  }
  if (!lines.length) return;
  try {
    const sent = await engine.budget.send({ serverId: msg.server_id, channelId: msg.channel_id, content: clip(lines.join('\n'), 1900), priority: 'low', opts: { replyTo: msg.id } });
    deleteLater(engine, msg.channel_id, sent, AFK_NOTE_TTL_MS);
  } catch (e) {
    engine.log.debug('could not post the AFK note', e?.message);
  }
}

async function welcomeBack(engine, msg, uid, now) {
  let afk = engine.store.get(ID, afkKey(uid), null);
  if (!engine.store.delete(ID, afkKey(uid)) || !afk) return;
  afk = { count: 0, mentions: [], ...afk };
  const away = formatDuration(Math.max(0, now - (afk.since || now)));
  const here = afk.mentions.filter((m) => m.serverId === msg.server_id);
  const elsewhere = afk.mentions.length - here.length;
  const head = afk.count
    ? `👋 Welcome back, <@${uid}>! You were mentioned ${plural(afk.count, 'time')} while you were away (${away}).`
    : `👋 Welcome back, <@${uid}>! Nobody mentioned you while you were away (${away}).`;
  const links = here.map((m) => `• <#${m.channelId}> by **${plain(m.by)}**, ${ago(now - m.at)}`);
  const more = elsewhere > 0 ? [`-# + ${elsewhere} in other servers.`] : [];
  const older = afk.count > afk.mentions.length ? [`-# I keep the last ${AFK_LINKS}.`] : [];
  try {
    const sent = await engine.budget.send({ serverId: msg.server_id, channelId: msg.channel_id, content: clip([head, ...links, ...more, ...older].join('\n'), 1900), priority: 'normal', opts: { replyTo: msg.id } });
    deleteLater(engine, msg.channel_id, sent, WELCOME_TTL_MS);
  } catch (e) {
    engine.log.debug('could not post the welcome back note', e?.message);
  }
}

const wordsOf = (text) => String(text ?? '').toLowerCase().match(WORD_CHARS) || [];
const escapeRe = (s) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
const hashOf = (s) => {
  let n = 5381;
  for (const ch of String(s)) n = ((n * 33) ^ ch.codePointAt(0)) >>> 0;
  return n.toString(36);
};

const matchers = new Map();
function matcherFor(phrase) {
  let re = matchers.get(phrase);
  if (!re) {
    if (matchers.size >= MATCHER_LIMIT) matchers.clear();
    const body = phrase.split(/\s+/).filter(Boolean).map(escapeRe).join('\\s+');
    re = new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'iu');
    matchers.set(phrase, re);
  }
  return re;
}

export function highlightMatches(phrase, text) {
  const p = cleanHighlight(phrase);
  return !!p && matcherFor(p).test(String(text ?? ''));
}

function cleanHighlight(text) {
  return oneLine(text).replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim().toLowerCase();
}

function checkHighlight(text) {
  const clean = cleanHighlight(text);
  if (!clean) return { error: 'Write the word after it, like `/highlight add pizza`.' };
  if (clean.length < HIGHLIGHT_MIN) return { error: `Highlights need at least ${HIGHLIGHT_MIN} characters.` };
  if (clean.length > HIGHLIGHT_MAX) return { error: `Keep highlights under ${HIGHLIGHT_MAX} characters.` };
  if (!wordsOf(clean).length) return { error: 'A highlight needs at least one letter or number.' };
  return { clean };
}

function indexAdd(index, uid, phrases) {
  if (!phrases.length) return;
  index.users.set(uid, phrases);
  for (const phrase of phrases) {
    const first = wordsOf(phrase)[0];
    if (!first) continue;
    let list = index.byWord.get(first);
    if (!list) { list = []; index.byWord.set(first, list); }
    list.push({ uid, phrase });
  }
}

function indexDrop(index, uid) {
  const had = index.users.get(uid);
  if (!had) return;
  index.users.delete(uid);
  for (const phrase of had) {
    const first = wordsOf(phrase)[0];
    const list = index.byWord.get(first);
    if (!list) continue;
    const kept = list.filter((e) => e.uid !== uid);
    if (kept.length) index.byWord.set(first, kept); else index.byWord.delete(first);
  }
}

function highlightIndex(engine) {
  const st = stateOf(engine);
  const now = nowOf(engine);
  if (st.hlIndex && now - st.hlIndex.builtAt < HIGHLIGHT_INDEX_TTL_MS) return st.hlIndex;
  const index = { builtAt: now, byWord: new Map(), users: new Map(), where: new Map() };
  let keys = [];
  try { keys = engine.store.keys?.(ID) || []; } catch (e) { engine.log.debug('[pocket] could not list saved users for highlights', e?.message); }
  for (const key of keys) {
    if (key.startsWith('afk-')) continue;
    const d = engine.store.get(ID, key, null);
    if (!d || !Array.isArray(d.highlights) || !d.highlights.length) continue;
    const u = fillUser(d);
    indexAdd(index, key, u.highlights);
    if (u.servers.length) index.where.set(key, new Set(u.servers));
  }
  st.hlIndex = index;
  return index;
}

function reindexUser(engine, uid) {
  const index = stateOf(engine).hlIndex;
  if (!index) return;
  indexDrop(index, uid);
  const u = readUser(engine, uid);
  indexAdd(index, uid, u.highlights);
  if (u.highlights.length && u.servers.length) index.where.set(uid, new Set([...(index.where.get(uid) || []), ...u.servers]));
  else if (!u.highlights.length) index.where.delete(uid);
}

function rememberServer(engine, uid, sid) {
  if (!uid || !sid) return;
  const index = highlightIndex(engine);
  const known = index.where.get(uid);
  if (known?.has(sid)) return;
  updateUser(engine, uid, (u) => { u.servers = [...u.servers.filter((s) => s !== sid), sid].slice(-KNOWN_SERVERS_SAVED); });
  const next = known || new Set();
  next.add(sid);
  while (next.size > KNOWN_SERVERS_MEMORY) next.delete(next.values().next().value);
  index.where.set(uid, next);
}

function changeHighlights(engine, uid, fn) {
  const out = updateUser(engine, uid, fn);
  reindexUser(engine, uid);
  return out;
}

function addHighlight(engine, uid, text) {
  const { clean, error } = checkHighlight(text);
  if (error) return { error };
  return changeHighlights(engine, uid, (u) => {
    if (u.highlights.includes(clean)) return { dupe: true, word: clean };
    if (u.highlights.length >= MAX_HIGHLIGHTS) return { full: true };
    u.highlights.push(clean);
    return { word: clean, count: u.highlights.length };
  });
}

function removeHighlight(engine, uid, token) {
  const raw = cleanHighlight(token);
  return changeHighlights(engine, uid, (u) => {
    let i = u.highlights.indexOf(raw);
    if (i < 0) {
      const n = numberArg(raw);
      if (n && n <= u.highlights.length) i = n - 1;
    }
    if (i < 0) return null;
    const [word] = u.highlights.splice(i, 1);
    return { word, index: i };
  });
}

function restoreHighlights(engine, uid, words) {
  return changeHighlights(engine, uid, (u) => {
    const back = words.filter((w) => !u.highlights.includes(w)).slice(0, Math.max(0, MAX_HIGHLIGHTS - u.highlights.length));
    u.highlights.push(...back);
    return back.length;
  });
}

function stamp(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > THROTTLE_LIMIT) map.delete(map.keys().next().value);
}

function within(map, key, now, ttl) {
  const t = map.get(key);
  return t !== undefined && now - t < ttl;
}

const hourlyOf = (st, uid, now) => (st.hlHourly.get(uid) || []).filter((t) => now - t < HOUR);

function isHighlightCommand(msg) {
  if (!msg.command) return false;
  if (msg.command === 'highlight') return true;
  if (msg.command === 'pocket' || msg.command === 'yap') return HIGHLIGHT_WORDS.includes(wordsOf(msg.args)[0]);
  return false;
}

function highlightMessage(engine, msg, uid, now) {
  const st = stateOf(engine);
  const index = highlightIndex(engine);
  if (!index.users.size) return;
  if (index.users.has(uid)) {
    stamp(st.hlSeen, `${uid}:${msg.channel_id}`, now);
    rememberServer(engine, uid, msg.server_id);
  }
  const content = String(msg.content ?? '');
  if (!content.trim() || isHighlightCommand(msg)) return;

  const found = new Map();
  for (const word of new Set(wordsOf(content))) {
    for (const e of index.byWord.get(word) || []) {
      if (e.uid === uid || found.has(e.uid)) continue;
      if (matcherFor(e.phrase).test(content)) found.set(e.uid, e.phrase);
    }
  }
  if (!found.size) return;

  const mentioned = new Set(mentionedUserIds(content));
  for (const m of Array.isArray(msg.mentions) ? msg.mentions : []) mentioned.add(typeof m === 'string' ? m : m?.id);
  const sid = msg.server_id;
  const known = [];
  const unseen = [];
  for (const [target, phrase] of found) {
    if (known.length >= HIGHLIGHT_LOOKUPS) break;
    if (target === botId(engine) || mentioned.has(target)) continue;
    const where = index.where.get(target);
    if (where?.size && !where.has(sid)) continue;
    if (within(st.hlAbsent, `${sid}:${target}`, now, HIGHLIGHT_NOT_MEMBER_MS)) continue;
    const key = `${target}:${msg.channel_id}`;
    if (within(st.hlSeen, key, now, HIGHLIGHT_SEEN_MS) || within(st.hlCool, key, now, HIGHLIGHT_GAP_MS)) continue;
    if (hourlyOf(st, target, now).length >= HIGHLIGHTS_PER_HOUR) continue;
    const user = readUser(engine, target);
    if (user.highlightsPaused || !user.highlights.includes(phrase)) continue;
    (where?.has(sid) ? known : unseen).push({ target, phrase, user, key });
  }
  const picked = [...known, ...unseen].slice(0, HIGHLIGHT_LOOKUPS);
  if (!picked.length) return;
  for (const c of picked) stamp(st.hlCool, c.key, now);
  deliverHighlights(engine, msg, picked, now).catch((e) => engine.log.debug('[pocket] could not deliver highlights', e?.message));
}

async function deliverHighlights(engine, msg, picked, now) {
  const st = stateOf(engine);
  const sid = msg.server_id;
  const channels = await engine.cache.channels(sid).catch(() => []);
  const channel = (Array.isArray(channels) ? channels : []).find((c) => c.id === msg.channel_id);
  for (const c of picked) {
    const release = () => { if (st.hlCool.get(c.key) === now) st.hlCool.delete(c.key); };
    try {
      if (!channel) { release(); continue; }
      const member = await engine.perms.member(sid, c.target).catch(() => undefined);
      if (!member) {
        if (member === null) stamp(st.hlAbsent, `${sid}:${c.target}`, now);
        release();
        continue;
      }
      rememberServer(engine, c.target, sid);
      if (!(await canMemberSee(engine, sid, c.target, msg.channel_id))) { release(); continue; }
      st.hlRecent = st.hlRecent.filter((t) => now - t < 60_000);
      const hourly = hourlyOf(st, c.target, now);
      if (st.hlRecent.length >= HIGHLIGHTS_PER_MINUTE || hourly.length >= HIGHLIGHTS_PER_HOUR) {
        engine.log.debug('[pocket] highlight limit reached, skipping');
        release();
        continue;
      }
      st.hlRecent.push(now);
      stamp(st.hlHourly, c.target, [...hourly, now]);
      await sendHighlight(engine, msg, c.target, c.phrase, channel, c.user);
    } catch (e) {
      release();
      engine.log.debug('[pocket] could not send a highlight', e?.message);
    }
  }
}

async function contextLines(engine, msg) {
  try {
    const recent = await engine.bot.messages(msg.channel_id, 4);
    const list = Array.isArray(recent) ? recent : [];
    const at = list.findIndex((m) => m.id === msg.id);
    const before = (at >= 0 ? list.slice(0, at) : list.filter((m) => m.id !== msg.id)).filter((m) => m.content).slice(-2);
    return before.map((m) => `-# **${plain(clip(authorName(m), 40))}:** ${clip(oneLine(plain(m.content)), 150)}`);
  } catch (e) {
    engine.log.debug('[pocket] could not read context for a highlight', e?.message);
    return [];
  }
}

async function sendHighlight(engine, msg, target, phrase, channel, user) {
  const server = await engine.perms.server(msg.server_id).catch(() => null);
  const link = messageLink(msg.server_id, msg.channel_id, msg.id);
  const sentAt = Date.parse(msg.created_at);
  const author = clip(authorName(msg), 100);
  const context = await contextLines(engine, msg);
  const text = `**${plain(author)}:** ${plain(clip(String(msg.content ?? ''), HIGHLIGHT_TEXT_MAX))}`;
  const fields = [
    { name: 'From', value: author, inline: true },
    { name: 'Where', value: clip(`#${channel.name}${server?.name ? ` in ${server.name}` : ''}`, 200), inline: true },
    { name: 'Sent', value: whenAt(Number.isFinite(sentAt) ? sentAt : nowOf(engine), tzOf(user)), inline: true },
  ];
  const embed = card({
    title: clip(`🔔 "${phrase}" was mentioned in #${channel.name}${server?.name ? ` (${server.name})` : ''}`, 256),
    url: link || undefined,
    body: [...context, text].join('\n'),
    fields,
    color: 'pocket',
    footer: `/highlight remove ${phrase} to stop`,
  });
  try {
    const dm = await engine.bot.dm(target);
    await engine.budget.send({ serverId: null, channelId: dm, content: '', opts: { embeds: [embed], components: link ? [row(linkButton('Jump to message', link, '↗️'))] : [] }, priority: 'low' });
  } catch (e) {
    engine.log.debug(`[pocket] could not DM a highlight (DMs may be closed): ${e?.message}`);
  }
}

function highlightExamples() {
  return [
    '`/highlight add pizza` · `/highlight add game night`',
    '`/highlight list` · `/highlight remove pizza` · `/highlight remove 2`',
    '`/highlight pause` · `/highlight resume` · `/highlight clear`',
  ].join('\n');
}

async function runHighlight(ctx, raw) {
  const out = await highlightCommand(ctx, raw);
  if (ctx.serverId && ctx.userId && readUser(ctx.engine, ctx.userId).highlights.length) rememberServer(ctx.engine, ctx.userId, ctx.serverId);
  return out;
}

async function highlightCommand(ctx, raw) {
  const { engine } = ctx;
  const uid = ctx.userId;
  const text = oneLine(raw);
  const words = text.split(' ').filter(Boolean);
  const sub = (words[0] || '').toLowerCase();
  const rest = afterWords(text, 1);

  if (!sub || ['list', 'show', 'all', 'panel'].includes(sub)) return showPanel(ctx, 'hl');
  if (sub === 'help' || sub === '?') {
    return answer(ctx, { embeds: [card({ title: '🔔 Highlights', body: `Save words or phrases. When someone says one in a channel you can see, I DM you a copy with a link.\nUp to ${MAX_HIGHLIGHTS}, ${HIGHLIGHT_MIN} to ${HIGHLIGHT_MAX} characters each. Whole words only, so **pizza** doesn't match **pizzas**.\nI watch the servers we share where you've sent a message or used /highlight.\n\n${highlightExamples()}`, color: 'pocket' })] });
  }
  if (['add', 'new', 'save', '+'].includes(sub)) return addHighlightReply(ctx, rest);
  if (DEL_WORDS.includes(sub) || sub === '-') {
    if (!rest) return ctx.warn('Which one?', 'Add the word or its number, like `/highlight remove pizza` or `/highlight remove 2`.');
    const gone = removeHighlight(engine, uid, rest);
    if (!gone) return ctx.warn(`"${clip(plain(cleanHighlight(rest)), 50)}" isn't one of yours`, 'See your list with `/highlight list`.');
    const undo = undoButton(engine, ctx, 'highlight', async () => restoreHighlights(engine, uid, [gone.word]) > 0);
    return ctx.ok('Highlight removed', `I won't DM you about **${plain(gone.word)}** any more.`, { components: [row(undo)] });
  }
  if (['clear', 'reset', 'wipe'].includes(sub)) {
    const gone = changeHighlights(engine, uid, (u) => { const was = u.highlights; u.highlights = []; return was; });
    if (!gone.length) return ctx.info('Nothing to clear', "You don't have any highlights yet.");
    const undo = undoButton(engine, ctx, 'highlights', async () => restoreHighlights(engine, uid, gone) > 0);
    return ctx.ok('Highlights cleared', `Removed ${plural(gone.length, 'highlight')}.`, { components: [row(undo)] });
  }
  if (['pause', 'snooze', 'off', 'mute', 'stop'].includes(sub)) {
    updateUser(engine, uid, (u) => { u.highlightsPaused = true; });
    return ctx.ok('Highlights paused', "I won't DM you about your words until you type `/highlight resume`.");
  }
  if (['resume', 'unpause', 'on', 'unmute', 'start'].includes(sub)) {
    updateUser(engine, uid, (u) => { u.highlightsPaused = false; });
    const n = readUser(engine, uid).highlights.length;
    return ctx.ok('Highlights are on', n ? `I'm watching for your ${plural(n, 'word')} again.` : 'Add a word with `/highlight add pizza`.');
  }
  if (words.length === 1) {
    const guess = didYouMean(sub, ['add', 'remove', 'list', 'clear', 'pause', 'resume', 'help']);
    if (guess.length) return ctx.warn("I didn't get that", `Did you mean ${guess.map((g) => `**${g}**`).join(', ')}?\n\n${highlightExamples()}`);
  }
  return addHighlightReply(ctx, text);
}

function addHighlightReply(ctx, text) {
  const out = addHighlight(ctx.engine, ctx.userId, text);
  if (out.error) return ctx.warn('Nothing to save', `${out.error}\n\n${highlightExamples()}`);
  if (out.dupe) return ctx.info('Already saved', `**${plain(out.word)}** is already one of your highlights.`);
  if (out.full) return ctx.warn('Your list is full', `You can have ${MAX_HIGHLIGHTS} highlights. Remove one with \`/highlight remove <word>\`.`);
  const paused = readUser(ctx.engine, ctx.userId).highlightsPaused ? '\n-# Your highlights are paused. Type `/highlight resume` to turn them on.' : '';
  return ctx.ok(`Highlight ${out.count} saved`, `When someone says **${plain(out.word)}** in a channel you can see, I'll DM you.${paused}\n-# \`/highlight list\` to see them all.`);
}

const isBookmark = (emoji) => {
  const e = String(emoji ?? '');
  return e.includes('💬') || /^:?speech_balloon:?$/i.test(e);
};

async function onReaction(ctx, ev) {
  const { engine } = ctx;
  if (!ev?.server_id || !isBookmark(ev.emoji)) return;
  const uid = ev.user_id;
  if (!uid || uid === botId(engine)) return;
  const now = nowOf(engine);
  const reserved = updateUser(engine, uid, (u) => {
    const times = u.bookmarks.times.filter((t) => now - t < HOUR);
    if (times.length >= BOOKMARKS_PER_HOUR) return 'limit';
    if (u.bookmarks.recent.includes(ev.message_id)) return 'dupe';
    u.bookmarks.times = [...times, now];
    u.bookmarks.recent = [...u.bookmarks.recent, ev.message_id].slice(-BOOKMARK_MEMORY);
    return 'ok';
  });
  if (reserved === 'limit') { engine.log.debug(`[pocket] bookmark limit reached for ${uid}`); return; }
  if (reserved !== 'ok') return;
  const release = () => updateUser(engine, uid, (u) => {
    const i = u.bookmarks.times.lastIndexOf(now);
    if (i >= 0) u.bookmarks.times.splice(i, 1);
    u.bookmarks.recent = u.bookmarks.recent.filter((x) => x !== ev.message_id);
  });
  const user = readUser(engine, uid);

  let m;
  try {
    m = await engine.bot.message(ev.channel_id, ev.message_id);
  } catch (e) {
    engine.log.debug('could not read the bookmarked message', e?.message);
    release();
    return;
  }
  if (!m) { release(); return; }
  const namedAuthor = typeof m.author === 'string' ? m.author : m.author?.display_name || m.author?.username;
  const [authorLabel, channels, server] = await Promise.all([
    namedAuthor ? Promise.resolve(namedAuthor) : memberName(engine, ev.server_id, m.author_id),
    engine.cache.channels(ev.server_id).catch(() => []),
    engine.perms.server(ev.server_id).catch(() => null),
  ]);
  const channel = channels.find((c) => c.id === ev.channel_id);
  const where = `${channel ? `#${channel.name}` : 'a channel'}${server?.name ? ` in ${server.name}` : ''}`;
  const sentAt = Date.parse(m.created_at);
  const files = messageFiles(m);
  const link = messageLink(ev.server_id, ev.channel_id, ev.message_id);
  const fields = [
    { name: 'From', value: clip(authorLabel || 'someone', 100), inline: true },
    { name: 'Where', value: clip(where, 200), inline: true },
    { name: 'Sent', value: Number.isFinite(sentAt) ? whenAt(sentAt, tzOf(user)) : 'unknown', inline: true },
  ];
  if (files.length) fields.push({ name: files.length === 1 ? 'Attachment' : 'Attachments', value: clip(files.map((f) => f.url).join('\n'), 1000), inline: false });
  if (link) fields.push({ name: 'Message link', value: link, inline: false });
  const picture = files.find((f) => isPicture(f.name) || isPicture(f.url));
  const embed = card({ title: `💬 Bookmark from ${clip(channel ? `#${channel.name}` : 'a server', 200)}`, url: link || undefined, body: m.content ? clip(m.content, 3800) : '*(no text)*', fields, color: 'pocket', footer: 'Saved with 💬 · YapOS Pocket', image: picture?.url });
  const links = [];
  if (link) links.push(linkButton('Jump to message', link, '↗️'));
  if (files[0]) links.push(linkButton(files.length === 1 ? 'Open file' : 'Open first file', files[0].url, '📎'));

  try {
    const dm = await engine.bot.dm(uid);
    await engine.budget.send({ serverId: null, channelId: dm, content: '', opts: { embeds: [embed], components: links.length ? [row(links)] : [] }, priority: 'low' });
  } catch (e) {
    engine.log.debug(`[pocket] could not DM a bookmark (DMs may be closed): ${e?.message}`);
    release();
    return;
  }
  updateUser(engine, uid, (u) => {
    u.bookmarks.total = (u.bookmarks.total || 0) + 1;
  });
}

async function deliverReminder(job, engine) {
  const uid = job.userId;
  const d = job.data || {};
  if (!uid || !d.text) return;
  const user = readUser(engine, uid);
  if (user.delivered[job.id] === job.at) return;
  const tz = job.repeat?.tz || tzOf(user);
  const notes = [];
  if (job.repeat) notes.push(`🔁 #${d.n} · ${describeRepeat(job.repeat)}`);
  else if (d.setAt) notes.push(`#${d.n} · set ${ago(Math.max(0, job.at - d.setAt))}`);
  const sorry = job.late ? '\n(sorry, I was offline when this was due)' : '';
  const body = `⏰ **Reminder:** ${clip(d.text, REMINDER_MAX)}${sorry}\n-# ${notes.join(' · ')} · due ${whenAt(job.at, tz)}`;

  let delivered = false;
  let dmError = null;
  try {
    const dm = await engine.bot.dm(uid);
    await engine.budget.send({ serverId: null, channelId: dm, content: body, priority: 'normal' });
    delivered = true;
  } catch (e) {
    dmError = e;
  }
  const transient = (e) => !e?.status || e.status === 429 || e.status >= 500;
  if (!delivered && transient(dmError) && !job.repeat && job.attempt < 4) throw dmError || new Error('reminder not delivered');
  if (!delivered && d.serverId && d.channelId && engine.settings.isEnabled(d.serverId, ID)) {
    const content = `<@${uid}> ⏰ **Reminder:** ${plain(clip(d.text, REMINDER_MAX))}${sorry}\n-# I couldn't DM you, so here it is. #${d.n}`;
    await engine.budget.send({ serverId: d.serverId, channelId: d.channelId, content, priority: 'normal' });
    delivered = true;
  }
  if (!delivered) {
    const status = dmError?.status;
    if (!job.repeat && (!status || status === 429 || status >= 500)) throw dmError || new Error('reminder not delivered');
    engine.log.debug(`[pocket] reminder #${d.n} for ${uid} could not be delivered: DMs closed and nowhere else to post`);
  }
  const alive = new Set(listReminders(engine, uid).map((j) => j.id));
  updateUser(engine, uid, (u) => {
    const kept = {};
    for (const [k, v] of Object.entries(u.delivered)) if (alive.has(k)) kept[k] = v;
    kept[job.id] = job.at;
    u.delivered = kept;
  });
}

function pageOf(list, page) {
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  const p = Math.min(Math.max(1, Number(page) || 1), pages);
  return { p, pages, start: (p - 1) * PAGE, items: list.slice((p - 1) * PAGE, p * PAGE) };
}

function navRow(uid, view, p, pages, extra = []) {
  const btns = [];
  if (pages > 1) {
    btns.push(button('Prev', cid('v', uid, view, Math.max(1, p - 1)), 'secondary', '◀️', { disabled: p <= 1 }));
    btns.push(button('Next', cid('v', uid, view, Math.min(pages, p + 1)), 'secondary', '▶️', { disabled: p >= pages }));
  }
  btns.push(...extra);
  btns.push(button('Back', cid('v', uid, 'home', 1), 'secondary', '⬅️'));
  return row(btns.slice(0, 5));
}

function splitRows(btns) {
  const out = [];
  for (let i = 0; i < btns.length; i += 5) out.push(row(btns.slice(i, i + 5)));
  return out;
}

function homeView(engine, uid, { inServer = false, notice = '' } = {}) {
  const user = readUser(engine, uid);
  const tz = tzOf(user);
  const now = nowOf(engine);
  const jobs = listReminders(engine, uid);
  const repeating = jobs.filter((j) => j.repeat).length;
  const afk = engine.store.get(ID, afkKey(uid), null);
  const open = user.todos.filter((t) => !t.done);
  const done = user.todos.length - open.length;
  const preview = (list, fmt) => (inServer || !list.length ? '' : `\n${list.slice(0, 3).map(fmt).join('\n')}${list.length > 3 ? '\n…' : ''}`);
  const fields = [
    { name: '🕒 Time zone', value: `${tz} · ${clockAt(now, tz)} now${user.tz ? '' : '\n-# `/pocket tz Europe/London`'}`, inline: true },
    { name: '⏰ Reminders', value: jobs.length ? `${jobs.length} waiting${repeating ? ` (${repeating} repeating)` : ''}\nNext: ${whenAt(jobs[0].at, jobs[0].repeat?.tz || tz)}` : 'None yet\n-# `/remind in 2h stretch`', inline: true },
    { name: '💤 AFK', value: afk ? `On: ${plain(clip(afk.reason, 60))}\n-# since ${ago(now - afk.since)}` : 'Off', inline: true },
    { name: '📝 Notes', value: `${user.notes.length} of ${MAX_NOTES}${preview(user.notes, (n) => `• ${clip(oneLine(plain(n.text)), 40)}`)}`, inline: true },
    { name: '☑️ To-dos', value: `${open.length} open · ${done} done${preview(open, (t) => `⬜ ${clip(oneLine(plain(t.text)), 40)}`)}`, inline: true },
    { name: '💬 Bookmarks', value: `${user.bookmarks.total || 0} sent to your DMs\n-# React 💬 to any message`, inline: true },
    { name: '🔔 Highlights', value: user.highlights.length ? `${user.highlights.length} of ${MAX_HIGHLIGHTS}${user.highlightsPaused ? ' (paused)' : ''}${preview(user.highlights, (w) => `• ${clip(plain(w), 40)}`)}` : 'None yet\n-# `/highlight add pizza`', inline: true },
  ];
  const intro = inServer ? 'Your personal assistant. Only you can press these buttons.\n-# Want it private? Type **pocket** in my DMs.' : 'Your personal assistant. Type **help** to see everything you can tell me.';
  const btns = [
    button('Notes', cid('v', uid, 'notes', 1), 'secondary', '📝'),
    button('To-dos', cid('v', uid, 'todos', 1), 'secondary', '☑️'),
    button('Reminders', cid('v', uid, 'rems', 1), 'secondary', '⏰'),
    button('Highlights', cid('v', uid, 'hl', 1), 'secondary', '🔔'),
    button('Time zone', cid('tz', uid), 'secondary', '🕒'),
  ];
  if (afk) btns.push(button("I'm back", cid('back', uid), 'success', '👋'));
  return {
    content: '',
    embeds: [card({ title: `${ICONS.pocket} YapOS Pocket`, body: [notice, intro].filter(Boolean).join('\n\n'), fields, color: 'pocket' })],
    components: splitRows(btns),
  };
}

function highlightsView(engine, uid, { notice = '', extra = [] } = {}) {
  const user = readUser(engine, uid);
  const list = user.highlights;
  const lines = list.map((w, i) => `**${i + 1}.** ${clip(plain(w), 60)}`);
  const status = user.highlightsPaused ? '⏸️ Paused. I won\'t DM you until you resume.' : '';
  const body = list.length ? lines.join('\n') : 'No highlights yet. Press **Add** or type `/highlight add pizza`.';
  const hint = '-# When someone says one of these in a channel you can see, I DM you a copy. 🗑️ buttons remove one.';
  const del = list.map((w, i) => button(`${i + 1}`, cid('hd', uid, hashOf(w)), 'secondary', '🗑️'));
  const tools = [];
  if (list.length < MAX_HIGHLIGHTS) tools.push(button('Add', cid('ha', uid), 'success', '➕'));
  tools.push(user.highlightsPaused ? button('Resume', cid('hp', uid, 'on'), 'primary', '▶️') : button('Pause', cid('hp', uid, 'off'), 'secondary', '⏸️'));
  return {
    content: '',
    embeds: [card({ title: `🔔 Highlights (${list.length}/${MAX_HIGHLIGHTS})`, body: [notice, status, body, hint].filter(Boolean).join('\n\n'), color: 'pocket' })],
    components: [...splitRows(del), navRow(uid, 'hl', 1, 1, [...tools, ...extra])],
  };
}

function notesView(engine, uid, page, { notice = '', extra = [] } = {}) {
  const user = readUser(engine, uid);
  const { p, pages, start, items } = pageOf(user.notes, page);
  const now = nowOf(engine);
  const lines = items.map((n, i) => `**${start + i + 1}.** ${clip(oneLine(plain(n.text)), 150)} · *${ago(now - n.at)}*`);
  const body = user.notes.length ? lines.join('\n') : 'No notes yet. Press **Add** or type `/pocket note buy milk`.';
  const del = items.map((n, i) => button(`${start + i + 1}`, cid('nd', uid, n.id, p), 'secondary', '🗑️'));
  const add = user.notes.length < MAX_NOTES ? [button('Add', cid('na', uid), 'success', '➕')] : [];
  return {
    content: '',
    embeds: [card({ title: `📝 Notes (${user.notes.length}/${MAX_NOTES})${pages > 1 ? ` · page ${p}/${pages}` : ''}`, body: [notice, body, user.notes.length ? '-# 🗑️ buttons delete a note.' : ''].filter(Boolean).join('\n\n'), color: 'pocket' })],
    components: [...splitRows(del), navRow(uid, 'notes', p, pages, [...add, ...extra])],
  };
}

function todosView(engine, uid, page, { notice = '', extra = [] } = {}) {
  const user = readUser(engine, uid);
  const { p, pages, start, items } = pageOf(user.todos, page);
  const lines = items.map((t, i) => (t.done ? `✅ ~~${start + i + 1}. ${clip(oneLine(plain(t.text)), 150)}~~` : `⬜ **${start + i + 1}.** ${clip(oneLine(plain(t.text)), 150)}`));
  const open = user.todos.filter((t) => !t.done).length;
  const body = user.todos.length ? lines.join('\n') : 'Nothing to do. Press **Add** or type `/pocket todo finish essay`.';
  const toggles = items.map((t, i) => button(`${start + i + 1}`, cid('td', uid, t.id, p), t.done ? 'success' : 'secondary', t.done ? '✅' : '⬜'));
  const tools = [];
  if (user.todos.length < MAX_TODOS) tools.push(button('Add', cid('ta', uid), 'success', '➕'));
  if (user.todos.length - open > 0) tools.push(button('Clear done', cid('tc', uid), 'secondary', '🧹'));
  return {
    content: '',
    embeds: [card({ title: `☑️ To-dos (${open} open)${pages > 1 ? ` · page ${p}/${pages}` : ''}`, body: [notice, body, user.todos.length ? '-# Press a number to tick it off or back on.' : ''].filter(Boolean).join('\n\n'), color: 'pocket' })],
    components: [...splitRows(toggles), navRow(uid, 'todos', p, pages, [...tools, ...extra])],
  };
}

function remindersView(engine, uid, page, { notice = '', extra = [] } = {}) {
  const user = readUser(engine, uid);
  const tz = tzOf(user);
  const jobs = listReminders(engine, uid);
  const { p, pages, items } = pageOf(jobs, page);
  const body = jobs.length ? items.map((j) => reminderLine(j, tz)).join('\n\n') : `Nothing waiting.\n\n${remindExamples()}`;
  const cancels = items.map((j) => button(`#${j.data?.n}`, cid('rc', uid, j.data?.n, p), 'secondary', '✖️'));
  return {
    content: '',
    embeds: [card({ title: `⏰ Reminders (${jobs.length})${pages > 1 ? ` · page ${p}/${pages}` : ''}`, body: [notice, body, jobs.length ? '-# ✖️ buttons cancel a reminder.' : ''].filter(Boolean).join('\n\n'), color: 'pocket' })],
    components: [...splitRows(cancels), navRow(uid, 'rems', p, pages, extra)],
  };
}

function viewFor(engine, uid, view, page, opts = {}) {
  if (view === 'notes') return notesView(engine, uid, page, opts);
  if (view === 'todos') return todosView(engine, uid, page, opts);
  if (view === 'rems') return remindersView(engine, uid, page, opts);
  if (view === 'hl') return highlightsView(engine, uid, opts);
  return homeView(engine, uid, opts);
}

async function showPanel(ctx, view = 'home', page = 1, opts = {}) {
  return ctx.ephemeral(viewFor(ctx.engine, ctx.userId, view, page, { inServer: !!ctx.serverId, ...opts }));
}

function addNote(engine, uid, text) {
  const clean = String(text ?? '').trim();
  if (!clean) return { error: 'Write the note after the word, like `/pocket note buy milk`.' };
  if (clean.length > NOTE_MAX) return { error: `Keep notes under ${NOTE_MAX} characters.` };
  return updateUser(engine, uid, (u) => {
    if (u.notes.length >= MAX_NOTES) return { full: true };
    const id = u.nextNote++;
    u.notes.push({ id, text: clean, at: nowOf(engine) });
    return { id, count: u.notes.length };
  });
}

function addTodo(engine, uid, text) {
  const clean = oneLine(text);
  if (!clean) return { error: 'Write the to-do after the word, like `/pocket todo finish essay`.' };
  if (clean.length > TODO_MAX) return { error: `Keep to-dos under ${TODO_MAX} characters.` };
  return updateUser(engine, uid, (u) => {
    if (u.todos.length >= MAX_TODOS) return { full: true };
    const id = u.nextTodo++;
    u.todos.push({ id, text: clean, done: false, at: nowOf(engine) });
    return { id, count: u.todos.length };
  });
}

function removeNoteAt(engine, uid, match) {
  return updateUser(engine, uid, (u) => {
    const i = u.notes.findIndex(match);
    if (i < 0) return null;
    const [note] = u.notes.splice(i, 1);
    return { note, index: i };
  });
}

function restoreNote(engine, uid, note) {
  return updateUser(engine, uid, (u) => {
    if (u.notes.length >= MAX_NOTES || u.notes.some((n) => n.id === note.id)) return false;
    u.notes.push(note);
    u.notes.sort((a, b) => a.id - b.id);
    return true;
  });
}

function toggleTodo(engine, uid, match, wanted) {
  return updateUser(engine, uid, (u) => {
    const t = u.todos.find(match);
    if (!t) return null;
    t.done = typeof wanted === 'boolean' ? wanted : !t.done;
    t.doneAt = t.done ? nowOf(engine) : null;
    return { ...t };
  });
}

function removeTodos(engine, uid, match) {
  return updateUser(engine, uid, (u) => {
    const gone = u.todos.filter(match);
    u.todos = u.todos.filter((t) => !match(t));
    return gone;
  });
}

function restoreTodos(engine, uid, todos) {
  return updateUser(engine, uid, (u) => {
    const have = new Set(u.todos.map((t) => t.id));
    const back = todos.filter((t) => !have.has(t.id)).slice(0, Math.max(0, MAX_TODOS - u.todos.length));
    u.todos.push(...back);
    u.todos.sort((a, b) => a.id - b.id);
    return back.length;
  });
}

const numberArg = (token) => {
  const n = Number(String(token ?? '').replace(/^#/, ''));
  return Number.isInteger(n) && n >= 1 ? n : null;
};

async function setZone(ctx, raw) {
  const { engine } = ctx;
  const uid = ctx.userId;
  const text = oneLine(raw);
  const user = readUser(engine, uid);
  if (!text) {
    const tz = tzOf(user);
    return ctx.info('Your time zone', `${tz}${user.tz ? '' : ' (not set yet)'}. It's ${clockAt(nowOf(engine), tz)} there now.\nChange it with \`/pocket tz Europe/London\` (or a city, like \`/pocket tz new york\`).`);
  }
  const { zone, guesses } = resolveZone(text);
  if (!zone) {
    return ctx.warn("I don't know that time zone", `Use a name like \`Europe/London\`, \`America/New_York\` or a city like \`tokyo\`.${guesses.length ? `\nDid you mean ${guesses.map((g) => `**${g}**`).join(', ')}?` : ''}`);
  }
  updateUser(engine, uid, (u) => { u.tz = zone; });
  let moved = 0;
  for (const j of listReminders(engine, uid)) {
    if (!j.repeat || j.repeat.everyMs || j.repeat.tz === zone) continue;
    const repeat = { ...j.repeat, tz: zone };
    try {
      engine.scheduler.schedule({ kind: KIND, userId: uid, key: j.key, data: j.data, repeat });
      moved++;
    } catch (e) {
      engine.log.debug('could not move a repeating reminder to the new zone', e?.message);
    }
  }
  const extra = moved ? `\nYour ${plural(moved, 'repeating reminder')} now follow${moved === 1 ? 's' : ''} it too.` : '';
  return ctx.ok('Time zone saved', `${zone}. It's ${clockAt(nowOf(engine), zone)} there now.${extra}`);
}

async function runPocket(ctx, raw) {
  const { engine } = ctx;
  const uid = ctx.userId;
  const text = String(raw ?? '').trim();
  const words = text.split(/\s+/).filter(Boolean);
  const sub = (words[0] || '').toLowerCase().replace(/^[/!]/, '');
  const second = (words[1] || '').toLowerCase();
  const rest = afterWords(text, 1);

  if (!sub || sub === 'panel' || sub === 'home' || sub === 'menu') return showPanel(ctx, 'home');
  if (sub === 'help') return answer(ctx, helpCard(engine));
  if (sub === 'tz' || sub === 'timezone' || sub === 'zone' || sub === 'time') return setZone(ctx, rest);
  if (sub === 'afk') return runAfk(ctx, rest);
  if (sub === 'remind' || sub === 'reminder' || sub === 'reminders') return words.length > 1 ? runRemind(ctx, rest) : showPanel(ctx, 'rems');
  if (HIGHLIGHT_WORDS.includes(sub)) return runHighlight(ctx, rest);

  if (sub === 'note' || sub === 'notes') {
    if (!rest || (sub === 'notes' && /^(list|all|show)$/.test(rest))) return showPanel(ctx, 'notes');
    if (sub === 'note' && /^(list|all|show)$/.test(rest)) return showPanel(ctx, 'notes');
    if (DEL_WORDS.includes(second) && words.length === 3 && numberArg(words[2])) {
      const pos = numberArg(words[2]);
      const user = readUser(engine, uid);
      const target = user.notes[pos - 1];
      if (!target) return ctx.warn(`No note ${pos}`, `You have ${plural(user.notes.length, 'note')}. See them with \`/pocket notes\`.`);
      const gone = removeNoteAt(engine, uid, (n) => n.id === target.id);
      const undo = undoButton(engine, ctx, 'note', async (i) => {
        if (restoreNote(engine, uid, gone.note)) return true;
        await i.ephemeral('', { embeds: [dialog.warn("Couldn't bring it back", 'Your notebook is full.')] });
        return false;
      });
      return ctx.ok('Note deleted', `> ${clip(oneLine(plain(gone.note.text)), 200)}`, { components: [row(undo)] });
    }
    if (sub === 'notes') return showPanel(ctx, 'notes');
    const out = addNote(engine, uid, rest);
    if (out.error) return ctx.warn('Nothing to save', out.error);
    if (out.full) return ctx.warn('Your notebook is full', `You have ${MAX_NOTES} notes. Delete some with \`/pocket notes\`.`);
    return ctx.ok(`Note ${out.count} saved`, `> ${clip(oneLine(plain(rest)), 200)}\n-# \`/pocket notes\` to see them all.`);
  }

  if (sub === 'todo' || sub === 'todos' || sub === 'task' || sub === 'tasks') {
    if (!rest || /^(list|all|show)$/.test(rest)) return showPanel(ctx, 'todos');
    if (second === 'clear' && words.length === 2) {
      const gone = removeTodos(engine, uid, (t) => t.done);
      if (!gone.length) return ctx.info('Nothing to clear', 'None of your to-dos are ticked off yet.');
      const undo = undoButton(engine, ctx, 'clear', async () => restoreTodos(engine, uid, gone) > 0);
      return ctx.ok('Cleared', `Removed ${plural(gone.length, 'finished to-do')}.`, { components: [row(undo)] });
    }
    const pos = numberArg(words[2]);
    if ((DONE_WORDS.includes(second) || DEL_WORDS.includes(second)) && words.length === 3 && pos) {
      const user = readUser(engine, uid);
      const target = user.todos[pos - 1];
      if (!target) return ctx.warn(`No to-do ${pos}`, `You have ${plural(user.todos.length, 'to-do')}. See them with \`/pocket todos\`.`);
      if (DEL_WORDS.includes(second)) {
        const gone = removeTodos(engine, uid, (t) => t.id === target.id);
        const undo = undoButton(engine, ctx, 'to-do', async () => restoreTodos(engine, uid, gone) > 0);
        return ctx.ok('To-do deleted', `> ${clip(oneLine(plain(target.text)), 200)}`, { components: [row(undo)] });
      }
      const wanted = !/^un/.test(second);
      const t = toggleTodo(engine, uid, (x) => x.id === target.id, wanted);
      return ctx.ok(t.done ? 'Done!' : 'Back on the list', `${t.done ? '✅' : '⬜'} ${clip(oneLine(plain(t.text)), 200)}`);
    }
    if (sub === 'todos' || sub === 'tasks') return showPanel(ctx, 'todos');
    const out = addTodo(engine, uid, rest);
    if (out.error) return ctx.warn('Nothing to add', out.error);
    if (out.full) return ctx.warn('Your list is full', `You have ${MAX_TODOS} to-dos. Clear finished ones with \`/pocket todo clear\`.`);
    return ctx.ok(`To-do ${out.count} added`, `⬜ ${clip(oneLine(plain(rest)), 200)}\n-# Tick it off with \`/pocket todo done ${out.count}\` or the buttons in \`/pocket todos\`.`);
  }

  const guess = didYouMean(sub, ['note', 'notes', 'todo', 'todos', 'tz', 'afk', 'remind', 'highlight', 'help']);
  return ctx.warn("I didn't get that", `I don't know **${clip(sub.replace(/[^a-z0-9-]/gi, ''), 30) || 'that'}**.${guess.length ? ` Did you mean ${guess.map((g) => `**${g}**`).join(', ')}?` : ''}\nTry \`/pocket\` on its own for your panel, or \`/pocket help\`.`);
}

function helpCard(engine) {
  const lines = [
    '⏰ `remind in 2h stretch` · `remind tomorrow 9:00 call mum`',
    '🔁 `remind every day 8:00 water` · `remind list` · `remind cancel 2`',
    '📝 `note buy milk` · `notes`',
    '☑️ `todo finish essay` · `todos` · `todo done 1`',
    '🕒 `tz Europe/London`',
    '💤 `afk lunch` · `afk off`',
    '🔔 `highlight add pizza` · `highlights` · `highlight pause`',
    '📱 `pocket` opens your panel',
  ];
  if (engine.apps.has('studio')) lines.push('🎞️ send a picture with `caption your text` to make a GIF');
  return {
    content: "👋 Hi! I'm **YapOS Pocket**, your personal assistant.",
    embeds: [card({
      title: `${ICONS.pocket} What you can type here`,
      body: `${lines.join('\n')}\n\n-# In a server: **/remind**, **/afk**, **/pocket**, **/highlight**, and react 💬 to any message to get a copy in your DMs.`,
      color: 'pocket',
    })],
  };
}

function dmHelp(engine, uid) {
  const st = stateOf(engine);
  const now = nowOf(engine);
  const last = st.helpShown.get(uid);
  if (st.helpShown.size > THROTTLE_LIMIT) st.helpShown.clear();
  if (last !== undefined && now - last < HELP_REPEAT_MS) {
    return { content: "I didn't get that. Type **help** to see what I can do here." };
  }
  st.helpShown.set(uid, now);
  return helpCard(engine);
}

const dmWord = (content) => String(content ?? '').trim().split(/\s+/)[0]?.toLowerCase().replace(/^[/!]/, '') || '';

async function runDm(ctx, msg) {
  const raw = String(msg?.content ?? '').trim().replace(/^[/!]/, '');
  const word = dmWord(raw);
  const rest = afterWords(raw, 1);
  ctx.args = rest;
  ctx.argv = tokenize(rest);
  if (word === 'remind') return runRemind(ctx, rest);
  if (word === 'afk') return runAfk(ctx, rest);
  if (word === 'help') return answer(ctx, helpCard(ctx.engine));
  if (HIGHLIGHT_WORDS.includes(word)) return runHighlight(ctx, rest);
  if (word === 'pocket') return runPocket(ctx, rest);
  return runPocket(ctx, raw);
}

const own = (run) => ({ owner: true, ownerArg: 0, run });

async function updateView(ctx, view, page, opts = {}) {
  return ctx.update(viewFor(ctx.engine, ctx.userId, view, page, { inServer: !!ctx.serverId, ...opts }));
}

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Pocket',
  icon: ICONS.pocket,
  description: 'Your assistant: reminders, notes, to-dos, AFK, bookmarks, highlights.',
  category: 'Personal',
  panelPerm: 'member',

  commands: {
    remind: { description: 'Reminders by DM: /remind in 2h stretch, /remind tomorrow 9:00 call mum, /remind list', run: (ctx) => runRemind(ctx, ctx.args) },
    afk: { description: "Go AFK: /afk lunch. I'll tell people who mention you. /afk off to come back", run: (ctx) => runAfk(ctx, ctx.args) },
    pocket: { description: 'Your personal panel: /pocket note buy milk, /pocket todo finish essay, /pocket tz Europe/London', run: (ctx) => runPocket(ctx, ctx.args) },
    highlight: { description: 'DM me when someone says your words: /highlight add pizza, /highlight list', run: (ctx) => runHighlight(ctx, ctx.args) },
  },

  components: {
    v: own((ctx) => updateView(ctx, ctx.argv[1], ctx.argv[2])),
    td: own(async (ctx) => {
      const id = Number(ctx.argv[1]);
      const t = toggleTodo(ctx.engine, ctx.userId, (x) => x.id === id);
      return updateView(ctx, 'todos', ctx.argv[2], { notice: t ? '' : 'That to-do is gone already.' });
    }),
    tc: own(async (ctx) => {
      const uid = ctx.userId;
      const gone = removeTodos(ctx.engine, uid, (t) => t.done);
      if (!gone.length) return updateView(ctx, 'todos', 1, { notice: 'Nothing to clear.' });
      const undo = undoButton(ctx.engine, ctx, 'clear', async () => restoreTodos(ctx.engine, uid, gone) > 0);
      return updateView(ctx, 'todos', 1, { notice: `🧹 Cleared ${plural(gone.length, 'finished to-do')}.`, extra: [undo] });
    }),
    nd: own(async (ctx) => {
      const uid = ctx.userId;
      const id = Number(ctx.argv[1]);
      const gone = removeNoteAt(ctx.engine, uid, (n) => n.id === id);
      if (!gone) return updateView(ctx, 'notes', ctx.argv[2], { notice: 'That note is gone already.' });
      const undo = undoButton(ctx.engine, ctx, 'note', async (i) => {
        if (restoreNote(ctx.engine, uid, gone.note)) return true;
        await i.ephemeral('', { embeds: [dialog.warn("Couldn't bring it back", 'Your notebook is full.')] });
        return false;
      });
      return updateView(ctx, 'notes', ctx.argv[2], { notice: `🗑️ Deleted: ${clip(oneLine(plain(gone.note.text)), 80)}`, extra: [undo] });
    }),
    rc: own(async (ctx) => {
      const uid = ctx.userId;
      const n = Number(ctx.argv[1]);
      const gone = cancelJobs(ctx.engine, uid, n);
      if (!gone.length) return updateView(ctx, 'rems', ctx.argv[2], { notice: `Reminder #${n} has gone off or was cancelled already.` });
      const undo = undoButton(ctx.engine, ctx, `#${n}`, async () => restoreJobs(ctx.engine, uid, gone) > 0);
      return updateView(ctx, 'rems', ctx.argv[2], { notice: `✖️ Cancelled #${n}: ${clip(oneLine(plain(gone[0].data?.text)), 80)}`, extra: [undo] });
    }),
    back: own(async (ctx) => {
      const had = ctx.engine.store.delete(ID, afkKey(ctx.userId));
      return updateView(ctx, 'home', 1, { notice: had ? "👋 Welcome back! You're not AFK any more." : '' });
    }),
    tz: own((ctx) => ctx.form({
      title: 'Your time zone',
      action: 'tzsave',
      fields: [{ id: 'tz', label: 'Time zone or city', style: 'short', placeholder: 'Europe/London or new york', value: readUser(ctx.engine, ctx.userId).tz || '', max: 64 }],
    })),
    tzsave: { run: (ctx) => setZone(ctx, ctx.values?.tz) },
    na: own((ctx) => ctx.form({
      title: 'New note',
      action: 'notesave',
      fields: [{ id: 'text', label: 'Note', style: 'paragraph', placeholder: 'buy milk', max: NOTE_MAX }],
    })),
    notesave: {
      run: async (ctx) => {
        const out = addNote(ctx.engine, ctx.userId, ctx.values?.text);
        if (out.error) return ctx.warn('Nothing to save', out.error);
        if (out.full) return ctx.warn('Your notebook is full', `You have ${MAX_NOTES} notes. Delete some first.`);
        return ctx.ok(`Note ${out.count} saved`, `> ${clip(oneLine(plain(ctx.values?.text)), 200)}`);
      },
    },
    ta: own((ctx) => ctx.form({
      title: 'New to-do',
      action: 'todosave',
      fields: [{ id: 'text', label: 'To-do', style: 'short', placeholder: 'finish essay', max: TODO_MAX }],
    })),
    todosave: {
      run: async (ctx) => {
        const out = addTodo(ctx.engine, ctx.userId, ctx.values?.text);
        if (out.error) return ctx.warn('Nothing to add', out.error);
        if (out.full) return ctx.warn('Your list is full', `You have ${MAX_TODOS} to-dos. Clear finished ones first.`);
        return ctx.ok(`To-do ${out.count} added`, `⬜ ${clip(oneLine(plain(ctx.values?.text)), 200)}`);
      },
    },
    ha: own((ctx) => ctx.form({
      title: 'New highlight',
      action: 'hlsave',
      fields: [{ id: 'text', label: 'Word or phrase', style: 'short', placeholder: 'pizza', max: HIGHLIGHT_MAX }],
    })),
    hlsave: { run: (ctx) => addHighlightReply(ctx, ctx.values?.text) },
    hd: own(async (ctx) => {
      const uid = ctx.userId;
      const word = readUser(ctx.engine, uid).highlights.find((w) => hashOf(w) === ctx.argv[1]);
      const gone = word ? removeHighlight(ctx.engine, uid, word) : null;
      if (!gone) return updateView(ctx, 'hl', 1, { notice: 'That highlight is gone already.' });
      const undo = undoButton(ctx.engine, ctx, 'highlight', async () => restoreHighlights(ctx.engine, uid, [gone.word]) > 0);
      return updateView(ctx, 'hl', 1, { notice: `🗑️ Removed: ${clip(plain(gone.word), 60)}`, extra: [undo] });
    }),
    hp: own(async (ctx) => {
      const paused = ctx.argv[1] === 'off';
      updateUser(ctx.engine, ctx.userId, (u) => { u.highlightsPaused = paused; });
      return updateView(ctx, 'hl', 1, { notice: paused ? '⏸️ Highlights paused.' : '▶️ Highlights are on again.' });
    }),
  },

  jobs: {
    remind: deliverReminder,
  },

  events: {
    message: onMessage,
    reaction_add: onReaction,
  },

  dm: {
    match: (msg) => DM_WORDS.includes(dmWord(msg?.content)),
    run: runDm,
  },

  yap: [
    { words: ['remind', 'reminder', 'reminders'], run: (ctx) => runRemind(ctx, ctx.args) },
    { words: ['afk'], run: (ctx) => runAfk(ctx, ctx.args) },
    { words: ['pocket'], run: (ctx) => runPocket(ctx, ctx.args) },
    { words: ['todo', 'todos'], run: (ctx) => runPocket(ctx, `${ctx.word} ${ctx.args}`) },
    { words: ['highlight', 'highlights'], run: (ctx) => runHighlight(ctx, ctx.args) },
  ],

  panel: (ctx) => showPanel(ctx, 'home'),

  services: (engine) => ({
    dmHelp: (uid) => dmHelp(engine, uid),
    helpCard: () => helpCard(engine),
    afkOf: (uid) => engine.store.get(ID, afkKey(uid), null),
    timeZone: (uid) => tzOf(readUser(engine, uid)),
  }),

  help: [
    'Reminders come by DM. If your DMs are closed, I mention you in the channel where you set it. Up to 10 repeating ones each.',
    'Times use your time zone: `/pocket tz Europe/London` (UTC until you set one).',
    'React 💬 to any message and I DM you a copy (up to 20 an hour).',
    'Highlights: `/highlight add pizza` and I DM you when someone says it in a channel you can see. Up to 15 words, `/highlight pause` to snooze.',
    'Everything works in my DMs too: type **help** there.',
  ],

  dispose: (engine) => { states.delete(engine); },
});
