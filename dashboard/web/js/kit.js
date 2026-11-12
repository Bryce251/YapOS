import { h, replace } from './dom.js';
import { icon } from './icons.js';
import { button, countUp } from './ui.js';
import { formatCompact, formatNumber, toHexColor, toMillis, caseTypeLabel, caseTone } from './format.js';
import { ApiError, isPending } from './api.js';

const UNITS = { s: 1e3, sec: 1e3, secs: 1e3, second: 1e3, seconds: 1e3, m: 6e4, min: 6e4, mins: 6e4, minute: 6e4, minutes: 6e4, h: 36e5, hr: 36e5, hrs: 36e5, hour: 36e5, hours: 36e5, d: 864e5, day: 864e5, days: 864e5, w: 6048e5, wk: 6048e5, week: 6048e5, weeks: 6048e5, y: 31536e6, yr: 31536e6, yrs: 31536e6, year: 31536e6, years: 31536e6 };

export const MINUTE = 6e4;
export const DAY = 864e5;
export const TIMEOUT_RANGE = { min: MINUTE, max: 28 * DAY };
export const BAN_RANGE = { min: MINUTE, max: 365 * DAY };
export const DURATION_PRESETS = [
  { value: '5m', label: '5 min' },
  { value: '1h', label: '1 hour' },
  { value: '1d', label: '1 day' },
  { value: '1w', label: '1 week' },
];

export const MOD_ACTIONS = {
  warn: { label: 'Warn', tone: 'secondary', icon: 'alert', done: 'Warning added' },
  timeout: { label: 'Timeout', tone: 'secondary', icon: 'clock', duration: 'required', range: TIMEOUT_RANGE, done: 'Member timed out' },
  untimeout: { label: 'Remove timeout', tone: 'secondary', icon: 'clock', done: 'Timeout removed' },
  kick: { label: 'Kick', tone: 'danger', icon: 'logout', confirm: true, done: 'Member kicked' },
  ban: { label: 'Ban', tone: 'danger', icon: 'lock', duration: 'optional', range: BAN_RANGE, confirm: true, done: 'Member banned' },
  unban: { label: 'Unban', tone: 'secondary', icon: 'check', done: 'Member unbanned' },
  unwarn: { label: 'Unwarn', tone: 'secondary', icon: 'x', done: 'Warning removed' },
  role_add: { label: 'Add role', tone: 'secondary', icon: 'plus', done: 'Role added' },
  role_remove: { label: 'Remove role', tone: 'secondary', icon: 'x', done: 'Role removed' },
  nick: { label: 'Save nickname', tone: 'secondary', icon: 'tag', done: 'Nickname updated' },
  note: { label: 'Add note', tone: 'secondary', icon: 'message', done: 'Note added' },
};

export function parseDurationText(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * UNITS.m);
  const re = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  let total = 0;
  let used = '';
  let m;
  while ((m = re.exec(s))) {
    const unit = UNITS[m[2]];
    if (!unit) return null;
    total += Number(m[1]) * unit;
    used += m[0];
  }
  if (!total || used.replace(/\s/g, '') !== s.replace(/\s/g, '')) return null;
  return Math.round(total);
}

export function durationProblem(text, range, { required = false } = {}) {
  const s = String(text ?? '').trim();
  if (!s) return required ? 'Pick how long it should last.' : '';
  if (s.length > 20) return 'That length is too long to read. Try something like 10m, 2h or 3d.';
  const ms = parseDurationText(s);
  if (ms === null) return 'Use a length like 10m, 2h30m, 3d or 1w.';
  if (range && ms < range.min) return 'That is too short. The shortest is 1 minute.';
  if (range && ms > range.max) return range.max <= 28 * DAY ? 'Timeouts can last up to 28 days.' : 'Temporary bans can last up to 1 year.';
  return '';
}

export function buildActionBody(action, fields = {}) {
  const meta = MOD_ACTIONS[action];
  if (!meta) return { error: "That action isn't available." };
  const body = { action };
  const reason = String(fields.reason ?? '').trim();
  if (reason.length > 500) return { error: 'Keep the reason under 500 characters.' };
  if (reason && !['role_add', 'role_remove', 'nick', 'note'].includes(action)) body.reason = reason;
  if (meta.duration) {
    const duration = String(fields.duration ?? '').trim();
    const problem = durationProblem(duration, meta.range, { required: meta.duration === 'required' });
    if (problem) return { error: problem };
    if (duration) body.duration = duration;
  }
  if (action === 'role_add' || action === 'role_remove') {
    if (!fields.role_id) return { error: 'Pick a role first.' };
    body.role_id = String(fields.role_id);
  }
  if (action === 'nick') {
    const nickname = String(fields.nickname ?? '').trim();
    if (nickname.length > 32) return { error: 'Nicknames can be up to 32 characters.' };
    body.nickname = nickname;
  }
  if (action === 'note') {
    const note = String(fields.note ?? '').trim();
    if (!note) return { error: 'Write the note first.' };
    if (note.length > 500) return { error: 'Keep notes under 500 characters.' };
    body.note = note;
  }
  if (action === 'unwarn') {
    const n = Number(fields.case);
    if (!Number.isInteger(n) || n < 1 || n > 1e9) return { error: "That warning doesn't have a case number." };
    body.case = n;
  }
  return { body };
}

export function confirmCopy(action, name, duration = '') {
  const who = name || 'this member';
  if (action === 'kick') return { title: `Kick ${who}?`, body: `${who} will be removed from the server. They can join again with an invite.`, confirmLabel: 'Kick' };
  if (action === 'ban') {
    return duration
      ? { title: `Ban ${who} for ${duration}?`, body: `${who} will be removed and can't come back until the ban ends.`, confirmLabel: 'Ban' }
      : { title: `Ban ${who}?`, body: `${who} will be removed and can't come back until someone unbans them.`, confirmLabel: 'Ban' };
  }
  if (action === 'close') return { title: 'Close this ticket?', body: 'The channel is closed and a transcript is saved. This uses the same close as the button in the ticket.', confirmLabel: 'Close ticket' };
  return { title: 'Are you sure?', body: '', confirmLabel: 'Confirm' };
}

export function serverApi(sid, ...parts) {
  const tail = parts.filter((p) => p !== undefined && p !== null && p !== '').map((p) => encodeURIComponent(String(p))).join('/');
  return `/api/servers/${encodeURIComponent(sid)}${tail ? `/${tail}` : ''}`;
}

export function withQuery(path, params = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    p.set(k, String(v));
  }
  const qs = p.toString();
  return qs ? `${path}?${qs}` : path;
}

function denied(result) {
  const message = typeof result?.error === 'string' && result.error ? result.error : "You need to be an admin of this server to manage it here.";
  return new ApiError(message, { status: 403, code: 'forbidden', data: result });
}

export async function readJob(ctx, path, { signal, onPending } = {}) {
  let data = await ctx.api.get(path, { signal, onPending });
  if (isPending(data)) {
    onPending?.(data.job);
    data = await ctx.api.job(data.job, { signal });
  }
  if (data && data.grant === false) throw denied(data);
  if (data && typeof data.error === 'string' && data.error) throw new ApiError(data.error, { code: 'job_error', data });
  return data;
}

export async function sendAction(ctx, path, body, { signal, onPending } = {}) {
  const { data } = await ctx.api.run('POST', path, body, { signal, onPending });
  if (data && data.grant === false) throw denied(data);
  return data && typeof data === 'object' ? data : {};
}

export function readPage(data, key) {
  const d = data && typeof data === 'object' ? data : {};
  const list = Array.isArray(d[key]) ? d[key] : [];
  const page = Math.max(1, Number.isFinite(Number(d.page)) ? Number(d.page) : 1);
  const pages = Math.max(page, Number.isFinite(Number(d.pages)) ? Number(d.pages) : 1);
  const total = Number.isFinite(Number(d.total)) ? Number(d.total) : list.length;
  return { list, page, pages, total, pageSize: Number(d.pageSize) || 50, capped: d.capped === true };
}

function person(p) {
  if (p && typeof p === 'object') return { id: String(p.id ?? ''), name: String(p.name ?? p.username ?? p.id ?? 'Unknown') };
  if (typeof p === 'string' && p) return { id: p, name: p };
  return { id: '', name: 'Unknown' };
}

export function normalizeMember(m) {
  const raw = m && typeof m === 'object' ? m : {};
  const id = String(raw.id ?? '');
  return {
    id,
    name: String(raw.name || raw.nickname || raw.username || id || 'Member'),
    username: typeof raw.username === 'string' ? raw.username : '',
    avatar_url: typeof raw.avatar_url === 'string' ? raw.avatar_url : '',
    joined_at: toMillis(raw.joined_at),
    roles: Array.isArray(raw.roles) ? raw.roles.map((r) => (r && typeof r === 'object' ? String(r.id ?? '') : String(r))).filter(Boolean) : [],
    bot: raw.bot === true,
    warnings: Number(raw.warnings) > 0 ? Number(raw.warnings) : 0,
    cases: Number(raw.cases) > 0 ? Number(raw.cases) : 0,
  };
}

export function rolesIndex(roles) {
  const map = new Map();
  for (const r of Array.isArray(roles) ? roles : []) {
    if (!r || typeof r !== 'object' || !r.id) continue;
    map.set(String(r.id), { id: String(r.id), name: String(r.name ?? 'Role'), color: toHexColor(r.color), position: Number(r.position) || 0, manageable: r.manageable === true });
  }
  return map;
}

export function sortRoles(list) {
  return list.slice().sort((a, b) => (b.position || 0) - (a.position || 0) || String(a.name).localeCompare(String(b.name)));
}

export function roleList(roles, index = new Map()) {
  const out = [];
  for (const r of Array.isArray(roles) ? roles : []) {
    if (r && typeof r === 'object') {
      const known = index.get(String(r.id));
      out.push({ id: String(r.id ?? ''), name: String(r.name ?? known?.name ?? 'Role'), color: toHexColor(r.color ?? known?.color), position: Number(r.position ?? known?.position) || 0, manageable: r.manageable === true || (r.manageable === undefined && known?.manageable === true) });
    } else if (r !== null && r !== undefined) {
      const known = index.get(String(r));
      out.push(known ? { ...known } : { id: String(r), name: 'Unknown role', color: '', position: 0, manageable: false });
    }
  }
  return out.filter((r) => r.id && r.name !== '@everyone');
}

export function roleChip(role, { onRemove, removeLabel } = {}) {
  const color = toHexColor(role?.color);
  const chip = h('span', { class: ['role-chip', color ? 'has-color' : ''], style: color ? { '--role-color': color } : null },
    h('span', { class: 'role-dot', attrs: { 'aria-hidden': 'true' } }),
    h('span', { class: 'role-name', text: role?.name || 'Role' }));
  if (onRemove) {
    chip.appendChild(h('button', { type: 'button', class: 'role-remove', attrs: { 'aria-label': removeLabel || `Remove ${role?.name || 'role'}` }, on: { click: onRemove } }, icon('x', { size: 12 })));
  }
  return chip;
}

export function roleChips(roles, { max = 3 } = {}) {
  const list = Array.isArray(roles) ? roles : [];
  const shown = list.slice(0, max).map((r) => roleChip(r));
  const extra = list.length - shown.length;
  return h('span', { class: 'role-chips' }, ...shown, extra > 0 ? h('span', { class: 'role-more', text: `+${extra}` }) : null);
}

export function stars(rating, { size = 14 } = {}) {
  const n = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
  const el = h('span', { class: 'stars', attrs: { role: 'img', 'aria-label': n ? `Rated ${n} out of 5` : 'Not rated' } });
  for (let i = 1; i <= 5; i++) el.appendChild(h('span', { class: ['star', i <= n ? 'is-on' : ''] }, icon('star', { size })));
  return el;
}

export function heroStat({ label, value, icon: iconName = '', hint = '', tone = '' }) {
  const blank = value === null || value === undefined || value === '';
  const text = blank ? '–' : formatCompact(value);
  const num = h('div', { class: 'stat-value', text });
  if (!blank) countUp(num, text);
  return h('div', { class: ['stat-card', 'hero-stat', tone ? `stat-${tone}` : ''] },
    h('div', { class: 'stat-top' },
      h('span', { class: 'stat-label', text: label }),
      iconName ? h('span', { class: 'stat-icon' }, icon(iconName, { size: 16 })) : null),
    num,
    h('div', { class: 'stat-hint', text: hint || ' ' }));
}

export function tabBar({ items, value, label = 'Sections', onChange, idPrefix = 'tab' }) {
  let current = value;
  const buttons = new Map();
  const bar = h('div', { class: 'ftabs', attrs: { role: 'tablist', 'aria-label': label } });
  const counts = new Map();
  const set = (id, { silent = false } = {}) => {
    current = id;
    for (const [key, b] of buttons) {
      const on = key === id;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    if (!silent) onChange?.(id);
  };
  items.forEach((item) => {
    const count = h('span', { class: 'ftab-count', hidden: item.count === undefined || item.count === null, text: item.count === undefined || item.count === null ? '' : formatNumber(item.count) });
    counts.set(item.id, count);
    const b = h('button', { type: 'button', class: 'ftab', id: `${idPrefix}-${item.id}`, attrs: { role: 'tab' } },
      item.icon ? icon(item.icon, { size: 14 }) : null,
      h('span', { text: item.label }),
      count);
    b.addEventListener('click', () => set(item.id));
    b.addEventListener('keydown', (e) => {
      const ids = items.map((i) => i.id);
      const i = ids.indexOf(item.id);
      let next = null;
      if (e.key === 'ArrowRight') next = ids[(i + 1) % ids.length];
      else if (e.key === 'ArrowLeft') next = ids[(i - 1 + ids.length) % ids.length];
      else if (e.key === 'Home') next = ids[0];
      else if (e.key === 'End') next = ids[ids.length - 1];
      if (next === null) return;
      e.preventDefault();
      set(next);
      buttons.get(next)?.focus();
    });
    buttons.set(item.id, b);
    bar.appendChild(b);
  });
  set(current, { silent: true });
  return {
    el: bar,
    get value() {
      return current;
    },
    set,
    setCount(id, n) {
      const c = counts.get(id);
      if (!c) return;
      c.hidden = n === undefined || n === null;
      c.textContent = c.hidden ? '' : formatNumber(n);
    },
  };
}

export function durationPicker({ presets = DURATION_PRESETS, value = '', allowNone = false, noneLabel = 'Permanent', label = 'Length', onChange } = {}) {
  let current = value;
  const chips = [];
  const custom = h('input', { type: 'text', class: 'input duration-custom', placeholder: 'Custom, like 2h30m', maxLength: 20, autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': `Custom ${label.toLowerCase()}` } });
  const sync = () => {
    for (const c of chips) {
      const on = c.dataset.value === current;
      c.classList.toggle('is-active', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const isPreset = chips.some((c) => c.dataset.value === current);
    if (isPreset && custom.value) custom.value = '';
  };
  const choose = (v) => {
    current = v;
    sync();
    onChange?.(current);
  };
  const all = allowNone ? [{ value: '', label: noneLabel }, ...presets] : presets;
  for (const p of all) {
    const chip = h('button', { type: 'button', class: 'duration-chip', dataset: { value: p.value }, attrs: { 'aria-pressed': 'false' }, text: p.label });
    chip.addEventListener('click', () => choose(p.value));
    chips.push(chip);
  }
  custom.addEventListener('input', () => {
    current = custom.value.trim();
    for (const c of chips) {
      const on = custom.value.trim() ? false : c.dataset.value === current;
      c.classList.toggle('is-active', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    onChange?.(current);
  });
  const el = h('div', { class: 'duration-picker', attrs: { role: 'group', 'aria-label': label } }, h('div', { class: 'duration-chips' }, ...chips), custom);
  if (value && !all.some((p) => p.value === value)) custom.value = value;
  sync();
  return {
    el,
    get value() {
      return current;
    },
    set(v) {
      current = v;
      custom.value = all.some((p) => p.value === v) ? '' : v;
      sync();
    },
  };
}

export function barHeights(values, { min = 4 } = {}) {
  const nums = values.map((v) => Math.max(0, Number(v) || 0));
  const max = Math.max(0, ...nums);
  return nums.map((n) => (max === 0 ? 0 : n === 0 ? 0 : Math.max(min, Math.round((n / max) * 100))));
}

export function fillDays(list, days = 14, now = Date.now()) {
  const given = (Array.isArray(list) ? list : []).filter((d) => d && typeof d.day === 'string');
  if (given.length) return given.slice(-days).map((d) => ({ day: d.day, count: Math.max(0, Number(d.count) || 0) }));
  const out = [];
  const end = new Date(now);
  for (let i = days - 1; i >= 0; i--) {
    const t = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - i));
    out.push({ day: t.toISOString().slice(0, 10), count: 0 });
  }
  return out;
}

function dayLabel(day, opts) {
  const t = Date.parse(`${day}T12:00:00Z`);
  if (!Number.isFinite(t)) return day;
  return new Date(t).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
}

export function barChart(days, { label = 'Cases per day' } = {}) {
  const list = Array.isArray(days) ? days : [];
  const heights = barHeights(list.map((d) => d.count));
  const total = list.reduce((s, d) => s + (Number(d.count) || 0), 0);
  const chart = h('div', { class: 'bar-chart', attrs: { role: 'img', 'aria-label': `${label}: ${formatNumber(total)} in the last ${list.length} days` } },
    ...list.map((d, i) => h('div', { class: ['bar-col', d.count ? '' : 'is-zero'], title: `${dayLabel(d.day, { month: 'short', day: 'numeric' })}: ${formatNumber(d.count)}` },
      h('span', { class: 'bar-value', text: d.count ? formatNumber(d.count) : '' }),
      h('span', { class: 'bar-track' }, h('span', { class: 'bar', style: { '--h': `${heights[i]}%`, '--i': String(i) } })),
      h('span', { class: 'bar-label', text: i === 0 || i === list.length - 1 || i % 3 === 0 ? dayLabel(d.day, { month: 'short', day: 'numeric' }) : '' }))));
  return chart;
}

export function typeBreakdown(byType) {
  const entries = Object.entries(byType && typeof byType === 'object' ? byType : {})
    .map(([type, count]) => ({ type, label: caseTypeLabel(type), tone: caseTone(type), count: Number(count) || 0 }))
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const total = entries.reduce((s, e) => s + e.count, 0);
  return entries.map((e) => ({ ...e, share: total ? Math.round((e.count / total) * 100) : 0 }));
}

export function pager({ page, pages, onChange, label = 'Pages' }) {
  if (!pages || pages <= 1) return null;
  const prev = button({ label: 'Previous', icon: 'chevron-left', size: 'sm', disabled: page <= 1, onClick: () => onChange(page - 1) });
  const next = button({ label: 'Next', iconRight: 'chevron-right', size: 'sm', disabled: page >= pages, onClick: () => onChange(page + 1) });
  return h('nav', { class: 'pager', attrs: { 'aria-label': label } }, prev, h('span', { class: 'pager-text', text: `Page ${formatNumber(page)} of ${formatNumber(pages)}` }), next);
}

export function debounce(fn, ms = 300) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export const SEARCH_DELAY = 550;
export const SEARCH_MIN = 2;

export function latestSearch(run, { delay = SEARCH_DELAY, min = SEARCH_MIN } = {}) {
  let busy = false;
  let queued = null;
  let stopped = false;
  const ready = (q) => q.length === 0 || q.length >= min;
  async function go(q) {
    busy = true;
    await Promise.resolve().then(() => run(q)).catch(() => null);
    busy = false;
    const next = queued;
    queued = null;
    if (next !== null && !stopped) go(next);
  }
  function now(q) {
    if (stopped) return;
    timer.cancel();
    if (busy) {
      queued = q;
      return;
    }
    go(q);
  }
  const timer = debounce((q) => now(q), delay);
  return {
    push(q) {
      if (stopped) return;
      if (!ready(q)) {
        timer.cancel();
        queued = null;
        return;
      }
      timer(q);
    },
    now,
    clear() {
      timer.cancel();
      queued = null;
    },
    cancel() {
      stopped = true;
      timer.cancel();
      queued = null;
    },
    get busy() { return busy; },
  };
}

export function statusLine() {
  const el = h('p', { class: 'action-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  let timer = null;
  return {
    el,
    waiting() {
      clearTimeout(timer);
      el.classList.remove('is-slow');
      replace(el, h('span', { class: 'spinner spinner-sm', attrs: { 'aria-hidden': 'true' } }), h('span', { text: 'Waiting for YapOS…' }));
      timer = setTimeout(() => {
        if (!el.isConnected) return;
        el.classList.add('is-slow');
        replace(el, icon('signal-off', { size: 14 }), h('span', { text: "YapOS hasn't answered yet. It will finish on its own if it comes back." }));
      }, 20000);
    },
    clear() {
      clearTimeout(timer);
      el.classList.remove('is-slow');
      replace(el);
    },
  };
}

export function personName(p) {
  return person(p).name;
}

export function normalizeTicket(t) {
  const raw = t && typeof t === 'object' ? t : {};
  const status = ['open', 'closing', 'closed'].includes(raw.status) ? raw.status : 'open';
  const type = raw.type && typeof raw.type === 'object' ? { id: String(raw.type.id ?? ''), name: String(raw.type.name ?? ''), emoji: typeof raw.type.emoji === 'string' ? raw.type.emoji : '' } : null;
  return {
    number: Number(raw.number) || 0,
    status,
    name: String(raw.name || `ticket-${raw.number ?? ''}`),
    topic: typeof raw.topic === 'string' && raw.topic ? raw.topic : '',
    type,
    opener: person(raw.opener),
    claimedBy: raw.claimedBy ? person(raw.claimedBy) : null,
    members: Number(raw.members) || 0,
    createdAt: toMillis(raw.createdAt),
    closedAt: toMillis(raw.closedAt),
    lastActivityAt: toMillis(raw.lastActivityAt),
    rating: Number(raw.rating) >= 1 ? Math.min(5, Math.round(Number(raw.rating))) : null,
    channelId: raw.channelId ? String(raw.channelId) : '',
    answers: Array.isArray(raw.answers) ? raw.answers.filter((a) => a && typeof a === 'object').map((a) => ({ q: String(a.q ?? ''), a: String(a.a ?? '') })) : [],
    reason: typeof raw.reason === 'string' && raw.reason ? raw.reason : '',
    closedBy: raw.closedBy ? person(raw.closedBy) : null,
    people: Array.isArray(raw.people) ? raw.people.map(person) : [],
  };
}

export function ticketStatus(status) {
  if (status === 'closed') return { label: 'Closed', tone: 'neutral' };
  if (status === 'closing') return { label: 'Closing', tone: 'warning' };
  return { label: 'Open', tone: 'success' };
}

export function transcriptFileName(ticket) {
  const n = Number(ticket?.number) || 0;
  const name = String(ticket?.name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `ticket-${n}${name && name !== `ticket-${n}` ? `-${name}` : ''}.txt`;
}

export function downloadText(filename, text) {
  const blob = new Blob([String(text ?? '')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, class: 'sr-only', attrs: { download: filename } });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return url;
}

export function sectionTitle(text, extra = null) {
  return h('h3', { class: 'drawer-section-title' }, text, extra);
}
