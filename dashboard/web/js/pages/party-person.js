import { h, replace, nextId } from '../dom.js';
import { avatar, badge, button, confirmDialog, drawer, errorState, loadingRegion, setBusy, skeleton, toast } from '../ui.js';
import { ApiError } from '../api.js';
import { formatDate, relativeTime } from '../format.js';
import { badgeInfo } from '../community-data.js';

export const PERSON_PATH = '/api/party/reports/person/';
export const PERSON_BANS_PATH = '/api/party/bans';
export const REASON_MAX = 200;
export const REASONS = Object.freeze(['Drew something not okay', 'Wrote something not okay', 'Picking on other players', 'Spamming or trolling']);
export const STATUS_FILTERS = Object.freeze([['all', 'All'], ['open', 'Open'], ['dismissed', 'Dismissed']]);
export const KIND_FILTERS = Object.freeze([['all', 'Everything'], ['drawing', 'Drawings'], ['text', 'Text']]);

const str = (v) => (typeof v === 'string' && v ? v : '');
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : null);

export function personUrl(id) {
  return `${PERSON_PATH}${encodeURIComponent(id)}`;
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
      banned: ban ? { reason: str(ban.reason), by: str(ban.by), at: num(ban.at) || 0 } : null,
      card: readCard(p.card),
    },
    counts: {
      total: Number(c.total) || 0,
      open: Number(c.open) || 0,
      first: num(c.first),
      last: num(c.last),
      made: Number(c.made) || 0,
      games: (Array.isArray(c.games) ? c.games : []).filter((g) => g && typeof g.game === 'string').map((g) => ({ game: g.game, n: Number(g.n) || 0, drawings: Number(g.drawings) || 0 })),
    },
    bans: (Array.isArray(data?.bans) ? data.bans : []).filter((b) => b && typeof b === 'object').map((b) => ({ action: b.action === 'unban' ? 'unban' : 'ban', reason: str(b.reason), by: str(b.by), at: num(b.at) || 0 })),
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
    ['First reported', c.first ? `${formatDate(c.first)} (${relativeTime(c.first)})` : 'Never'],
    ['Last reported', c.last ? `${formatDate(c.last)} (${relativeTime(c.last)})` : 'Never'],
    ['Reports they sent', String(c.made)],
  ];
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
  return h('ul', { class: 'person-badges', attrs: { 'aria-label': 'Badges' } }, ...card.badges.map((b) => h('li', { class: 'person-badge', attrs: { title: b.label } }, b.emoji ? h('span', { text: b.emoji, attrs: { 'aria-hidden': 'true' } }) : null, h('span', { text: b.label }))));
}

export function banHistory(model) {
  if (!model.bans.length) return h('p', { class: 'muted person-empty', text: model.person.banned ? 'Banned before ban history was kept.' : 'Never banned from Party.' });
  return h('ol', { class: 'person-bans' }, ...model.bans.map((b) => h('li', { class: ['person-ban', `is-${b.action}`] },
    badge(b.action === 'ban' ? 'Banned' : 'Unbanned', b.action === 'ban' ? 'danger' : 'neutral', b.action === 'ban' ? 'ban' : 'check'),
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
      body: `They won't be able to join YapOS Party games in any server, but they can still watch.${p.role === 'admin' ? ' They also stop being a party admin.' : ''} The ban lasts until someone unbans them.`,
      confirmLabel: 'Ban',
    });
    if (!ok || ctrl.signal.aborted) return;
    setBusy(btn, true, 'Banning');
    try {
      const reason = reasonInput.value.trim().slice(0, REASON_MAX) || 'Reported in YapOS Party';
      const data = await api.post(PERSON_BANS_PATH, { id: p.id, reason, name: p.name || undefined, username: p.username || undefined }, { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      toast(`${p.name} is banned from YapOS Party.`);
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
      p.banned ? h('p', { class: 'report-note', text: `Banned ${relativeTime(p.banned.at)}${p.banned.reason ? `: ${p.banned.reason}` : ''}` }) : null,
      reason ? reason.el : null,
      note,
      h('div', { class: 'report-actions person-actions' }, ...out));
  }

  function paint() {
    d.setTitle(model.person.name);
    replace(d.body, h('div', { class: 'person-panel' },
      personHead(model),
      personStats(model),
      personBadges(model),
      gameCounts(model, gameName),
      actions(),
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
