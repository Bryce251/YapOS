import { h, plural } from './dom.js';
import { sendDaily, dailyTop, cachedTop, DAILY_KINDS } from '../admin.js';

export const DAILY_NAMES = Object.freeze({ hive: 'Letter Hive', scramble: 'Scramble Race' });
export const TOP_SHOW = 10;
export const PLAYS_KEEP = 8;

let plays = new Map();
let subs = new Set();
let poster = sendDaily;
let topper = dailyTop;

export function configureDaily(opts = {}) {
  if (typeof opts.post === 'function') poster = opts.post;
  if (typeof opts.top === 'function') topper = opts.top;
}

export function resetDaily() {
  plays = new Map();
  subs = new Set();
  poster = sendDaily;
  topper = dailyTop;
}

function keyOf(kind, date) {
  return `${kind}|${date}`;
}

function tell() {
  for (const fn of [...subs]) {
    try {
      fn();
    } catch {}
  }
}

export function onDaily(fn) {
  if (typeof fn !== 'function') return () => {};
  subs.add(fn);
  return () => subs.delete(fn);
}

export function dailyPlay(kind, date) {
  const p = plays.get(keyOf(kind, date));
  return p ? { ...p } : null;
}

function hasScore(p) {
  if (p.kind === 'hive') return Array.isArray(p.words) && p.words.length > 0;
  return Array.isArray(p.answers) && p.answers.some(Boolean);
}

export function noteDaily(kind, date, data = {}) {
  if (!DAILY_KINDS.includes(kind) || typeof date !== 'string' || !date) return null;
  const key = keyOf(kind, date);
  const was = plays.get(key);
  if (was && was.state !== 'idle') return { ...was };
  const user = data.user && data.user.id ? { id: String(data.user.id), name: data.user.name || 'Player', username: data.user.username || null } : was ? was.user : null;
  const next = { kind, date, user, words: was ? was.words : [], answers: was ? was.answers : [], ms: was ? was.ms : 0, state: 'idle', result: null };
  if (Array.isArray(data.words)) next.words = data.words.filter((w) => typeof w === 'string').slice(0, 200);
  if (Array.isArray(data.answers)) next.answers = data.answers.map((a) => (typeof a === 'string' ? a : '')).slice(0, 5);
  if (Number.isFinite(data.ms)) next.ms = Math.max(0, Math.round(data.ms));
  plays.delete(key);
  plays.set(key, next);
  while (plays.size > PLAYS_KEEP) plays.delete(plays.keys().next().value);
  return { ...next };
}

export function finishDaily(kind, date) {
  const key = keyOf(kind, date);
  const p = plays.get(key);
  if (!p) return Promise.resolve(null);
  if (p.state !== 'idle') return p.wait || Promise.resolve(p.result);
  if (!p.user || !hasScore(p)) {
    p.state = 'empty';
    tell();
    return Promise.resolve(null);
  }
  p.state = 'sending';
  const body = { date: p.date, kind: p.kind, user: p.user, ms: p.ms };
  if (p.kind === 'hive') body.words = p.words;
  else body.answers = p.answers;
  let wait;
  try {
    wait = Promise.resolve(poster(body));
  } catch {
    wait = Promise.resolve(null);
  }
  p.wait = wait
    .catch(() => null)
    .then((res) => {
      p.state = res ? 'done' : 'error';
      p.result = res || null;
      tell();
      return p.result;
    });
  tell();
  return p.wait;
}

export function streakText(n) {
  if (!(n > 0)) return '';
  if (n === 1) return '🔥 1-day streak. Come back tomorrow to keep it going!';
  return `🔥 ${n}-day streak!`;
}

export function myLine(p) {
  if (!p) return null;
  if (p.state === 'sending') return { tone: 'wait', text: 'Saving your daily score…' };
  if (p.state === 'empty') return { tone: 'muted', text: p.kind === 'hive' ? 'Find at least one word to get on today’s board.' : 'Solve at least one word to get on today’s board.' };
  if (p.state === 'error') return { tone: 'bad', text: "Your daily score didn't save this time. Your game still counts here!" };
  if (p.state === 'done' && p.result) {
    const r = p.result;
    const rank = r.rank ? ` · #${r.rank} today` : '';
    const best = Number.isFinite(r.best) && r.best > r.score ? ` · your best today is ${plural(r.best, 'point', 'points')}` : '';
    const paid = r.shards > 0 ? ` · +${r.shards} 💎` : '';
    return { tone: 'good', text: `Your daily score: ${plural(r.score, 'point', 'points')}${best}${rank}${paid}`, streak: streakText(r.streak) };
  }
  return null;
}

function topRow(r, i) {
  return h(
    'li',
    { class: ['daily-row', i < 3 ? `is-top-${i + 1}` : null], vars: { '--i': i } },
    h('span', { class: 'daily-place', text: String(i + 1) }),
    h('span', { class: 'daily-who' }, h('strong', { class: 'daily-name', text: r.name }), r.username ? h('span', { class: 'daily-handle', text: `@${r.username}` }) : null),
    r.streak > 1 ? h('span', { class: 'daily-streak', text: `🔥${r.streak}`, attrs: { title: `${r.streak}-day streak` } }) : null,
    h('span', { class: 'daily-score fx-num', text: String(r.score) }),
  );
}

export function dailyView(m) {
  const name = DAILY_NAMES[m.kind] || 'Daily puzzle';
  const mine = myLine(m.play);
  const rows = Array.isArray(m.top) ? m.top.slice(0, TOP_SHOW) : null;
  return h(
    'div',
    { class: ['daily-box', m.compact ? 'is-compact' : null] },
    h('div', { class: 'daily-head' }, h('span', { class: 'daily-badge', text: '📅', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'daily-title', text: `Daily ${name}` }), m.date ? h('span', { class: 'daily-date', text: m.date }) : null),
    m.intro ? h('p', { class: 'daily-intro', text: m.intro }) : null,
    mine ? h('p', { class: ['daily-mine', `is-${mine.tone}`, mine.tone === 'good' ? 'fx-pop' : null], attrs: { role: 'status' } }, mine.text) : null,
    mine && mine.streak ? h('p', { class: 'daily-streak-line fx-pop', text: mine.streak }) : null,
    h('span', { class: 'eyebrow daily-top-title', text: "Today's best" }),
    rows === null
      ? h('p', { class: 'muted daily-empty', text: m.loading ? 'Loading today’s best…' : "Today's best couldn't load right now." })
      : rows.length
      ? h('ol', { class: 'daily-top fx-stagger', attrs: { 'aria-label': "Today's best" } }, rows.map(topRow))
      : h('p', { class: 'muted daily-empty', text: 'Nobody has played today yet. Be the first!' }),
  );
}

export function createDailyBox() {
  const el = h('div', { class: 'daily-slot' });
  let cur = { kind: null, date: null, intro: null, compact: false };
  let top = null;
  let loading = false;
  let sig = '';
  let ask = 0;

  function paint() {
    if (!cur.kind) {
      if (sig !== '') el.replaceChildren();
      sig = '';
      return;
    }
    const m = { ...cur, play: cur.date ? dailyPlay(cur.kind, cur.date) : null, top, loading };
    const next = JSON.stringify(m);
    if (next === sig) return;
    sig = next;
    el.replaceChildren(dailyView(m));
  }

  function fetchTop(force) {
    if (!cur.kind) return;
    const kind = cur.kind;
    const n = (ask += 1);
    loading = top === null;
    let wait;
    try {
      wait = Promise.resolve(topper(kind, { force: Boolean(force) }));
    } catch {
      wait = Promise.resolve(null);
    }
    wait
      .catch(() => null)
      .then((rows) => {
        if (n !== ask || cur.kind !== kind) return;
        loading = false;
        if (Array.isArray(rows)) top = rows;
        paint();
      });
    paint();
  }

  let lastState = null;
  const off = onDaily(() => {
    const p = cur.kind && cur.date ? dailyPlay(cur.kind, cur.date) : null;
    const state = p ? p.state : null;
    if (state === 'done' && lastState !== 'done') fetchTop(true);
    lastState = state;
    paint();
  });

  return {
    el,
    show(kind, opts = {}) {
      const k = DAILY_KINDS.includes(kind) ? kind : null;
      const date = typeof opts.date === 'string' ? opts.date : null;
      const changed = k !== cur.kind;
      cur = { kind: k, date, intro: opts.intro || null, compact: Boolean(opts.compact) };
      if (changed) {
        top = k ? cachedTop(k) : null;
        const p = k && date ? dailyPlay(k, date) : null;
        lastState = p ? p.state : null;
        if (k) fetchTop(false);
      }
      paint();
      return el;
    },
    refresh() {
      fetchTop(true);
    },
    destroy() {
      off();
      ask += 1;
    },
  };
}
