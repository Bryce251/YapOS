import { h, replace, nextId } from '../dom.js';
import { avatar, badge, button, confirmDialog, drawer, errorState, loadingRegion, setBusy, skeleton, toast } from '../ui.js';
import { ApiError } from '../api.js';
import { formatDate, relativeTime } from '../format.js';
import { badgeInfo } from '../community-data.js';
import { state } from '../state.js';

export const PERSON_PATH = '/api/party/reports/person/';
export const PERSON_BANS_PATH = '/api/party/bans';
export const REASON_MAX = 200;
export const REASONS = Object.freeze(['Drew something not okay', 'Wrote something not okay', 'Picking on other players', 'Spamming or trolling']);
export const STATUS_FILTERS = Object.freeze([['all', 'All'], ['open', 'Open'], ['dismissed', 'Dismissed']]);
export const KIND_FILTERS = Object.freeze([['all', 'Everything'], ['drawing', 'Drawings'], ['text', 'Text']]);
export const NOTE_MAX = 500;
export const NOTE_TEMPLATES = Object.freeze([['Warned', 'warned'], ['Ban appeal', 'appeal'], ['Watch', 'watch']]);
export const BAN_LENGTHS = Object.freeze([['hour', '1 hour'], ['day', '1 day'], ['week', '1 week'], ['forever', 'Forever']]);
export const WARNING_MAX = 200;
export const WARNING_TEMPLATES = Object.freeze(['Keep drawings clean', 'Be kind to others', 'No spam', 'No cheating']);

const str = (v) => (typeof v === 'string' && v ? v : '');
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : null);

export function personUrl(id) {
  return `${PERSON_PATH}${encodeURIComponent(id)}`;
}

export function notesUrl(id, noteId = '') {
  return `${personUrl(id)}/notes${noteId ? `/${encodeURIComponent(noteId)}` : ''}`;
}

export function warningsUrl(id) {
  return `${personUrl(id)}/warnings`;
}

export function durationName(d) {
  const hit = BAN_LENGTHS.find(([v]) => v === d);
  return hit && d !== 'forever' ? hit[1] : '';
}

export function timeLeft(until, now = Date.now()) {
  const ms = Number(until) - Number(now);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const mins = Math.ceil(ms / 60000);
  if (mins < 2) return 'less than a minute';
  if (mins < 60) return `${mins} minutes`;
  const hours = Math.round(mins / 60);
  if (hours < 2) return '1 hour';
  if (hours < 36) return `${hours} hours`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

export function banStatusText(banned, now = Date.now()) {
  if (!banned) return '';
  const length = durationName(banned.duration);
  const head = `Banned ${relativeTime(banned.at)}${length ? ` for ${length}` : ''}${banned.reason ? `: ${banned.reason}` : ''}.`;
  if (!banned.until) return `${head} It lasts until someone unbans them.`;
  const left = timeLeft(banned.until, now);
  return left ? `${head} It ends in ${left} (${formatDate(banned.until)}).` : `${head} It has just ended.`;
}

export function readWarnings(list) {
  return (Array.isArray(list) ? list : []).filter((w) => w && typeof w === 'object' && typeof w.id === 'string' && typeof w.text === 'string').map((w) => {
    const a = w.author && typeof w.author === 'object' ? w.author : {};
    return {
      id: w.id,
      text: w.text,
      created: num(w.created) || 0,
      seen: w.seen === true,
      seenAt: num(w.seen_at),
      author: { id: str(a.id), name: str(a.name) || 'Staff', avatar: str(a.avatar) },
    };
  });
}

export function readFlag(f) {
  if (!f || typeof f !== 'object') return null;
  const games = Number(f.games);
  if (!Number.isInteger(games) || games <= 0) return null;
  return { games, reporters: Number(f.reporters) || 0, reports: Number(f.reports) || 0 };
}

export function readNotes(list) {
  return (Array.isArray(list) ? list : []).filter((n) => n && typeof n === 'object' && typeof n.id === 'string' && typeof n.text === 'string').map((n) => {
    const a = n.author && typeof n.author === 'object' ? n.author : {};
    return {
      id: n.id,
      text: n.text,
      created: num(n.created) || 0,
      author: { id: str(a.id), name: str(a.name) || 'Staff', avatar: str(a.avatar) },
      canDelete: n.canDelete === true,
    };
  });
}

export function flagText(flag) {
  return `Reported in ${flag.games} ${flag.games === 1 ? 'game' : 'games'} this week`;
}

export function flagBadge(flag) {
  if (!flag) return null;
  const reporters = `${flag.reporters} different ${flag.reporters === 1 ? 'person' : 'people'}`;
  return h('span', { class: 'flag-badge', attrs: { title: `${flag.reports} open ${flag.reports === 1 ? 'report' : 'reports'} from ${reporters} in the last 7 days` } },
    h('span', { class: 'flag-badge-icon', text: '\u{1F6A9}', attrs: { 'aria-hidden': 'true' } }),
    h('strong', { class: 'flag-badge-title', text: 'Repeat offender' }),
    h('span', { class: 'flag-badge-text', text: flagText(flag) }));
}

export function noteCountText(n) {
  return `${n} mod ${n === 1 ? 'note' : 'notes'}`;
}

export function noteChip(n) {
  if (!Number.isInteger(n) || n <= 0) return null;
  return h('span', { class: 'chip note-chip', attrs: { title: 'Private notes only party staff can see' } },
    h('span', { text: '\u{1F4DD}', attrs: { 'aria-hidden': 'true' } }),
    h('span', { text: noteCountText(n) }));
}

export function noteTemplate(kind, t = Date.now()) {
  const day = new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (kind === 'warned') return `Warned on ${day}: `;
  if (kind === 'appeal') return `Ban appeal on ${day}: `;
  if (kind === 'watch') return 'Watch: ';
  return '';
}

function readCard(c) {
  if (!c || typeof c !== 'object') return null;
  if (c.hidden) return { hidden: true };
  const party = c.party && typeof c.party === 'object' ? c.party : {};
  return {
    hidden: false,
    level: Number.isInteger(c.level) ? c.level : null,
    username: str(c.username),
    badges: (Array.isArray(c.badges) ? c.badges : []).map((b) => (typeof b === 'string' ? badgeInfo(b) : b && typeof b === 'object' ? { id: str(b.id), label: str(b.label) || str(b.id), emoji: str(b.emoji) } : null)).filter((b) => b && b.label).slice(0, 12),
    badgeCount: Number(c.badgeCount) || 0,
    games: Number(party.games) || 0,
    wins: Number(party.wins) || 0,
    bestStreak: Number(party.bestStreak) || 0,
    rank: c.rank && Number.isInteger(c.rank.rank) && c.rank.points > 0 ? c.rank.rank : null,
    page: c.page === true,
  };
}

export function readPerson(data, readReport = (r) => r) {
  const p = data?.person && typeof data.person === 'object' ? data.person : {};
  const c = data?.counts && typeof data.counts === 'object' ? data.counts : {};
  const ban = p.banned && typeof p.banned === 'object' ? p.banned : null;
  return {
    person: {
      id: str(p.id),
      name: str(p.name) || 'Player',
      username: str(p.username),
      avatar: str(p.avatar),
      role: p.role === 'owner' || p.role === 'admin' ? p.role : '',
      banned: ban ? { reason: str(ban.reason), by: str(ban.by), at: num(ban.at) || 0, until: num(ban.until), duration: BAN_LENGTHS.some(([v]) => v === ban.duration) ? ban.duration : 'forever' } : null,
      card: readCard(p.card),
      flag: ban ? null : readFlag(p.flag),
    },
    notes: Array.isArray(data?.notes) ? readNotes(data.notes) : null,
    warnings: readWarnings(data?.warnings),
    counts: {
      total: Number(c.total) || 0,
      open: Number(c.open) || 0,
      first: num(c.first),
      last: num(c.last),
      made: Number(c.made) || 0,
      warnings: Number(c.warnings) || 0,
      reasons: readReasonCounts(c.reasons),
      games: (Array.isArray(c.games) ? c.games : []).filter((g) => g && typeof g.game === 'string').map((g) => ({ game: g.game, n: Number(g.n) || 0, drawings: Number(g.drawings) || 0 })),
    },
    bans: (Array.isArray(data?.bans) ? data.bans : []).filter((b) => b && typeof b === 'object').map((b) => ({ action: b.action === 'unban' ? 'unban' : 'ban', reason: str(b.reason), by: str(b.by), at: num(b.at) || 0, duration: durationName(b.duration) ? b.duration : '', auto: b.auto === true })),
    reports: (Array.isArray(data?.reports) ? data.reports : []).map(readReport).filter(Boolean),
    more: data?.more === true,
    role: data?.role === 'owner' ? 'owner' : 'admin',
  };
}

export function canBanPerson(p, role) {
  if (!p || !p.id || p.banned || p.role === 'owner') return false;
  return p.role !== 'admin' || role === 'owner';
}

export function filterHistory(reports, f = {}) {
  const status = f.status || 'all';
  const kind = f.kind || 'all';
  const game = f.game || '';
  return (Array.isArray(reports) ? reports : []).filter((r) => (status === 'all' || r.status === status) && (kind === 'all' || r.kind === kind) && (!game || r.game === game));
}

export const REPORT_REASON_NAMES = Object.freeze({ rude: 'rude', spam: 'spam', cheating: 'cheating', other: 'other' });

export function readReasonCounts(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const k of Object.keys(REPORT_REASON_NAMES)) out[k] = Number.isInteger(src[k]) && src[k] > 0 ? src[k] : 0;
  return out;
}

export function reasonCountText(counts) {
  const r = counts && counts.reasons ? counts.reasons : {};
  const order = Object.keys(REPORT_REASON_NAMES).filter((k) => r[k] > 0).sort((a, b) => r[b] - r[a]);
  const parts = order.map((k) => `${r[k]} ${REPORT_REASON_NAMES[k]}`);
  const given = order.reduce((n, k) => n + r[k], 0);
  const none = Math.max(0, (Number(counts && counts.total) || 0) - given);
  if (none && parts.length) parts.push(`${none} with no reason`);
  return parts.join(', ');
}

export function reportCountText(counts) {
  if (!counts.total) return 'No reports against them yet';
  const base = `${counts.total} ${counts.total === 1 ? 'report' : 'reports'}`;
  return counts.open ? `${base}, ${counts.open} open` : `${base}, none open`;
}

export function profileUrl(model) {
  const u = model?.person?.card && !model.person.card.hidden && model.person.card.username ? model.person.card.username : model?.person?.username;
  return u ? `/u/${encodeURIComponent(u)}` : '';
}

export function personHead(model, { size = 'xl' } = {}) {
  const p = model.person;
  const tags = [];
  if (p.banned) tags.push(badge('Banned from Party', 'danger', 'ban'));
  else if (p.flag) tags.push(flagBadge(p.flag));
  if (model.notes && model.notes.length) tags.push(noteChip(model.notes.length));
  if (p.role === 'owner') tags.push(badge('Owner', 'neutral', 'crown'));
  else if (p.role === 'admin') tags.push(badge('Party admin', 'neutral', 'crown'));
  return h('div', { class: 'person-head' },
    avatar({ name: p.name || p.id, url: p.avatar, id: p.id, size }),
    h('div', { class: 'person-names' },
      h('p', { class: 'person-name', text: p.name }),
      p.username ? h('p', { class: 'person-handle', text: `@${p.username}` }) : null,
      h('p', { class: 'person-id' }, h('span', { class: 'muted', text: "Yapin' id " }), h('code', { text: p.id })),
      tags.length ? h('div', { class: 'person-tags' }, ...tags) : null));
}

export function personStats(model) {
  const c = model.counts;
  const card = model.person.card;
  const rows = [
    ['Reports', reportCountText(c)],
    ...(reasonCountText(c) ? [['Reasons', reasonCountText(c)]] : []),
    ['First reported', c.first ? `${formatDate(c.first)} (${relativeTime(c.first)})` : 'Never'],
    ['Last reported', c.last ? `${formatDate(c.last)} (${relativeTime(c.last)})` : 'Never'],
    ['Reports they sent', String(c.made)],
    ['Warnings', c.warnings ? `${c.warnings} sent` : 'None yet'],
  ];
  if (model.person.banned) rows.push(['Ban', model.person.banned.until ? `Ends in ${timeLeft(model.person.banned.until) || 'a moment'}` : 'Until someone unbans them']);
  if (card && !card.hidden) {
    if (card.level !== null) rows.push(['Level', String(card.level)]);
    rows.push(['Party games', `${card.games} played, ${card.wins} won`]);
    if (card.rank) rows.push(['Party rank', `#${card.rank}`]);
  } else if (card && card.hidden) {
    rows.push(['Public profile', 'They keep their profile private']);
  }
  return h('dl', { class: 'person-stats' }, ...rows.map(([k, v]) => h('div', { class: 'person-stat' }, h('dt', { class: 'report-label', text: k }), h('dd', { text: v }))));
}

export function personBadges(model) {
  const card = model.person.card;
  if (!card || card.hidden || !card.badges.length) return null;
  return h('ul', { class: 'person-badges', attrs: { 'aria-label': 'Badges' } }, ...card.badges.map((b) => h('li', { class: 'person-badge', attrs: { title: b.note ? `${b.label}: ${b.note}` : b.label } }, b.emoji ? h('span', { text: b.emoji, attrs: { 'aria-hidden': 'true' } }) : null, h('span', { text: b.label }))));
}

export function banHistory(model) {
  if (!model.bans.length) return h('p', { class: 'muted person-empty', text: model.person.banned ? 'Banned before ban history was kept.' : 'Never banned from Party.' });
  return h('ol', { class: 'person-bans' }, ...model.bans.map((b) => h('li', { class: ['person-ban', `is-${b.action}`] },
    badge(b.action === 'ban' ? (b.duration ? `Banned for ${durationName(b.duration)}` : 'Banned') : b.auto ? 'Ban ended' : 'Unbanned', b.action === 'ban' ? 'danger' : 'neutral', b.action === 'ban' ? 'ban' : 'check'),
    h('span', { class: 'person-ban-why', text: b.reason || (b.action === 'ban' ? 'No reason given' : '') }),
    h('time', { class: 'report-time', attrs: { datetime: new Date(b.at || 0).toISOString(), title: formatDate(b.at) }, text: relativeTime(b.at) }))));
}

export function gameCounts(model, gameName, pick = null, current = '') {
  if (!model.counts.games.length) return null;
  return h('div', { class: 'person-games', attrs: { role: 'group', 'aria-label': 'Reports by game' } },
    ...model.counts.games.map((g) => {
      const text = `${gameName(g.game, g.drawings ? 'drawing' : 'text')} · ${g.n}`;
      if (typeof pick !== 'function') return h('span', { class: 'chip', text });
      const b = button({ label: text, size: 'sm', variant: current === g.game ? 'segment-active' : 'segment', onClick: () => pick(current === g.game ? '' : g.game) });
      b.setAttribute('aria-pressed', current === g.game ? 'true' : 'false');
      return b;
    }));
}

function noteItem(n, onDelete) {
  return h('li', { class: 'timeline-item mod-note', dataset: { id: n.id } },
    h('div', { class: 'timeline-head mod-note-head' },
      avatar({ name: n.author.name, url: n.author.avatar, id: n.author.id, size: 'sm' }),
      h('span', { class: 'mod-note-author', text: n.author.name }),
      h('time', { class: 'report-time', attrs: { datetime: new Date(n.created || 0).toISOString(), title: formatDate(n.created) }, text: relativeTime(n.created) }),
      n.canDelete && typeof onDelete === 'function' ? h('span', { class: 'timeline-action' }, button({ label: '', icon: 'trash', size: 'sm', variant: 'ghost', ariaLabel: `Delete the note by ${n.author.name}`, onClick: (e) => onDelete(n, e.currentTarget) })) : null),
    h('p', { class: 'timeline-text mod-note-text', text: n.text }));
}

export function notesSection({ model, onAdd, onDelete }) {
  const title = h('h3', { class: 'person-section-title' }, h('span', { text: 'Mod notes ' }), h('span', { class: 'count-pill', text: String(model.notes ? model.notes.length : 0) }));
  if (!model.notes) {
    return h('section', { class: 'person-notes', attrs: { 'aria-label': 'Mod notes' } }, title, h('p', { class: 'muted person-empty', text: 'Notes about you are kept private from you.' }));
  }
  const id = nextId('mod-note');
  const box = h('textarea', { id, class: 'input textarea mod-note-box', rows: 3, maxLength: NOTE_MAX, placeholder: 'Only party staff can see this. Example: warned about spam drawings.' });
  const counter = h('span', { class: 'field-counter mod-note-count', attrs: { 'aria-live': 'polite' }, text: `0 / ${NOTE_MAX}` });
  const add = button({ label: 'Add note', icon: 'plus', variant: 'primary', size: 'sm', disabled: true, onClick: (e) => onAdd(box.value, e.currentTarget) });
  const sync = () => {
    const n = Array.from(box.value).length;
    counter.textContent = `${n} / ${NOTE_MAX}`;
    counter.classList.toggle('is-over', n > NOTE_MAX);
    add.disabled = !box.value.trim() || n > NOTE_MAX;
  };
  box.addEventListener('input', sync);
  const templates = h('div', { class: 'mod-note-templates', attrs: { role: 'group', 'aria-label': 'Note templates' } }, ...NOTE_TEMPLATES.map(([label, kind]) => button({ label, size: 'sm', variant: 'secondary', onClick: () => {
    box.value = noteTemplate(kind);
    sync();
    box.focus();
    if (typeof box.setSelectionRange === 'function') box.setSelectionRange(box.value.length, box.value.length);
  } })));
  return h('section', { class: 'person-notes', attrs: { 'aria-label': 'Mod notes' } },
    title,
    h('p', { class: 'report-note', text: 'Private to the owner and party admins. Never shown to them, on public profiles or in games.' }),
    templates,
    h('label', { class: 'sr-only', htmlFor: id, text: 'New mod note' }),
    box,
    h('div', { class: 'mod-note-bar' }, counter, add),
    model.notes.length
      ? h('ul', { class: 'timeline mod-notes' }, ...model.notes.map((n) => noteItem(n, onDelete)))
      : h('p', { class: 'muted person-empty', text: 'No notes yet.' }));
}

function warningItem(w) {
  return h('li', { class: ['timeline-item', 'mod-warning', w.seen ? 'is-seen' : 'is-unseen'], dataset: { id: w.id } },
    h('div', { class: 'timeline-head mod-note-head' },
      avatar({ name: w.author.name, url: w.author.avatar, id: w.author.id, size: 'sm' }),
      h('span', { class: 'mod-note-author', text: w.author.name }),
      h('time', { class: 'report-time', attrs: { datetime: new Date(w.created || 0).toISOString(), title: formatDate(w.created) }, text: relativeTime(w.created) }),
      h('span', { class: ['chip', 'warning-state', w.seen ? 'is-seen' : 'is-unseen'], attrs: { title: w.seen && w.seenAt ? `Seen ${formatDate(w.seenAt)}` : 'They have not opened it yet' }, text: w.seen ? 'Seen' : 'Not seen yet' })),
    h('p', { class: 'timeline-text mod-note-text', text: w.text }));
}

export function canWarnPerson(p, role, viewerId = '') {
  if (!p || !p.id || p.role === 'owner') return false;
  if (viewerId && p.id.toLowerCase() === String(viewerId).toLowerCase()) return false;
  return p.role !== 'admin' || role === 'owner';
}

export function warningsSection({ model, onSend, canSend = true }) {
  const list = Array.isArray(model.warnings) ? model.warnings : [];
  const title = h('h3', { class: 'person-section-title' }, h('span', { text: 'Warnings ' }), h('span', { class: 'count-pill', text: String(list.length) }));
  const items = list.length
    ? h('ul', { class: 'timeline mod-notes mod-warnings' }, ...list.map(warningItem))
    : h('p', { class: 'muted person-empty', text: 'No warnings yet.' });
  if (!canSend || typeof onSend !== 'function') {
    return h('section', { class: 'person-warnings', attrs: { 'aria-label': 'Warnings' } }, title, items);
  }
  const id = nextId('mod-warning');
  const box = h('textarea', { id, class: 'input textarea mod-note-box mod-warning-box', rows: 2, maxLength: WARNING_MAX, placeholder: 'They see this in the call the next time they open YapOS Party.' });
  const counter = h('span', { class: 'field-counter mod-note-count', attrs: { 'aria-live': 'polite' }, text: `0 / ${WARNING_MAX}` });
  const send = button({ label: 'Send warning', icon: 'alert', variant: 'primary', size: 'sm', disabled: true, onClick: (e) => onSend(box.value, e.currentTarget) });
  const sync = () => {
    const n = Array.from(box.value).length;
    counter.textContent = `${n} / ${WARNING_MAX}`;
    counter.classList.toggle('is-over', n > WARNING_MAX);
    send.disabled = !box.value.trim() || n > WARNING_MAX;
  };
  box.addEventListener('input', sync);
  const chips = h('div', { class: 'mod-note-templates', attrs: { role: 'group', 'aria-label': 'Warning templates' } }, ...WARNING_TEMPLATES.map((text) => button({ label: text, size: 'sm', variant: 'secondary', onClick: () => {
    box.value = text;
    sync();
    box.focus();
  } })));
  return h('section', { class: 'person-warnings', attrs: { 'aria-label': 'Warnings' } },
    title,
    h('p', { class: 'report-note', text: 'Warnings pop up for them in the call: "A mod warned you", with your words. Your name is not shown to them.' }),
    chips,
    h('label', { class: 'sr-only', htmlFor: id, text: 'New warning' }),
    box,
    h('div', { class: 'mod-note-bar' }, counter, send),
    items);
}

function lengthPicker(current, pick) {
  const bar = h('div', { class: 'segmented ban-length', attrs: { role: 'group', 'aria-label': 'How long' } });
  const draw = (value) => {
    replace(bar, ...BAN_LENGTHS.map(([v, label]) => {
      const b = button({ label, size: 'sm', variant: value === v ? 'segment-active' : 'segment', onClick: () => {
        pick(v);
        draw(v);
      } });
      b.setAttribute('aria-pressed', value === v ? 'true' : 'false');
      return b;
    }));
  };
  draw(current);
  return h('div', { class: 'person-reason-field ban-length-field' }, h('span', { class: 'field-label', text: 'How long' }), bar);
}

function reasonField(id) {
  const input = h('input', { type: 'text', id, class: 'input person-reason', placeholder: 'Why are they banned?', attrs: { maxlength: String(REASON_MAX), list: `${id}-list`, autocomplete: 'off' } });
  const list = h('datalist', { id: `${id}-list` }, ...REASONS.map((r) => h('option', { value: r })));
  return { input, el: h('div', { class: 'person-reason-field' }, h('label', { class: 'field-label', htmlFor: id, text: 'Reason' }), input, list) };
}

export function openProfilePanel({ api, signal, id, seed = null, role = 'admin', gameName = (g) => g, navigate = null, onHistory = null, onChanged = null }) {
  const ctrl = new AbortController();
  if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', () => ctrl.abort());
  const title = (seed && seed.name) || 'Player';
  const d = drawer({ title, subtitle: 'Party profile', onClose: () => ctrl.abort() });
  let model = null;
  let length = 'forever';

  function failToast(err, what) {
    toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', { tone: 'danger', title: what });
  }

  function changed(evt) {
    if (typeof onChanged === 'function') onChanged(evt);
  }

  async function ban(btn, reasonInput) {
    const p = model.person;
    const ok = await confirmDialog({
      title: `Ban ${p.name} from YapOS Party?`,
      body: `They won't be able to join YapOS Party games in any server, but they can still watch.${p.role === 'admin' ? ' They also stop being a party admin.' : ''} ${length === 'forever' ? 'The ban lasts until someone unbans them.' : `The ban ends by itself after ${durationName(length)}, or sooner if someone unbans them.`}`,
      confirmLabel: 'Ban',
    });
    if (!ok || ctrl.signal.aborted) return;
    setBusy(btn, true, 'Banning');
    try {
      const reason = reasonInput.value.trim().slice(0, REASON_MAX) || 'Reported in YapOS Party';
      const data = await api.post(PERSON_BANS_PATH, { id: p.id, reason, name: p.name || undefined, username: p.username || undefined, ...(length === 'forever' ? {} : { duration: length }) }, { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      toast(length === 'forever' ? `${p.name} is banned from YapOS Party.` : `${p.name} is banned from YapOS Party for ${durationName(length)}.`);
      changed({ type: 'ban', id: p.id, data });
      load();
    } catch (err) {
      if (ctrl.signal.aborted) return;
      if (btn.isConnected) setBusy(btn, false);
      failToast(err, "Couldn't ban them");
    }
  }

  async function unban(btn) {
    const p = model.person;
    const ok = await confirmDialog({ title: `Unban ${p.name}?`, body: 'They can join YapOS Party games again within about a minute.', confirmLabel: 'Unban', tone: 'primary' });
    if (!ok || ctrl.signal.aborted) return;
    setBusy(btn, true, 'Unbanning');
    try {
      const data = await api.request('DELETE', `${PERSON_BANS_PATH}/${encodeURIComponent(p.id)}`, { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      toast(`${p.name} can play YapOS Party again.`);
      changed({ type: 'unban', id: p.id, data });
      load();
    } catch (err) {
      if (ctrl.signal.aborted) return;
      if (btn.isConnected) setBusy(btn, false);
      failToast(err, "Couldn't unban them");
    }
  }

  async function dismissAll(btn) {
    const p = model.person;
    const ok = await confirmDialog({ title: `Dismiss ${model.counts.open === 1 ? 'the open report' : `all ${model.counts.open} open reports`} for ${p.name}?`, body: 'They move to Dismissed and are cleared out after 30 days. Nobody is banned.', confirmLabel: 'Dismiss all', tone: 'primary' });
    if (!ok || ctrl.signal.aborted) return;
    setBusy(btn, true, 'Dismissing');
    try {
      const data = await api.post(`${personUrl(p.id)}/dismiss`, {}, { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      const n = Number(data?.dismissed) || 0;
      toast(n ? `Dismissed ${n} ${n === 1 ? 'report' : 'reports'}.` : 'Nothing was open.');
      changed({ type: 'dismissAll', id: p.id, dismissed: n });
      load();
    } catch (err) {
      if (ctrl.signal.aborted) return;
      if (btn.isConnected) setBusy(btn, false);
      failToast(err, "Couldn't dismiss them");
    }
  }

  function actions() {
    const p = model.person;
    const out = [];
    let reason = null;
    if (canBanPerson(p, model.role)) {
      reason = reasonField(nextId('ban-reason'));
      reason.length = lengthPicker(length, (v) => { length = v; });
      out.push(button({ label: 'Ban from Party', icon: 'ban', variant: 'danger', size: 'sm', ariaLabel: `Ban ${p.name} from YapOS Party`, onClick: (e) => ban(e.currentTarget, reason.input) }));
    }
    if (p.banned) out.push(button({ label: 'Unban', icon: 'check', size: 'sm', ariaLabel: `Unban ${p.name}`, onClick: (e) => unban(e.currentTarget) }));
    if (model.counts.open) out.push(button({ label: `Dismiss ${model.counts.open} open`, icon: 'check', size: 'sm', ariaLabel: `Dismiss all open reports for ${p.name}`, onClick: (e) => dismissAll(e.currentTarget) }));
    if (typeof onHistory === 'function') out.push(button({ label: 'Report history', icon: 'clock', size: 'sm', onClick: () => { d.close(); onHistory(p.id, model); } }));
    const url = profileUrl(model);
    if (url && typeof navigate === 'function') out.push(button({ label: 'View public profile', icon: 'user', size: 'sm', onClick: () => { d.close(); navigate(url); } }));
    const note = !p.banned && p.role === 'admin' && model.role !== 'owner'
      ? h('p', { class: 'report-note', text: 'Only the owner can ban a party admin.' })
      : p.role === 'owner'
      ? h('p', { class: 'report-note', text: 'The owner of YapOS Party cannot be banned.' })
      : null;
    return h('section', { class: 'person-mod', attrs: { 'aria-label': 'Mod actions' } },
      h('h3', { class: 'person-section-title', text: 'Mod actions' }),
      p.banned ? h('p', { class: 'report-note ban-status', text: banStatusText(p.banned) }) : null,
      reason ? reason.el : null,
      reason ? reason.length : null,
      note,
      h('div', { class: 'report-actions person-actions' }, ...out));
  }

  async function sendWarning(text, btn) {
    const value = String(text || '').trim();
    if (!value) return;
    setBusy(btn, true, 'Sending');
    try {
      const data = await api.post(warningsUrl(model.person.id), { text: value }, { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      model.warnings = readWarnings(data?.warnings);
      model.counts.warnings = model.warnings.length;
      toast(`Warning sent. ${model.person.name} sees it the next time they open YapOS Party.`);
      changed({ type: 'warn', id: model.person.id, count: model.warnings.length });
      paint();
    } catch (err) {
      if (ctrl.signal.aborted) return;
      if (btn.isConnected) setBusy(btn, false);
      failToast(err, "Couldn't send the warning");
    }
  }

  function notesDone(data, message) {
    model.notes = readNotes(data?.notes);
    toast(message);
    changed({ type: 'notes', id: model.person.id, count: model.notes.length });
    paint();
  }

  async function addNote(text, btn) {
    const value = String(text || '').trim();
    if (!value) return;
    setBusy(btn, true, 'Saving');
    try {
      const data = await api.post(notesUrl(model.person.id), { text: value }, { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      notesDone(data, 'Note added.');
    } catch (err) {
      if (ctrl.signal.aborted) return;
      if (btn.isConnected) setBusy(btn, false);
      failToast(err, "Couldn't add the note");
    }
  }

  async function deleteNote(n, btn) {
    const ok = await confirmDialog({ title: 'Delete this note?', body: `The note by ${n.author.name} is gone for good.`, confirmLabel: 'Delete' });
    if (!ok || ctrl.signal.aborted) return;
    setBusy(btn, true, 'Deleting');
    try {
      const data = await api.request('DELETE', notesUrl(model.person.id, n.id), { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      notesDone(data, 'Note deleted.');
    } catch (err) {
      if (ctrl.signal.aborted) return;
      if (btn.isConnected) setBusy(btn, false);
      failToast(err, "Couldn't delete the note");
    }
  }

  function paint() {
    d.setTitle(model.person.name);
    replace(d.body, h('div', { class: 'person-panel' },
      personHead(model),
      personStats(model),
      personBadges(model),
      gameCounts(model, gameName),
      actions(),
      notesSection({ model, onAdd: addNote, onDelete: deleteNote }),
      warningsSection({ model, onSend: sendWarning, canSend: model.notes !== null && canWarnPerson(model.person, model.role, state.user?.id || '') }),
      h('section', { class: 'person-history-mini' }, h('h3', { class: 'person-section-title', text: 'Ban history' }), banHistory(model))));
  }

  async function load() {
    replace(d.body, loadingRegion('Loading profile', h('div', { class: 'person-panel' }, skeleton('skeleton-avatar'), skeleton('skeleton-text skeleton-w-60'), skeleton('skeleton-text skeleton-w-40'))));
    try {
      const data = await api.get(personUrl(id), { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      model = readPerson(data);
      if (seed && !model.person.avatar && seed.avatar) model.person.avatar = seed.avatar;
      model.role = role === 'owner' ? 'owner' : model.role;
      paint();
    } catch (err) {
      if (ctrl.signal.aborted) return;
      replace(d.body, errorState({ title: "Couldn't load their profile", body: err instanceof ApiError ? err.message : 'Check your connection and try again.', onRetry: load, compact: true }));
    }
  }

  load();
  return { close: d.close, reload: load, get model() { return model; } };
}
